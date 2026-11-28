import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { AuthStore, MIN_APP_VERSION, PROTOCOL_VERSION } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createGatewayServer } from '../src/server.js';

const master = 'e2e-master-secret';
const cliEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const exec = promisify(execFile);
let requestId = 0;

async function startGateway(t: TestContext, strictRoots = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-pair-e2e-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data');
  const root = join(dir, 'allowed');
  const outside = join(dir, 'outside');
  const staticDir = join(dir, 'ui');
  for (const path of [root, outside, staticDir]) mkdirSync(path);
  symlinkSync(outside, join(root, 'escape'), 'dir');
  writeFileSync(join(staticDir, 'index.html'), '<h1>uniharn</h1>');
  const bin = join(dir, 'devin');
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv[2] === 'acp') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method } = JSON.parse(line);
    if (method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } }));
  });
} else if (process.argv[2] === '--version') {
  console.log('devin mock');
} else if (process.argv[2] === 'auth') {
  console.log('Logged in');
}
`, { mode: 0o755 });
  const flags = ['--data-dir', dataDir, '--host', '127.0.0.1', '--roots', root, '--devin', bin, '--static', staticDir];
  if (strictRoots) flags.push('--strict-roots');
  const env = {
    ...process.env, UNIHARN_TOKEN: master, UNIHARN_STRICT_ROOTS: '0', UNIHARN_PUBLIC_URL: 'https://gateway.example.test',
  };
  const config = loadConfig({
    argv: ['node', 'uniharn', 'gateway', ...flags, '--port', '0'],
    env,
    detectTailscale: () => '100.64.0.3',
    detectMagicDns: () => 'gateway.test.ts.net',
  });
  const server = createGatewayServer(config);
  t.after(() => server.close());
  const [{ port }] = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const cli = async (...args: string[]) => (await exec(process.execPath,
    ['--import', 'tsx', cliEntry, ...args, ...flags, '--port', String(port)], { env, timeout: 8000 })).stdout;
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(ws, 'open');
    return ws;
  };
  return { base, open, cli, root, outside, dataDir, config };
}

function nextMessage(ws: WebSocket, predicate: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for a WebSocket message'));
    }, 3000);
    function onMessage(raw: Buffer) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

function rpc(ws: WebSocket, type: string, params: Record<string, unknown> = {}) {
  const id = ++requestId;
  const response = nextMessage(ws, (message) => message.type === 'response' && message.id === id);
  ws.send(JSON.stringify({ id, type, ...params }));
  return response;
}

async function ok(ws: WebSocket, type: string, params?: Record<string, unknown>) {
  const response = await rpc(ws, type, params);
  assert.equal(response.ok, true, response.error);
  return response.result;
}

function postPair(base: string, code: string, origin?: string) {
  return fetch(base + '/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ code, deviceName: 'Phone', platform: 'iOS' }),
  });
}

async function assertRejectedHello(ws: WebSocket, token: string, error: string, closeReason = 'invalid token') {
  const closed = once(ws, 'close');
  const reply = await rpc(ws, 'hello', { token });
  assert.equal(reply.ok, false);
  assert.equal(reply.error, error);
  const [code, reason] = await closed;
  assert.equal(code, 4003);
  assert.equal(reason.toString(), closeReason);
  return reply;
}

async function assertRevoked(ws: WebSocket, deviceId: string, action: () => Promise<void>) {
  const revoked = nextMessage(ws, (message) => message.type === 'device_revoked');
  const closed = once(ws, 'close');
  await action();
  assert.deepEqual(await revoked, { type: 'device_revoked', deviceId, reason: 'Device token has been revoked' });
  const [code, reason] = await closed;
  assert.equal(code, 4003);
  assert.equal(reason.toString(), 'device revoked');
}

test('HTTP and WebSocket pairing use CLI codes, retain legacy hello fields, and support device management', { timeout: 15_000 }, async (t) => {
  const { base, open, cli, dataDir, root } = await startGateway(t);
  const health = await fetch(base + '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const gateway = await health.json();
  assert.equal(gateway.ok, true);
  assert.equal(gateway.name, 'uniharn');
  assert.equal(gateway.version, '0.4.6');
  assert.match(String(gateway.build), /^\d+$/);
  assert.ok(!Number.isNaN(Date.parse(gateway.startedAt)));
  assert.equal(gateway.protocolVersion, PROTOCOL_VERSION);
  assert.equal(gateway.minAppVersion, MIN_APP_VERSION);
  assert.equal(gateway.tailscaleIp, '100.64.0.3');
  assert.equal(gateway.magicDns, 'gateway.test.ts.net');
  assert.equal(gateway.gatewayId, new AuthStore(dataDir).gatewayId);
  assert.equal((await fetch(base)).headers.get('x-frame-options'), 'DENY');

  const cliCode = JSON.parse(await cli('pair', '--ttl', '75', '--url', base, '--json'));
  assert.equal(cliCode.pairingUri, `${base}/#pair=${cliCode.code}`);
  assert.ok(!JSON.stringify(cliCode).includes(master));
  const preflight = await fetch(base + '/api/pair', {
    method: 'OPTIONS',
    headers: { Origin: 'tauri://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'tauri://localhost');
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.equal((await postPair(base, cliCode.code, 'https://unrelated.example')).status, 403);
  const paired = await postPair(base, cliCode.code.toLowerCase(), 'https://tauri.localhost');
  assert.equal(paired.status, 200);
  assert.equal(paired.headers.get('access-control-allow-origin'), 'https://tauri.localhost');
  assert.equal(paired.headers.get('cache-control'), 'no-store');
  assert.equal(paired.headers.get('referrer-policy'), 'no-referrer');
  const first = await paired.json();
  assert.equal(first.ok, true);
  assert.equal(first.gatewayId, gateway.gatewayId);
  assert.equal(first.protocolVersion, PROTOCOL_VERSION);
  assert.equal(first.minAppVersion, MIN_APP_VERSION);
  assert.equal(first.deviceId, first.device.deviceId);
  assert.equal(first.device.name, 'Phone');
  assert.equal(first.device.lastIp, '127.0.0.1');
  assert.ok(!('tokenHash' in first.device));
  const replay = await postPair(base, cliCode.code);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, 'Pairing code has already been used');

  const phone = await open();
  assert.equal((await rpc(phone, 'ping')).error, 'Not authenticated');
  const hello = await ok(phone, 'hello', { token: first.token });
  assert.equal(hello.gatewayId, gateway.gatewayId);
  assert.equal(hello.deviceId, first.deviceId);
  assert.equal(hello.authKind, 'device');
  assert.deepEqual(hello.security, {
    isRoot: process.getuid?.() === 0, strictRoots: true, publicBindWarning: false,
    tailscaleIp: '100.64.0.3', magicDns: 'gateway.test.ts.net',
  });
  for (const field of ['home', 'agent', 'harnesses', 'workspaces', 'sessions', 'terminals', 'tasks']) assert.ok(field in hello);
  assert.equal((await ok(phone, 'workspaces.create', { cwd: root })).workspace.cwd, root);
  assert.ok((await ok(phone, 'devices.list')).devices[0].current);
  assert.equal((await ok(phone, 'devices.rename', { deviceId: first.deviceId, name: 'Renamed phone' })).device.name, 'Renamed phone');

  const pending = await ok(phone, 'pairing.create', { ttlSec: 50 });
  assert.match(pending.qrSvg, /^<svg\b/);
  assert.equal(pending.pairingUri, `https://gateway.example.test/#pair=${pending.code}`);
  const { codes } = await ok(phone, 'pairing.list');
  assert.equal(codes[0].codeId, pending.codeId);
  assert.ok(!('code' in codes[0]) && !('codeHash' in codes[0]));
  const tablet = await open();
  const second = await ok(tablet, 'pair', { code: pending.code, deviceName: 'Tablet', platform: 'android' });
  assert.equal(second.gatewayId, gateway.gatewayId);
  assert.equal(second.device.name, 'Tablet');
  assert.ok((await ok(tablet, 'ping')).now > 0);
  assert.equal((await rpc(tablet, 'pair', { code: pending.code })).error, 'Pairing code has already been used');
  const revocable = await ok(phone, 'pairing.create');
  assert.deepEqual(await ok(phone, 'pairing.revoke', { codeId: revocable.codeId }), { revoked: true });
  assert.equal((await rpc(tablet, 'pair', { code: revocable.code })).error, 'Invalid pairing code');

  const diagnostics = await ok(phone, 'gateway.diagnostics');
  assert.equal(diagnostics.pairedDeviceCount, 2);
  assert.equal(diagnostics.activeDeviceCount, 2);
  assert.equal(diagnostics.port, Number(new URL(base).port));
  assert.equal(diagnostics.suggestedUrls[0], 'https://gateway.example.test');
  const status = JSON.parse(await cli('status', '--json'));
  assert.equal(status.gatewayAuth, 'authenticated');
  assert.equal(status.activeDeviceCount, 2);
  assert.equal(status.portReachability[0].reachable, true);
  assert.equal(status.harnesses[0].authStatus, 'authenticated');
  assert.ok(!JSON.stringify(status).includes(master));
});

test('device rotation changes the accepted token and RPC and CLI revocations close live sockets', { timeout: 15_000 }, async (t) => {
  const { base, open, cli, dataDir } = await startGateway(t);
  const auth = new AuthStore(dataDir);
  const admin = await open();
  const adminHello = await ok(admin, 'hello', { token: master });
  assert.equal(adminHello.deviceId, null);
  assert.equal(adminHello.authKind, 'master');
  assert.match((await rpc(admin, 'devices.rotate')).error, /Master token cannot be rotated/);

  const code = await auth.createPairingCode();
  const phone = await open();
  const first = await ok(phone, 'pair', { code: code.code });
  const rotated = await ok(phone, 'devices.rotate');
  assert.equal(rotated.device.deviceId, first.deviceId);
  assert.notEqual(rotated.token, first.token);
  await assertRejectedHello(await open(), first.token, 'Invalid token');
  const phoneAgain = await open();
  assert.equal((await ok(phoneAgain, 'hello', { token: rotated.token })).deviceId, first.deviceId);
  await assertRevoked(phone, first.deviceId, () => assertRevoked(phoneAgain, first.deviceId, async () => {
    const result = await ok(admin, 'devices.revoke', { deviceId: first.deviceId });
    assert.equal(result.disconnected, 2);
    assert.ok(result.device.revokedAt);
  }));
  await assertRejectedHello(await open(), rotated.token, 'Device token has been revoked', 'device revoked');

  const linked = await postPair(base, (await auth.createPairingCode()).code);
  const second = await linked.json();
  const tablet = await open();
  await ok(tablet, 'hello', { token: second.token });
  await assertRevoked(tablet, second.deviceId, async () => {
    assert.match(await cli('devices', 'revoke', second.deviceId), /Revoked dev_/);
  });
  await assertRejectedHello(await open(), second.token, 'Device token has been revoked', 'device revoked');
  const list = JSON.parse(await cli('devices', 'list', '--json'));
  assert.ok(list.devices.every((device: { revokedAt: number | null }) => device.revokedAt !== null));

  const self = await open();
  const third = await ok(self, 'pair', { code: (await auth.createPairingCode()).code });
  await assertRevoked(self, third.deviceId, async () => {
    assert.equal((await ok(self, 'devices.revoke', { deviceId: third.deviceId })).disconnected, 1);
  });
});

test('pairing rejects expired and oversized requests and throttles both transports by peer IP', { timeout: 10_000 }, async (t) => {
  const { base, open, dataDir } = await startGateway(t);
  const auth = new AuthStore(dataDir);
  const expired = await auth.createPairingCode();
  const valid = await auth.createPairingCode();
  const path = join(dataDir, 'pairing.json');
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  rows.find((row: { codeId: string }) => row.codeId === expired.codeId).expiresAt = Date.now() - 1;
  writeFileSync(path + '.test', JSON.stringify(rows), { mode: 0o600 });
  renameSync(path + '.test', path);
  const stale = await postPair(base, expired.code);
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error, 'Pairing code has expired');

  const malformed = await fetch(base + '/api/pair', { method: 'POST', body: '[]' });
  assert.equal(malformed.status, 400);
  const tooLarge = await fetch(base + '/api/pair', { method: 'POST', body: 'x'.repeat(8193) });
  assert.equal(tooLarge.status, 413);
  await tooLarge.text();
  const chunkedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(base + '/api/pair', { method: 'POST' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write('x'.repeat(4096));
    req.end('x'.repeat(4097));
  });
  assert.equal(chunkedStatus, 413);

  const socket = await open();
  for (let i = 0; i < 5; i++) {
    const reply = await rpc(socket, 'pair', { code: 'bad' });
    assert.equal(reply.error, 'Invalid pairing code');
  }
  for (let i = 0; i < 4; i++) {
    const reply = await fetch(base + '/api/pair', {
      method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` }, body: JSON.stringify({ code: 'bad' }),
    });
    assert.equal(reply.status, 401);
    assert.equal((await reply.json()).error, 'Invalid pairing code');
  }
  const blocked = await postPair(base, valid.code);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  await blocked.json();
  const blockedWs = await rpc(socket, 'pair', { code: valid.code });
  assert.match(blockedWs.error, /Too many attempts/);
  assert.ok(blockedWs.retryAfterMs > 0);
  assert.ok(auth.listPairingCodes().some(({ codeId }) => codeId === valid.codeId));

  for (let i = 0; i < 10; i++) await assertRejectedHello(await open(), 'wrong', 'Invalid token');
  const helloBlocked = await assertRejectedHello(await open(), master, 'Too many attempts; try again later');
  assert.ok(helloBlocked.retryAfterMs > 0);
});

test('strict roots gate all cwd entry points and discovery mode still allows browsing outside roots', { timeout: 10_000 }, async (t) => {
  const strict = await startGateway(t);
  const ws = await strict.open();
  await ok(ws, 'hello', { token: master });
  assert.equal((await ok(ws, 'fs.listDirs', { path: strict.root })).path, strict.root);
  for (const [type, params] of [
    ['fs.listDirs', { path: strict.outside }],
    ['session.create', { cwd: strict.outside }],
    ['workspaces.create', { cwd: strict.outside }],
    ['git.status', { cwd: strict.outside }],
    ['git.diff', { cwd: strict.outside }],
    ['git.log', { cwd: strict.outside }],
    ['tasks.detect', { cwd: strict.outside }],
    ['tasks.run', { cwd: strict.outside, command: 'echo blocked' }],
    ['term.open', { cwd: strict.outside }],
    ['fs.listDirs', { path: join(strict.root, 'escape') }],
    ['workspaces.create', { cwd: join(strict.root, 'escape', 'future') }],
  ] as const) {
    assert.equal((await rpc(ws, type, params)).error, 'Path is outside allowed roots', type);
  }
  // Git resolves a worktree root from the supplied cwd before reading repository data.
  await exec('git', ['init', '-q', join(strict.root, '..')]);
  for (const type of ['git.status', 'git.diff', 'git.log']) {
    assert.equal((await rpc(ws, type, { cwd: strict.root })).error, 'Path is outside allowed roots', type);
  }
  const term = await ok(ws, 'term.open', { cwd: '~', cols: 80, rows: 24 });
  assert.equal(term.term.cwd, join(strict.dataDir, 'scratch'));
  await ok(ws, 'term.close', { termId: term.term.termId });
  const spaced = join(strict.root, 'proj ');
  mkdirSync(spaced);
  const spacedTerm = await ok(ws, 'term.open', { cwd: spaced, cols: 80, rows: 24 });
  assert.equal(spacedTerm.term.cwd, spaced);
  await ok(ws, 'term.close', { termId: spacedTerm.term.termId });
  const discovery = await startGateway(t, false);
  const other = await discovery.open();
  await ok(other, 'hello', { token: master });
  assert.equal((await ok(other, 'fs.listDirs', { path: discovery.outside })).path, discovery.outside);
});

test('usage RPC replies and operations broadcasts carry the same report', { timeout: 15_000 }, async (t) => {
  const { open, config } = await startGateway(t);
  writeFileSync(config.devinBin, `#!/usr/bin/env node
if (process.argv[2] === '--version') console.log('devin mock');
else if (process.argv[2] === 'auth') console.log('Not logged in');
else if (process.argv[2] === 'acp') require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } }));
});
`, { mode: 0o755 });
  const ws = await open();
  const observer = await open();
  t.after(() => { ws.terminate(); observer.terminate(); });
  await ok(ws, 'hello', { token: master });
  await ok(observer, 'hello', { token: master });
  const listed = await ok(ws, 'usage.list');
  assert.deepEqual(Object.keys(listed), ['usage']);
  assert.ok(listed.usage.harnesses.some((h: any) => h.harnessId === 'devin'));
  assert.ok(listed.usage.officialError);
  const pushed = nextMessage(observer, (m) => m.type === 'operations');
  const updated = await ok(ws, 'usage.update', { harnessId: 'devin', manual: { note: 'from RPC', usagePercent: 12 } });
  assert.deepEqual(Object.keys(updated), ['usage']);
  assert.deepEqual((await pushed).usage, updated.usage);
  assert.equal(updated.usage.harnesses.find((h: any) => h.harnessId === 'devin').manual.note, 'from RPC');
  const bad = await rpc(ws, 'usage.update', { harnessId: 'devin', manual: { usagePercent: 101 } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /usagePercent/);
  assert.equal((await ok(ws, 'usage.update', { harnessId: 'devin', reset: true })).usage.harnesses.find((h: any) => h.harnessId === 'devin').manual, null);
  assert.equal((await rpc(ws, 'usage.list', { refresh: 'yes' })).ok, false);
});

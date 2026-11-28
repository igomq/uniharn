import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createGatewayServer } from '../src/server.js';

const master = 'scratch-master-secret';
let requestId = 0;

async function startGateway(t: TestContext, strictRoots: boolean) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-scratch-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data');
  const root = join(dir, 'allowed');
  mkdirSync(root);
  const bin = join(dir, 'devin');
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv[2] === 'acp') {
  let n = 0;
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method } = JSON.parse(line);
    if (method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } }));
    else if (method === 'session/new') console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess-' + ++n } }));
    else if (id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
  });
} else if (process.argv[2] === '--version') {
  console.log('devin mock');
} else if (process.argv[2] === 'auth') {
  console.log('Logged in');
}
`, { mode: 0o755 });
  const argv = ['node', 'uniharn', 'gateway', '--data-dir', dataDir, '--host', '127.0.0.1', '--roots', root, '--devin', bin, '--port', '0'];
  if (strictRoots) argv.push('--strict-roots');
  const config = loadConfig({ argv, env: { ...process.env, UNIHARN_TOKEN: master, UNIHARN_STRICT_ROOTS: '0' } });
  const server = createGatewayServer(config);
  t.after(() => server.close());
  const [{ port }] = await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(ws, 'open');
  t.after(() => ws.close());
  return { ws, dataDir, root };
}

function rpc(ws: WebSocket, type: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5000);
    ws.on('message', function onMessage(raw: Buffer) {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'response' || message.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    });
    ws.send(JSON.stringify({ id, type, ...params }));
  });
}

async function ok(ws: WebSocket, type: string, params?: Record<string, unknown>) {
  const response = await rpc(ws, type, params);
  assert.equal(response.ok, true, response.error);
  return response.result;
}

for (const strictRoots of [false, true]) {
  test(`session.create with noProject starts in a fresh scratch folder (strictRoots ${strictRoots})`, { timeout: 15_000 }, async (t) => {
    const { ws, dataDir, root } = await startGateway(t, strictRoots);
    const scratchDir = join(dataDir, 'scratch');
    const hello = await ok(ws, 'hello', { token: master });
    assert.equal(hello.scratchDir, scratchDir);

    const first = await ok(ws, 'session.create', { noProject: true });
    assert.equal(dirname(first.session.cwd), scratchDir);
    assert.match(first.session.cwd, /\/\d{8}-\d{6}-[0-9a-f]{6}$/);
    assert.ok(statSync(first.session.cwd).isDirectory());
    assert.equal(first.workspaceId, null);

    // A missing cwd is treated the same way, and each session gets its own folder.
    const second = await ok(ws, 'session.create', {});
    assert.equal(dirname(second.session.cwd), scratchDir);
    assert.notEqual(second.session.cwd, first.session.cwd);
    assert.equal(readdirSync(scratchDir).length, 2);

    const opened = await ok(ws, 'session.open', { sessionId: first.session.sessionId });
    assert.equal(opened.session.cwd, first.session.cwd);
    const projects = await ok(ws, 'projects.list');
    assert.ok(!projects.projects.some((p: { path: string }) => p.path.startsWith(scratchDir)));
    const workspaces = await ok(ws, 'workspaces.list');
    assert.equal(workspaces.workspaces.length, 0);

    // Project sessions keep their root check.
    await ok(ws, 'session.create', { cwd: root });
    if (strictRoots) {
      const rejected = await rpc(ws, 'session.create', { cwd: dataDir });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error, 'Path is outside allowed roots');
    }
  });
}

test('profile and team RPCs validate paths and start project sessions', { timeout: 15000 }, async (t) => {
  const { ws, root, dataDir } = await startGateway(t, true);
  await ok(ws, 'hello', { token: master });
  const { profile } = await ok(ws, 'profiles.create', { profile: { name: 'Project', cwd: root, harnessId: 'devin', prelude: 'project instruction', commonCommands: ['npm test'] } });
  assert.equal((await ok(ws, 'profiles.list')).profiles[0].id, profile.id);
  const denied = await rpc(ws, 'profiles.update', { profileId: profile.id, patch: { cwd: dataDir } });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /outside allowed roots/);
  const created = await ok(ws, 'session.create', { profileId: profile.id });
  assert.equal(created.session.cwd, root);
  const { team } = await ok(ws, 'teams.create', { team: { name: 'Team', cwd: root, profileId: profile.id, roles: [{ name: 'Worker', harnessId: 'devin', instruction: 'Inspect' }] } });
  assert.equal((await ok(ws, 'teams.list')).teams[0].id, team.id);
  const outside = await rpc(ws, 'teams.start', { teamId: team.id, task: 'inspect', cwd: dataDir });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /outside allowed roots/);
  const started = await ok(ws, 'teams.start', { teamId: team.id, task: 'inspect' });
  assert.equal(started.links.length, 1);
  let status = started.links[0].status;
  for (let i = 0; status === 'running' && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (await ok(ws, 'orchestration.get', { taskId: started.links[0].id })).link.status;
  }
  assert.equal(status, 'done');
  assert.equal((await ok(ws, 'teams.delete', { teamId: team.id })).deleted, true);
  assert.equal((await ok(ws, 'profiles.delete', { profileId: profile.id })).deleted, true);
});

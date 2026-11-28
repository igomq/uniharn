import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGatewayServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Scheduler } from '../src/scheduler.js';
import { createSchedulerRpc, gatewaySchedulerOptions } from '../src/scheduler-rpc.js';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { Orchestrator } from '../src/orchestrator.js';
import { launchProfile, ProfileStore, TeamStore } from '../src/presets.js';
import { WorkspaceStore } from '../src/workspaces.js';

const input = (extra = {}) => ({ title: 'Task', sessionId: 'codex:s1', steps: [{ prompt: 'Do work' }], schedule: { type: 'manual' }, ...extra });
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); }
};
const fixture = () => mkdtempSync(join(tmpdir(), 'scheduler-'));

test('RPC, dependency validation, failure blocking and manual release', async () => {
  const dir = fixture(); const calls: string[] = [];
  const rpc = createSchedulerRpc(dir, { checkTarget: () => {}, executor: async t => { calls.push(t.title); if (t.title === 'bad') throw Error('bad'); } });
  try {
    rpc.start();
    assert.equal(rpc.handle('other', {}), undefined);
    const a = (await rpc.handle('scheduler.create', input({ title: 'bad', schedule: { type: 'immediate' } })))!.task;
    const b = (await rpc.handle('scheduler.create', input({ title: 'dependent', dependencyIds: [a.id] })))!.task;
    await assert.rejects(rpc.handle('scheduler.update', { id: a.id, dependencyIds: [b.id] })!, /cycle/);
    await assert.rejects(rpc.handle('scheduler.create', input({ dependencyIds: ['missing'] }))!, /dependency/);
    await assert.rejects(rpc.handle('scheduler.delete', { id: a.id })!, /required/);
    await rpc.handle('scheduler.release', { id: b.id });
    await wait(() => rpc.scheduler.get(a.id).status === 'failed' && rpc.scheduler.get(b.id).condition === 'dependency_failed');
    assert.deepEqual(calls, ['bad']);
    assert.equal((await rpc.handle('scheduler.list', {}))!.tasks.length, 2);
    assert.equal((await rpc.handle('scheduler.cancel', { id: b.id }))!.task.status, 'canceled');
    await rpc.handle('scheduler.delete', { id: b.id });
    assert.equal((await rpc.handle('scheduler.delete', { id: a.id }))!.task.id, a.id);
  } finally { rpc.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('chains run after success, confirmation, bounded retry and persistence', async () => {
  const dir = fixture(); let attempts = 0; const calls: string[] = [];
  const opts = { checkTarget: () => {}, executor: async (task: any) => { calls.push(task.title); if (task.title === 'first' && ++attempts === 1) throw Error('temporary'); } };
  const s = new Scheduler(dir, opts);
  try {
    const first = await s.create(input({ title: 'first', maxAttempts: 2, retryDelayMs: 5, schedule: { type: 'delay', delayMs: 10 } }));
    const next = await s.create(input({ title: 'next', dependencyIds: [first.id], schedule: { type: 'immediate' }, steps: [{ prompt: 'initial' }, { prompt: 'check', requiresConfirmation: true }] }));
    s.start(); await wait(() => s.get(next.id).condition === 'awaiting_confirmation');
    assert.equal(s.get(first.id).status, 'done'); assert.equal(attempts, 2);
    await assert.rejects(s.update(next.id, { title: 'changed' }), /not started/);
    s.confirm(next.id); await wait(() => s.get(next.id).status === 'done');
    assert.deepEqual(calls, ['first', 'first', 'next', 'next']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'scheduler.json'), 'utf8')).length, 2);
    s.close(); const restored = new Scheduler(dir, opts); assert.equal(restored.get(next.id).status, 'done'); restored.close();
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('running cancellation and shutdown interrupt without replaying work', async () => {
  const dir = fixture(); let release!: () => void; let signal!: AbortSignal;
  const opts = { checkTarget: () => {}, executor: async (_t: any, _step: any, s: AbortSignal) => { signal = s; await new Promise<void>(r => { release = r; }); } };
  const s = new Scheduler(dir, opts);
  try {
    s.start(); const one = await s.create(input({ schedule: { type: 'immediate' } }));
    await wait(() => !!release); s.cancel(one.id); assert.equal(signal.aborted, true); assert.throws(() => s.delete(one.id), /running/);
    release(); await wait(() => { try { s.delete(one.id); return true; } catch { return false; } });
    release = undefined as any;
    const two = await s.create(input({ schedule: { type: 'immediate' } })); await wait(() => !!release);
    s.close(); assert.equal(s.get(two.id).condition, 'interrupted'); release();
    const restored = new Scheduler(dir, opts); restored.start();
    await new Promise(r => setTimeout(r, 25)); assert.equal(restored.get(two.id).condition, 'interrupted'); restored.close();
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

function mockAgent(dir: string) {
  const bin = join(dir, 'agent.cjs');
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv[2] === '--version' || process.argv[2] === 'auth') { console.log('mock'); process.exit(0); }
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const file = __dirname + '/agent-sessions.json';
const known = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const models = {};
const held = {};
const out = x => console.log(JSON.stringify({jsonrpc:'2.0', ...x}));
const options = id => [
  { id:'model', category:'model', currentValue:models[id] ?? 'base', options:[{value:'base'},{value:'main'},{value:'child'}] },
];
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  const p = m.params ?? {};
  const result = result => out({id:m.id,result});
  if (m.method === 'initialize') result({protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{}}}});
  if (m.method === 'session/list') result({sessions:Object.entries(known).map(([sessionId,cwd])=>({sessionId,cwd}))});
  if (m.method === 'session/new') {
    const id = randomUUID(); known[id] = p.cwd; fs.writeFileSync(file,JSON.stringify(known));
    result({sessionId:id,configOptions:options(id)});
  }
  if (m.method === 'session/load') {
    if (known[p.sessionId] !== p.cwd) out({id:m.id,error:{code:-32602,message:'Wrong folder'}});
    else result({configOptions:options(p.sessionId)});
  }
  if (m.method === 'session/set_config_option') { models[p.sessionId] = p.value; result({configOptions:options(p.sessionId)}); }
  if (m.method === 'session/prompt') {
    const text = p.prompt[0].text;
    out({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
    if (text.endsWith('hold')) held[p.sessionId] = m.id;
    else result({stopReason:text.endsWith('refuse') ? 'refusal' : 'end_turn'});
  }
  if (m.method === 'session/cancel' && held[p.sessionId] !== undefined) {
    out({id:held[p.sessionId],result:{stopReason:'cancelled'}});
    delete held[p.sessionId];
  }
  if (m.method === 'session/delete' || m.method === 'session/unload') result({});
});
`, { mode: 0o755 });
  return bin;
}

function schedulerGateway(dir: string, bin: string, checkPath = (path: string) => path) {
  const dataDir = join(dir, 'data');
  const registry = new HarnessRegistry(dataDir);
  const adapter = new AcpHarnessAdapter({ id: 'fake', name: 'Fake', bin, acpArgs: [] });
  registry.register(adapter);
  const workspaces = new WorkspaceStore(dataDir);
  const profiles = new ProfileStore(dataDir, checkPath);
  const teams = new TeamStore(dataDir, checkPath);
  const orchestrator = new Orchestrator(registry, dataDir);
  const events: { id: string; event: string }[] = [];
  const options = gatewaySchedulerOptions(registry, workspaces, checkPath, (task, event) => { events.push({ id: task.id, event }); }, { profiles, teams, orchestrator });
  const scheduler = new Scheduler(dataDir, options);
  const close = () => { scheduler.close(); adapter.stop(); };
  return { registry, adapter, workspaces, profiles, teams, orchestrator, scheduler, events, close };
}

test('an existing busy target defers without burning retries and its scheduled turn uses the profile only once', async () => {
  const dir = fixture();
  const gateway = schedulerGateway(dir, mockAgent(dir));
  try {
    const { registry, adapter, profiles, scheduler, events } = gateway;
    const profile = profiles.create({ name: 'Profile', cwd: dir, harnessId: 'fake', model: 'main', prelude: 'project rules' });
    const session = await registry.createSession('fake', dir);
    await adapter.prompt(session.sessionId, 'manual hold');
    const task = await scheduler.create(input({ sessionId: `fake:${session.sessionId}`, profile: profile.id, schedule: { type: 'immediate' } }));
    scheduler.start();
    await wait(() => scheduler.get(task.id).logs.some(l => l.event === 'target_busy'));
    assert.equal(scheduler.get(task.id).attempts, 0);
    assert.equal(scheduler.get(task.id).status, 'scheduled');
    await adapter.cancel(session.sessionId);
    await wait(() => scheduler.get(task.id).status === 'done');
    assert.equal(session.configOptions[0].currentValue, 'main');
    const prompts = session.events.filter(e => e.update.sessionUpdate === 'user_message_chunk').map(e => e.update.content.text);
    assert.deepEqual(prompts, ['manual hold', 'project rules\n\nDo work']);
    assert.equal(events.at(-1)?.event, 'completed');
    assert.equal(await adapter.releaseIdle(() => false, 0), 1);
    assert.equal(session.loaded, false);

    const fresh = await launchProfile(registry, profile, x => x);
    const failed = await scheduler.create(input({ sessionId: `fake:${fresh.sessionId}`, profile: profile.id, steps: [{ prompt: 'refuse' }], schedule: { type: 'immediate' } }));
    await wait(() => scheduler.get(failed.id).status === 'failed');
    assert.equal(fresh.events.find(e => e.update.sessionUpdate === 'user_message_chunk')?.update.content.text, 'project rules\n\nrefuse');
    assert.match(scheduler.get(failed.id).logs.at(-1)?.message ?? '', /refusal/);
    assert.equal(events.at(-1)?.event, 'failed');
    const idle = await scheduler.create(input({ sessionId: `fake:${session.sessionId}`, schedule: { type: 'immediate' } }));
    await wait(() => scheduler.get(idle.id).status === 'done');
    assert.equal(session.loaded, true);
  } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a partial team launch cancels the started role, records the failed role and skips the configured retry', async () => {
  const dir = fixture();
  const gateway = schedulerGateway(dir, mockAgent(dir));
  try {
    const { registry, teams, orchestrator, scheduler } = gateway;
    const parent = await registry.createSession('fake', dir);
    const team = teams.create({ name: 'Team', cwd: dir, roles: [
      { name: 'Started', harnessId: 'fake' },
      { name: 'Bad model', harnessId: 'fake', model: 'unavailable' },
    ] });
    const task = await scheduler.create(input({ sessionId: `fake:${parent.sessionId}`, team: team.id, steps: [{ prompt: 'hold' }], maxAttempts: 3, retryDelayMs: 0, schedule: { type: 'immediate' } }));
    scheduler.start();
    await wait(() => scheduler.get(task.id).status === 'failed');
    const failed = scheduler.get(task.id);
    assert.equal(failed.attempts, 1);
    const [link] = orchestrator.list();
    assert.equal(orchestrator.list().length, 1);
    assert.equal(link.stopReason, 'cancelled');
    assert.equal(link.cancelled, true);
    assert.match(failed.logs.at(-1)?.message ?? '', /Bad model.*unavailable/);
    assert.ok(failed.logs.some(l => l.event === 'role_started' && l.message?.includes(link.id)));
  } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a failed team role makes the step fail and names its terminal stop reason', async () => {
  const dir = fixture();
  const gateway = schedulerGateway(dir, mockAgent(dir));
  try {
    const { registry, teams, orchestrator, scheduler } = gateway;
    const parent = await registry.createSession('fake', dir);
    const team = teams.create({ name: 'Team', cwd: dir, roles: [{ name: 'Reviewer', harnessId: 'fake' }] });
    const task = await scheduler.create(input({ sessionId: `fake:${parent.sessionId}`, team: team.id, steps: [{ prompt: 'refuse' }], maxAttempts: 3, schedule: { type: 'immediate' } }));
    scheduler.start();
    await wait(() => scheduler.get(task.id).status === 'failed');
    assert.equal(scheduler.get(task.id).attempts, 1);
    assert.equal(orchestrator.list()[0]?.status, 'error');
    assert.ok(scheduler.get(task.id).logs.some(l => l.event === 'role_failed' && /Reviewer.*refusal/.test(l.message ?? '')));
  } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('canceling a scheduled team drains its role and nested delegation before releasing the task', async () => {
  const dir = fixture();
  const gateway = schedulerGateway(dir, mockAgent(dir));
  try {
    const { registry, teams, orchestrator, scheduler } = gateway;
    const parent = await registry.createSession('fake', dir);
    const team = teams.create({ name: 'Team', cwd: dir, roles: [{ name: 'Lead', harnessId: 'fake' }] });
    const task = await scheduler.create(input({ sessionId: `fake:${parent.sessionId}`, team: team.id, steps: [{ prompt: 'hold' }], schedule: { type: 'immediate' } }));
    scheduler.start();
    await wait(() => orchestrator.list().length === 1);
    const root = orchestrator.list()[0];
    const nested = await orchestrator.delegate(root.childSessionId, 'fake', 'hold');
    scheduler.cancel(task.id);
    await nested.done;
    await wait(() => { try { scheduler.delete(task.id); return true; } catch { return false; } });
    assert.equal(root.stopReason, 'cancelled');
    assert.equal(nested.link.stopReason, 'cancelled');
    assert.equal(root.cancelled, true);
    assert.equal(nested.link.cancelled, true);
  } finally { gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('confirmation and its retry survive restart without asking twice', async () => {
  const dir = fixture();
  let calls = 0;
  const opts = { checkTarget: () => {}, executor: async () => { if (++calls === 1) throw new Error('temporary'); } };
  const original = new Scheduler(dir, opts);
  let restored: Scheduler | undefined;
  try {
    const task = await original.create(input({ steps: [{ prompt: 'approve', requiresConfirmation: true }], maxAttempts: 2, retryDelayMs: 0, schedule: { type: 'immediate' } }));
    original.start();
    await wait(() => original.get(task.id).condition === 'awaiting_confirmation');
    original.confirm(task.id);
    original.close();
    restored = new Scheduler(dir, opts);
    restored.start();
    await wait(() => restored!.get(task.id).status === 'done');
    assert.equal(calls, 2);
    assert.equal(restored.get(task.id).logs.filter(l => l.event === 'awaiting_confirmation').length, 1);
  } finally { original.close(); restored?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a restored unscoped task reloads its checked folder and revalidates current roots before submitting', async () => {
  const dir = fixture();
  const bin = mockAgent(dir);
  const first = schedulerGateway(dir, bin);
  let restored: ReturnType<typeof schedulerGateway> | undefined;
  let denied: ReturnType<typeof schedulerGateway> | undefined;
  try {
    const session = await first.registry.createSession('fake', dir);
    const sessionId = `fake:${session.sessionId}`;
    const runnable = await first.scheduler.create(input({ sessionId }));
    const blocked = await first.scheduler.create(input({ sessionId }));
    assert.equal(runnable.targetCwd, dir);
    first.close();
    restored = schedulerGateway(dir, bin);
    restored.scheduler.start();
    restored.scheduler.release(runnable.id);
    await wait(() => restored!.scheduler.get(runnable.id).status === 'done');
    restored.close();
    denied = schedulerGateway(dir, bin, () => { throw new Error('Outside current roots'); });
    denied.scheduler.start();
    denied.scheduler.release(blocked.id);
    await wait(() => denied!.scheduler.get(blocked.id).status === 'failed');
    assert.match(denied.scheduler.get(blocked.id).logs.at(-1)?.message ?? '', /Outside current roots/);
    assert.equal(denied.adapter.sessionCwd(session.sessionId), undefined);
  } finally { first.close(); restored?.close(); denied?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('authenticated scheduler RPCs enforce roots and report one terminal queue notification', { timeout: 10000 }, async () => {
  const dir = fixture(); const bin = mockAgent(dir);
  const root = join(dir, 'allowed'); const other = join(root, 'other'); const outside = join(dir, 'outside');
  for (const path of [root, other, outside]) mkdirSync(path);
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ 'outside-session': outside }));
  const dataDir = join(dir, 'data'); const seed = new Scheduler(dataDir, { checkTarget: () => {}, executor: async () => {} });
  const task = await seed.create(input()); seed.close();
  const config = loadConfig({ argv: ['node', 'uniharn', 'gateway', '--data-dir', dataDir, '--host', '127.0.0.1', '--devin', bin, '--port', '0', '--roots', root, '--strict-roots'], env: { ...process.env, UNIHARN_TOKEN: 'test-token' }, detectTailscale: () => null, detectMagicDns: () => null });
  const server = createGatewayServer(config); let ws: WebSocket | undefined;
  try {
    const [{ port }] = await server.start(); ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await once(ws, 'open');
    let next = 0;
    const request = (type: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next; const timer = setTimeout(() => reject(Error(`RPC timeout: ${type}`)), 3000);
      const listener = (raw: any) => { const msg = JSON.parse(String(raw)); if (msg.type === 'response' && msg.id === id) { clearTimeout(timer); ws!.off('message', listener); resolve(msg); } };
      ws!.on('message', listener); ws!.send(JSON.stringify({ id, type, ...params }));
    });
    assert.equal((await request('scheduler.list')).ok, false);
    assert.equal((await request('hello', { token: 'test-token' })).ok, true);
    const listing = await request('scheduler.list'); assert.equal(listing.result.tasks[0].id, task.id);
    const canceled = await request('scheduler.cancel', { taskId: task.id }); assert.equal(canceled.result.task.status, 'canceled');
    const role = { name: 'Reviewer', harnessId: 'devin' };
    const team = (await request('teams.create', { team: { name: 'Team', cwd: root, roles: [role] } })).result.team;
    for (const [method, params] of [
      ['profiles.create', { profile: { name: 'Rejected', cwd: outside, harnessId: 'devin' } }],
      ['teams.create', { team: { name: 'Rejected', cwd: outside, roles: [role] } }],
      ['teams.start', { teamId: team.id, task: 'review', sessionId: 'outside-session' }],
      ['orchestration.delegate', { cwd: root, harnessId: 'devin', task: 'review', sessionId: 'outside-session' }],
      ['scheduler.create', { task: input({ sessionId: 'outside-session' }) }],
    ] as const) {
      const blocked = await request(method, params);
      assert.equal(blocked.error, 'Path is outside allowed roots', method);
    }
    const { session, workspaceId } = (await request('session.create', { cwd: root })).result;
    assert.equal((await request('session.create', { cwd: other, workspaceId })).error, 'Session folder does not match workspace');
    const scheduled = [];
    for (const [prompt, status] of [['work', 'done'], ['refuse', 'failed']]) {
      const response = await request('scheduler.create', { task: input({ sessionId: session.sessionId, workspaceId, steps: [{ prompt }], schedule: { type: 'immediate' } }) });
      assert.equal(response.ok, true, response.error);
      scheduled.push(response.result.task.id);
      let current;
      const deadline = Date.now() + 3000;
      do {
        const { result } = await request('scheduler.list', { workspaceId });
        current = result.tasks.find((row: any) => row.id === response.result.task.id);
        if (current?.status === status) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      } while (Date.now() < deadline);
      assert.equal(current?.status, status);
    }
    const notifications = (await request('notifications.list')).result.notifications;
    const terminal = notifications.filter((row: any) => ['task_completed', 'execution_failed'].includes(row.type));
    assert.equal(terminal.length, 2);
    assert.ok(terminal.some((row: any) => row.dedupKey.startsWith(`scheduler:${scheduled[0]}:completed:`) && row.safeBody === 'A scheduled task finished.'));
    assert.ok(terminal.some((row: any) => row.dedupKey.startsWith(`scheduler:${scheduled[1]}:failed:`) && row.body.includes('refusal')));
  } finally { ws?.terminate(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('absolute schedules survive restart and failed atomic writes do not change the queue', async () => {
  const dir = fixture(); let calls = 0;
  const opts = { checkTarget: () => {}, executor: async () => { calls++; } };
  try {
    const s = new Scheduler(dir, opts);
    const task = await s.create(input({ schedule: { type: 'at', at: Date.now() + 100 } }));
    assert.equal(task.status, 'scheduled'); s.close();
    const restored = new Scheduler(dir, opts); restored.start();
    assert.equal(calls, 0); await wait(() => restored.get(task.id).status === 'done'); assert.equal(calls, 1); restored.close();
    const badDir = join(dir, 'bad'); const failed = new Scheduler(badDir, opts);
    mkdirSync(join(badDir, 'scheduler.json'));
    await assert.rejects(failed.create(input()), /EISDIR|ENOTDIR|EEXIST/);
    assert.deepEqual(failed.list(), []); failed.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

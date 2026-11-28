import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Session } from '../src/sessions.js';
import { UsageCenter } from '../src/usage.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'usage-test-'));
  const registry = new HarnessRegistry(dir);
  for (const id of ['devin', 'alpha']) registry.register(new AcpHarnessAdapter({ id, name: id, bin: 'missing-usage-test', acpArgs: [] }));
  const orchestrator = new Orchestrator(registry, dir);
  const account = { loggedIn: true, fields: [], auth: { status: 'authenticated', detail: null }, usageError: null, usage: null as any };
  const center = () => new UsageCenter(dir, registry, orchestrator, async () => account);
  return { dir, registry, orchestrator, account, center, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('manual patches merge, clear, validate and survive restart; reset removes all fields', async () => {
  const s = setup();
  try {
    const center = s.center();
    center.update('alpha', { accountLabel: 'me', plan: 'pro', note: 'keep', usagePercent: 0, tokens: { input: 9, output: 3 }, resetAt: '2030-01-01T09:00:00+09:00' }, false);
    center.update('alpha', { plan: '', tokens: { input: null, cachedRead: 2 } }, false);
    const entry = (await s.center().report()).harnesses[1];
    assert.equal(entry.manual?.plan, null);
    assert.equal(entry.manual?.note, 'keep');
    assert.equal(entry.manual?.resetAt, '2030-01-01T00:00:00.000Z');
    assert.deepEqual(entry.manual?.tokens, { input: 0, output: 3, cachedRead: 2, total: 3 });
    assert.equal(entry.usage.percent, 0);
    assert.equal(statSync(join(s.dir, 'usage.json')).mode & 0o777, 0o600);
    const before = readFileSync(join(s.dir, 'usage.json'), 'utf8');
    for (const bad of [{ usagePercent: 101 }, { usagePercent: -1 }, { usagePercent: '1' }, { accountLabel: 'x'.repeat(121) }, { note: 'x'.repeat(501) }, { tokens: { input: -1 } }, { tokens: { output: 1.1 } }, { resetAt: 'tomorrow' }, { resetAt: '2030-02-30T00:00:00Z' }, { extra: 1 }, { toString: 'bad' }]) {
      assert.throws(() => center.update('alpha', bad, false));
    }
    assert.throws(() => center.update('missing', {}, false), /Unknown harness/);
    assert.throws(() => center.update('alpha', {}, 'true'), /boolean/);
    assert.equal(readFileSync(join(s.dir, 'usage.json'), 'utf8'), before);
    center.update('alpha', null, false);
    assert.equal((await center.report()).harnesses[1].manual, null);
    center.update('alpha', { note: 'again' }, false);
    center.update('alpha', undefined, true);
    assert.equal((await s.center().report()).harnesses[1].manual, null);
  } finally { s.cleanup(); }
});

test('atomic save failure retains previous disk and memory state; malformed and old files are tolerated', async () => {
  const s = setup();
  try {
    writeFileSync(join(s.dir, 'usage.json'), JSON.stringify({ alpha: { plan: 'legacy' }, bad: { usagePercent: 999 } }));
    const center = s.center();
    assert.equal((await center.report()).harnesses[1].plan, 'legacy');
    center.update('alpha', { note: 'saved' }, false);
    const file = join(s.dir, 'usage.json');
    const before = readFileSync(file, 'utf8');
    // Block rename while preserving a copy of the previously committed state.
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => center.update('alpha', { note: 'unsaved' }, false));
    assert.equal((await center.report()).harnesses[1].note, 'saved');
    rmSync(file, { recursive: true });
    writeFileSync(file, before);
    assert.equal((await s.center().report()).harnesses[1].note, 'saved');
    writeFileSync(file, '{broken');
    assert.equal((await s.center().report()).harnesses[1].manual, null);
  } finally { s.cleanup(); }
});

test('official quota wins over manual values, chooses nearest upcoming reset, and reports failures', async () => {
  const s = setup();
  try {
    s.account.usage = { plan: 'Official', overageBalance: 3.5, planEndsAt: null, windows: [
      { id: 'weekly', label: 'Weekly', remainingPercent: 45, resetsAt: '2099-02-01T00:00:00.000Z' },
      { id: 'daily', label: 'Daily', remainingPercent: 25, resetsAt: '2099-01-01T00:00:00.000Z' },
      { id: 'expired', label: 'Old', remainingPercent: 60, resetsAt: '2000-01-01T00:00:00.000Z' },
    ] };
    const center = s.center();
    assert.equal((await center.report()).harnesses[0].credit, null);
    center.update('devin', { plan: 'Manual', credit: 'manual', usagePercent: 90, resetAt: '2098-01-01T00:00:00Z' }, false);
    const first = (await center.report()).harnesses[0];
    assert.equal(first.plan, 'Official');
    assert.equal(first.credit, 'manual');
    assert.deepEqual(first.usage, { kind: 'percent', percent: 25, remaining: true, tokens: null, source: 'official' });
    assert.deepEqual(first.reset, { at: '2099-01-01T00:00:00.000Z', source: 'official', windowId: 'daily', label: 'Daily' });
    s.account.usage = null;
    s.account.usageError = 'quota unavailable' as any;
    const fallback = await center.report();
    assert.equal(fallback.officialError, 'quota unavailable');
    assert.equal(fallback.harnesses[0].plan, 'Manual');
    assert.equal(fallback.harnesses[0].usage.source, 'manual');
    assert.equal(fallback.harnesses[0].reset?.source, 'manual');
  } finally { s.cleanup(); }
});

test('official account fields and auth match the registry and probe errors still return a report', async () => {
  const s = setup();
  try {
    const adapter = s.registry.require('alpha');
    const original = adapter.info.bind(adapter);
    adapter.info = () => ({ ...original(), auth: { status: 'authenticated', method: 'OAuth', checkedAt: '2025-01-01T00:00:00.000Z', expiresAt: null, detail: null, account: [{ label: 'Email', value: 'official@example.test' }, { label: 'Plan', value: 'Official' }] } });
    const center = new UsageCenter(s.dir, s.registry, s.orchestrator, async () => { throw new Error('auth probe failed'); });
    center.update('alpha', { accountLabel: 'manual', plan: 'manual' }, false);
    const report = await center.report();
    const entry = report.harnesses[1];
    assert.equal(report.officialError, 'auth probe failed');
    assert.equal(entry.accountLabel, 'official@example.test');
    assert.equal(entry.plan, 'Official');
    assert.equal(entry.sources.accountLabel, 'official');
    assert.deepEqual(entry.auth, { status: 'authenticated', method: 'OAuth', checkedAt: '2025-01-01T00:00:00.000Z', expiresAt: null, detail: null });
  } finally { s.cleanup(); }
});

test('state events accumulate session counters and delegation summaries are ordered and limited', async () => {
  const s = setup();
  try {
    const center = s.center();
    for (let i = 0; i < 105; i++) {
      const session = new Session(String(i), '/tmp', 'alpha');
      session.loaded = true;
      session.updatedAt = i + 1;
      session.tokens = { turns: 1, inputTokens: i, outputTokens: 1, cachedReadTokens: 2 };
      s.registry.emit('state', session.summary());
      s.registry.emit('state', session.summary());
    }
    const reset = new Session('104', '/tmp', 'alpha');
    reset.updatedAt = 200;
    reset.tokens = { turns: 1, inputTokens: 3, outputTokens: 2, cachedReadTokens: 1 };
    s.registry.emit('state', reset.summary());
    const links = Array.from({ length: 105 }, (_, i) => ({ id: String(i), kind: 'delegate', harnessId: 'alpha', parentSessionId: '', childSessionId: '', task: 'test', status: i % 2 ? 'done' : 'running', createdAt: i, updatedAt: i }));
    links.push({ ...links[0], id: 'handoff', kind: 'handoff', createdAt: 1000 });
    s.orchestrator.list = (() => links) as any;
    const report = await center.report();
    assert.deepEqual(report.harnesses.map((h) => h.harnessId), ['devin', 'alpha']);
    assert.equal(report.sessions.length, 100);
    assert.equal(report.sessions[0].sessionId, 'alpha:104');
    assert.equal(report.sessions[0].tokens.input, 107);
    assert.equal(report.harnesses[1].sessions.count, 105);
    assert.equal(report.harnesses[1].sessions.tokens.input, 5463);
    assert.equal(report.delegations.length, 100);
    assert.equal(report.delegations[0].id, '104');
    assert.equal(report.harnesses[1].delegations.count, 105);
    assert.equal(report.harnesses[1].delegations.done, 52);
    s.registry.emit('deleted', 'alpha:104');
    assert.equal((await center.report()).harnesses[1].sessions.count, 104);
  } finally { s.cleanup(); }
});

test('updatedAt tracks persisted manual edits through activity, no-op updates and clears', async () => {
  const s = setup();
  try {
    const old = '2001-01-01T00:00:00.000Z';
    writeFileSync(join(s.dir, 'usage.json'), JSON.stringify({
      harnesses: { alpha: { updatedAt: old, manual: { note: 'prior' } } },
    }));
    const center = s.center();
    const entry = async () => (await center.report()).harnesses[1];
    const session = new Session('busy', '/tmp', 'alpha');
    session.updatedAt = Date.parse('2099-01-01T00:00:00Z');
    s.registry.emit('state', session.summary());
    assert.equal((await entry()).updatedAt, old);
    for (const noChange of [undefined, {}, { tokens: {} }, { note: 'prior' }, { plan: null }]) {
      center.update('alpha', noChange, false);
      assert.equal((await entry()).updatedAt, old);
    }
    center.update('alpha', { note: 'edited' }, false);
    const edited = (await entry()).updatedAt;
    assert.ok(edited && Date.parse(edited) > Date.parse(old));
    assert.equal(edited, JSON.parse(readFileSync(join(s.dir, 'usage.json'), 'utf8')).harnesses.alpha.updatedAt);
    assert.equal((await s.center().report()).harnesses[1].updatedAt, edited);
    for (const clear of [{ note: '' }, null, undefined]) {
      center.update('alpha', { note: 'edited' }, false);
      center.update('alpha', clear, clear === undefined);
      assert.equal((await entry()).updatedAt, null);
    }
  } finally { s.cleanup(); }
});

test('nested manual token edits persist independently for each harness', async () => {
  const s = setup();
  try {
    let center = s.center();
    center.update('devin', { tokens: { input: 8, output: 9, cachedRead: 4 } }, false);
    const check = async (tokens: { input: number; output: number; cachedRead: number; total: number } | null, cleared = false) => {
      center = s.center();
      const [devin, alpha] = (await center.report()).harnesses;
      assert.deepEqual(devin.manual?.tokens, { input: 8, output: 9, cachedRead: 4, total: 17 });
      assert.deepEqual(alpha.usage.tokens, tokens);
      if (cleared) assert.equal(alpha.manual, null);
      else {
        assert.equal(alpha.manual?.note, 'keep');
        assert.deepEqual(alpha.manual.tokens, tokens);
      }
    };
    center.update('alpha', { note: 'keep', tokens: { input: 12, output: 5, cachedRead: 7 } }, false);
    await check({ input: 12, output: 5, cachedRead: 7, total: 17 });
    center.update('alpha', { tokens: { output: 11 } }, false);
    await check({ input: 12, output: 11, cachedRead: 7, total: 23 });
    center.update('alpha', { tokens: { input: null, cachedRead: '' } }, false);
    await check({ input: 0, output: 11, cachedRead: 0, total: 11 });
    center.update('alpha', { tokens: { output: '' } }, false);
    await check(null);
    for (const clear of [null, '']) {
      center.update('alpha', { tokens: { cachedRead: 7 } }, false);
      center.update('alpha', { tokens: clear }, false);
      await check(null);
    }
    for (const reset of [false, true]) {
      center.update('alpha', { tokens: { input: 1 } }, false);
      center.update('alpha', reset ? undefined : null, reset);
      await check(null, true);
    }
  } finally { s.cleanup(); }
});

test('usage auth mirrors all five registry auth fields, including expiry and missing values', async () => {
  const s = setup();
  try {
    const adapter = s.registry.require('devin');
    const info = adapter.info();
    const center = s.center();
    for (const auth of [
      { status: 'expired', method: 'OAuth', checkedAt: '2031-01-02T00:00:00Z', expiresAt: '2031-01-01T00:00:00Z', detail: 'Login expired' },
      { status: 'unknown', method: null, checkedAt: null, expiresAt: null, detail: null },
    ] as const) {
      adapter.info = () => ({ ...info, auth: { ...auth, account: [] } });
      const { account, ...expected } = s.registry.list()[0].auth;
      const entry = (await center.report()).harnesses[0];
      assert.deepEqual(entry.auth, expected);
      assert.equal(entry.updatedAt, null);
    }
  } finally { s.cleanup(); }
});

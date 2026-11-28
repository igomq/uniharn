import test from 'node:test';
import assert from 'node:assert/strict';
import { linkEntry, linkOf, retryRequest, subagentGroup, subagentSummary, subagentsOf } from '../src/lib/subagents.ts';
import type { SessionLink, SubagentEntry } from '../src/lib/types.ts';

const link = (over: Partial<SessionLink> = {}): SessionLink => ({
  id: 'l1',
  kind: 'delegate',
  parentSessionId: 'p',
  childSessionId: 'c1',
  harnessId: 'codex',
  task: 'Fix the tests\nDetails follow',
  cwd: '/repo',
  worktree: null,
  branch: null,
  model: 'gpt-5',
  status: 'running',
  output: null,
  stopReason: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test('subagents fall into Active, Waiting, Done and Failed', () => {
  assert.equal(subagentGroup('running'), 'active');
  assert.equal(subagentGroup('requires_action'), 'waiting');
  assert.equal(subagentGroup('awaiting_permission'), 'waiting');
  assert.equal(subagentGroup('done'), 'done');
  assert.equal(subagentGroup('idle'), 'done');
  assert.equal(subagentGroup('completed'), 'done');
  assert.equal(subagentGroup('error'), 'failed');
  assert.equal(subagentGroup('cancelled'), 'failed');
});

test('the live child session status overrides a stale entry status', () => {
  assert.equal(subagentGroup('done', 'running'), 'active');
  assert.equal(subagentGroup('error', 'running'), 'active');
  assert.equal(subagentGroup('running', 'awaiting_permission'), 'waiting');
  assert.equal(subagentGroup('done', 'idle'), 'done');
});

test('links missing from the gateway list still show, newest first', () => {
  const remote: SubagentEntry = { ...linkEntry(link({ childSessionId: 'c2', updatedAt: 5 })), kind: 'native', id: 'n' };
  const links = [link({ updatedAt: 9 }), link({ id: 'l2', childSessionId: 'c2' }), link({ id: 'l3', parentSessionId: 'other', childSessionId: 'c3' })];
  const rows = subagentsOf('p', [remote], links);
  assert.deepEqual(
    rows.map((r) => [r.childSessionId, r.kind]),
    [
      ['c1', 'delegate'],
      ['c2', 'native'],
    ],
  );
  assert.equal(rows[0].title, 'Fix the tests');
  assert.equal(rows[0].canCancel, true);
});

test('row summary prefers the error for failures, then the output, then the description', () => {
  const entry = linkEntry(link());
  assert.equal(subagentSummary(entry, link({ status: 'error', error: 'Turn failed: boom\nstack' }), 'failed'), 'Turn failed: boom');
  assert.equal(subagentSummary(entry, link({ status: 'done', output: '\nAll green.\nMore' }), 'done'), 'All green.');
  assert.equal(subagentSummary({ ...entry, description: 'Reviews code' }, undefined, 'active'), 'Reviews code');
  assert.equal(subagentSummary(entry, undefined, 'active'), '');
});

test('linkOf finds the delegation behind a row and ignores native children', () => {
  const links = [link(), link({ id: 'l2', childSessionId: 'c2' })];
  assert.equal(linkOf(linkEntry(links[1]), links)?.id, 'l2');
  assert.equal(linkOf({ ...linkEntry(links[0]), kind: 'native' }, links), undefined);
});

test('retry repeats the task on the same harness, model and worktree setting', () => {
  assert.deepEqual(retryRequest(linkEntry(link({ worktree: '/repo/.uniharn/worktrees/l1', status: 'error' }))), {
    id: 'p',
    harnessId: 'codex',
    task: 'Fix the tests\nDetails follow',
    worktree: true,
    model: 'gpt-5',
  });
  assert.equal(retryRequest(linkEntry(link({ model: null })))?.model, null);
  assert.equal(retryRequest({ ...linkEntry(link()), kind: 'native' }), null);
  assert.equal(retryRequest({ ...linkEntry(link()), task: null }), null);
});

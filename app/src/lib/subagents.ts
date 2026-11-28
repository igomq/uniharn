import type { SessionLink, SubagentEntry } from './types.ts';

export type SubagentGroup = 'active' | 'waiting' | 'done' | 'failed';

/** Panel sections, in display order. */
export const SUBAGENT_GROUPS: { id: SubagentGroup; name: string }[] = [
  { id: 'active', name: 'Active' },
  { id: 'waiting', name: 'Waiting' },
  { id: 'done', name: 'Done' },
  { id: 'failed', name: 'Failed' },
];

const WAITING = new Set(['requires_action', 'awaiting_permission', 'waiting', 'queued', 'pending']);
const ACTIVE = new Set(['running', 'in_progress', 'working']);
const FAILED = new Set(['error', 'failed', 'cancelled', 'canceled', 'timeout', 'timed_out']);

/**
 * Section for a subagent. `liveStatus` is the status of the child's open session view, which runs ahead of the
 * entry: a finished child that received a follow-up is running again before its link is updated.
 */
export function subagentGroup(status: string, liveStatus?: string | null): SubagentGroup {
  if (WAITING.has(status) || liveStatus === 'awaiting_permission') return 'waiting';
  if (ACTIVE.has(status) || liveStatus === 'running') return 'active';
  if (FAILED.has(status)) return 'failed';
  return 'done';
}

/** Panel row for a delegation link the gateway's subagent list has not reported yet. */
export function linkEntry(link: SessionLink): SubagentEntry {
  return {
    kind: 'delegate',
    id: link.id,
    parentSessionId: link.parentSessionId,
    childSessionId: link.childSessionId,
    harnessId: link.harnessId,
    title: link.task.split('\n')[0] || 'Subagent',
    description: null,
    task: link.task,
    cwd: link.cwd,
    worktree: link.worktree,
    branch: link.branch,
    model: link.model ?? null,
    status: link.status,
    state: null,
    capabilities: { prompt: {} },
    configOptions: [],
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    canMessage: true,
    canCancel: link.status === 'running',
  };
}

/** Subagents of one parent session, newest update first: gateway entries plus delegation links missing from them. */
export function subagentsOf(parentSessionId: string, entries: SubagentEntry[], links: SessionLink[]): SubagentEntry[] {
  const remote = entries.filter((e) => e.parentSessionId === parentSessionId);
  const linked = links
    .filter((l) => l.kind === 'delegate' && l.parentSessionId === parentSessionId && !remote.some((e) => e.childSessionId === l.childSessionId))
    .map(linkEntry);
  return [...remote, ...linked].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The delegation link behind a subagent; native harness children have none. */
export function linkOf(entry: SubagentEntry, links: SessionLink[]): SessionLink | undefined {
  if (entry.kind !== 'delegate') return undefined;
  return links.find((l) => l.kind === 'delegate' && l.childSessionId === entry.childSessionId && l.parentSessionId === entry.parentSessionId);
}

/** One line for a panel row: the failure, else the start of the result, else the description. */
export function subagentSummary(entry: SubagentEntry, link: SessionLink | undefined, group: SubagentGroup): string {
  const firstLine = (text: string | null | undefined) => (text ?? '').trim().split('\n')[0].trim();
  if (group === 'failed' && link?.error) return firstLine(link.error);
  return firstLine(link?.output) || firstLine(entry.description);
}

/**
 * `orchestration.delegate` parameters that run a delegated subagent's task again on the same harness, model and
 * isolation. Native harness children are started by their harness, so they cannot be retried from here.
 */
export function retryRequest(entry: SubagentEntry) {
  if (entry.kind !== 'delegate' || !entry.task) return null;
  return { id: entry.parentSessionId, harnessId: entry.harnessId, task: entry.task, worktree: !!entry.worktree, model: entry.model };
}

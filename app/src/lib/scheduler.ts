// Scheduled tasks as the Tasks screen reads and edits them. The gateway (gateway/src/scheduler.ts) owns the
// state machine; these helpers normalize its rows, describe them and turn the editor form into create/update input.
import type { Json } from './types.ts';

export const TASK_STATUSES = ['pending', 'scheduled', 'running', 'done', 'failed', 'canceled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Why a pending or scheduled task is not running yet. Kept apart from the status. */
export type TaskCondition = 'manual_hold' | 'awaiting_confirmation' | 'interrupted' | 'dependency_wait' | 'dependency_failed';

export type Schedule = { type: 'immediate' } | { type: 'delay'; delayMs: number } | { type: 'at'; at: number } | { type: 'manual' };

/** One prompt in the task. A step that requires confirmation is destructive: the task stops before it until confirmed. */
export interface TaskStep {
  prompt: string;
  requiresConfirmation: boolean;
}

export interface TaskLog {
  at: number;
  event: string;
  step: number;
  message: string | null;
}

export interface Task {
  id: string;
  title: string;
  sessionId: string;
  workspaceId: string | null;
  harness: string | null;
  model: string | null;
  profile: string | null;
  team: string | null;
  /** Other tasks that must be done before this one starts. */
  dependencyIds: string[];
  condition: TaskCondition | null;
  steps: TaskStep[];
  schedule: Schedule;
  maxAttempts: number;
  retryDelayMs: number;
  status: TaskStatus;
  currentStep: number;
  attempts: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  logs: TaskLog[];
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  canceled: 'Canceled'
};

export const CONDITION_LABEL: Record<TaskCondition, string> = {
  manual_hold: 'On hold',
  awaiting_confirmation: 'Needs confirmation',
  interrupted: 'Interrupted',
  dependency_wait: 'Waiting for dependencies',
  dependency_failed: 'Dependency failed'
};

const LOG_LABEL: Record<string, string> = {
  created: 'Created',
  updated: 'Edited',
  released: 'Released',
  confirmed: 'Confirmed',
  awaiting_confirmation: 'Waiting for confirmation',
  running: 'Started',
  step_completed: 'Step finished',
  completed: 'Finished',
  error: 'Error',
  retry: 'Retry scheduled',
  failed: 'Failed',
  canceled: 'Canceled',
  interrupted: 'Interrupted',
  target_busy: 'Session busy, waiting',
  dependencies_ready: 'Dependencies done',
  dependency_wait: 'Waiting for dependencies',
  dependency_failed: 'Dependency failed'
};

export function logLabel(event: string) {
  return LOG_LABEL[event] ?? event.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const count = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function scheduleOf(s: Json): Schedule {
  if (s?.type === 'delay') return { type: 'delay', delayMs: count(s.delayMs, 0) };
  if (s?.type === 'at') return { type: 'at', at: count(s.at, 0) };
  if (s?.type === 'manual') return { type: 'manual' };
  return { type: 'immediate' };
}

/** A gateway task row with every field present, so the screen never has to guard against a missing one. */
export function normalizeTask(raw: Json): Task {
  const status: TaskStatus = TASK_STATUSES.includes(raw?.status) ? raw.status : 'pending';
  const condition = raw?.condition in CONDITION_LABEL ? (raw.condition as TaskCondition) : null;
  return {
    id: String(raw?.id ?? ''),
    title: text(raw?.title) ?? 'Untitled task',
    sessionId: text(raw?.sessionId) ?? '',
    workspaceId: text(raw?.workspaceId),
    harness: text(raw?.harness),
    model: text(raw?.model),
    profile: text(raw?.profile),
    team: text(raw?.team),
    dependencyIds: Array.isArray(raw?.dependencyIds) ? raw.dependencyIds.filter((id: unknown) => typeof id === 'string') : [],
    condition,
    steps: Array.isArray(raw?.steps) ? raw.steps.map((s: Json) => ({ prompt: String(s?.prompt ?? ''), requiresConfirmation: s?.requiresConfirmation === true })) : [],
    schedule: scheduleOf(raw?.schedule),
    maxAttempts: count(raw?.maxAttempts, 1),
    retryDelayMs: count(raw?.retryDelayMs, 0),
    status,
    currentStep: count(raw?.currentStep, 0),
    attempts: count(raw?.attempts, 0),
    nextRunAt: typeof raw?.nextRunAt === 'number' ? raw.nextRunAt : null,
    createdAt: count(raw?.createdAt, 0),
    updatedAt: count(raw?.updatedAt, 0),
    logs: Array.isArray(raw?.logs) ? raw.logs.map((l: Json) => ({ at: count(l?.at, 0), event: String(l?.event ?? ''), step: count(l?.step, 0), message: text(l?.message) })) : []
  };
}

/** Running first, then what needs a decision, then the queue in run order, then finished tasks newest first. */
export function sortTasks(tasks: Task[]): Task[] {
  const rank = (t: Task) => {
    if (t.status === 'running') return 0;
    if (t.condition === 'awaiting_confirmation' || t.condition === 'interrupted' || t.condition === 'dependency_failed') return 1;
    if (t.status === 'pending' || t.status === 'scheduled') return 2;
    return 3;
  };
  const queueTime = (t: Task) => t.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? queueTime(a) - queueTime(b) : b.updatedAt - a.updatedAt));
}

export function statusCounts(tasks: Task[]): Record<TaskStatus, number> {
  const counts = { pending: 0, scheduled: 0, running: 0, done: 0, failed: 0, canceled: 0 };
  for (const t of tasks) counts[t.status] += 1;
  return counts;
}

/** "45s", "12m", "3h 20m", "2d 4h". */
export function durationText(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? h + 'h ' + (m % 60) + 'm' : h + 'h';
  return h % 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : Math.floor(h / 24) + 'd';
}

/** "Today 14:30", "Tomorrow 09:00" or "Dec 3, 14:30" in local time. */
export function clockText(at: number, now = Date.now()) {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86400000);
  if (days === 0) return 'Today ' + time;
  if (days === 1) return 'Tomorrow ' + time;
  if (days === -1) return 'Yesterday ' + time;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

/** How the task was set to start, as chosen in the editor. */
export function scheduleText(schedule: Schedule, now = Date.now()) {
  if (schedule.type === 'delay') return 'After ' + durationText(schedule.delayMs);
  if (schedule.type === 'at') return clockText(schedule.at, now);
  if (schedule.type === 'manual') return 'Held until released';
  return 'Right away';
}

/** The short state line under a task's title. */
export function progressText(task: Task, now = Date.now()) {
  const steps = task.steps.length;
  const step = Math.min(task.currentStep + 1, steps);
  if (task.status === 'running') return steps > 1 ? 'Step ' + step + ' of ' + steps : 'Running';
  if (task.condition === 'awaiting_confirmation') return 'Step ' + step + ' needs your confirmation';
  if (task.condition) return CONDITION_LABEL[task.condition];
  if (task.status === 'scheduled' && task.nextRunAt !== null) {
    const retrying = task.attempts > 0 ? 'Retry ' : 'Starts ';
    return task.nextRunAt - now < 3600000 ? retrying + 'in ' + durationText(task.nextRunAt - now) : retrying + clockText(task.nextRunAt, now);
  }
  if (task.status === 'pending') return task.dependencyIds.length ? 'Queued after dependencies' : 'Queued';
  if (task.status === 'done') return 'Finished ' + clockText(task.updatedAt, now);
  if (task.status === 'failed') return 'Failed after ' + task.attempts + (task.attempts === 1 ? ' attempt' : ' attempts');
  return 'Canceled ' + clockText(task.updatedAt, now);
}

/** Which actions the gateway accepts for a task in its current state. */
export function taskActions(task: Task) {
  const waiting = task.status === 'pending' || task.status === 'scheduled';
  return {
    edit: waiting,
    cancel: waiting || task.status === 'running',
    remove: task.status !== 'running',
    release: task.condition === 'manual_hold' || task.condition === 'interrupted',
    confirm: task.condition === 'awaiting_confirmation'
  };
}

/** The latest outcome in the log (finished, failed, an error or an interruption), if any. */
export function lastResult(task: Task): TaskLog | null {
  const outcomes = new Set(['completed', 'step_completed', 'failed', 'error', 'canceled', 'interrupted']);
  for (let i = task.logs.length - 1; i >= 0; i--) if (outcomes.has(task.logs[i].event)) return task.logs[i];
  return null;
}

/**
 * Tasks this one may not depend on: itself and every task that already depends on it, directly or
 * through others, since either would make a loop. New tasks (no id) can depend on anything.
 */
export function cyclicChoices(tasks: Task[], taskId: string | null): Set<string> {
  const blocked = new Set<string>();
  if (!taskId) return blocked;
  blocked.add(taskId);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (!blocked.has(t.id) && t.dependencyIds.some((id) => blocked.has(id))) {
        blocked.add(t.id);
        grew = true;
      }
    }
  }
  return blocked;
}

/** The task's dependencies with their current state; ids that no longer exist are reported as missing. */
export function dependencyRows(task: Pick<Task, 'dependencyIds'>, tasks: Task[]) {
  return task.dependencyIds.map((id) => {
    const dep = tasks.find((t) => t.id === id);
    return { id, title: dep?.title ?? 'Deleted task', status: dep?.status ?? null };
  });
}

/** Tasks that list this one as a dependency, so deleting or canceling it can say what it blocks. */
export function dependents(tasks: Task[], taskId: string) {
  return tasks.filter((t) => t.dependencyIds.includes(taskId));
}

export type When = Schedule['type'];

/** The editor form. Text fields stay strings; empty means "not set". */
export interface TaskDraft {
  title: string;
  sessionId: string;
  model: string;
  profile: string;
  team: string;
  steps: TaskStep[];
  when: When;
  delayMinutes: number;
  /** datetime-local value, local time. */
  at: string;
  dependencyIds: string[];
  maxAttempts: number;
  retryDelaySeconds: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A datetime-local input value for a timestamp, in local time. */
export function localInputValue(ms: number) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function emptyDraft(sessionId = '', now = Date.now()): TaskDraft {
  return {
    title: '',
    sessionId,
    model: '',
    profile: '',
    team: '',
    steps: [{ prompt: '', requiresConfirmation: false }],
    when: 'immediate',
    delayMinutes: 30,
    at: localInputValue(now + 3600000),
    dependencyIds: [],
    maxAttempts: 1,
    retryDelaySeconds: 60
  };
}

/** The form filled from an existing task, for editing it or starting a copy. */
export function draftFromTask(task: Task, now = Date.now()): TaskDraft {
  return {
    title: task.title,
    sessionId: task.sessionId,
    model: task.model ?? '',
    profile: task.profile ?? '',
    team: task.team ?? '',
    steps: task.steps.map((s) => ({ ...s })),
    when: task.schedule.type,
    delayMinutes: task.schedule.type === 'delay' ? Math.max(1, Math.round(task.schedule.delayMs / 60000)) : 30,
    at: localInputValue(task.schedule.type === 'at' ? task.schedule.at : now + 3600000),
    dependencyIds: [...task.dependencyIds],
    maxAttempts: task.maxAttempts,
    retryDelaySeconds: Math.round(task.retryDelayMs / 1000)
  };
}

/** Why the form cannot be saved yet, or null. */
export function draftProblem(draft: TaskDraft, now = Date.now()): string | null {
  if (!draft.title.trim()) return 'Give the task a title.';
  if (!draft.sessionId) return 'Pick the session the task runs in.';
  if (!draft.steps.length || draft.steps.some((s) => !s.prompt.trim())) return 'Every step needs a prompt.';
  if (draft.when === 'delay' && !(draft.delayMinutes >= 1)) return 'The delay must be at least one minute.';
  if (draft.when === 'at') {
    const at = new Date(draft.at).getTime();
    if (!Number.isFinite(at)) return 'Pick a start time.';
    if (at <= now) return 'The start time has already passed.';
  }
  return null;
}

/**
 * scheduler.create / scheduler.update input. Cleared choices are sent as null so an update removes them
 * (the gateway merges the patch over the stored task). The harness is the selected session's.
 */
export function taskInput(draft: TaskDraft, sessionHarness: string | null) {
  let schedule: Schedule = { type: draft.when } as Schedule;
  if (draft.when === 'delay') schedule = { type: 'delay', delayMs: Math.round(draft.delayMinutes * 60000) };
  if (draft.when === 'at') schedule = { type: 'at', at: new Date(draft.at).getTime() };
  return {
    title: draft.title.trim(),
    sessionId: draft.sessionId,
    harness: sessionHarness,
    model: draft.model || null,
    profile: draft.profile || null,
    team: draft.team || null,
    steps: draft.steps.map((s) => ({ prompt: s.prompt.trim(), requiresConfirmation: s.requiresConfirmation })),
    schedule,
    dependencyIds: [...draft.dependencyIds],
    maxAttempts: draft.maxAttempts,
    retryDelayMs: Math.round(draft.retryDelaySeconds * 1000)
  };
}

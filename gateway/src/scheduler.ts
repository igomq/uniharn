import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionBusy } from './harnesses/types.js';

export type Schedule = { type: 'immediate' } | { type: 'delay'; delayMs: number } | { type: 'at'; at: number } | { type: 'manual' };
export interface SchedulerStep { prompt: string; requiresConfirmation?: boolean }
export type SchedulerStatus = 'pending' | 'scheduled' | 'running' | 'done' | 'failed' | 'canceled';
export type SchedulerCondition = 'manual_hold' | 'awaiting_confirmation' | 'interrupted' | 'dependency_wait' | 'dependency_failed' | null;
export interface SchedulerLog { at: number; event: string; step: number; message?: string }
export interface SchedulerTask {
  id: string; title: string; sessionId: string; workspaceId?: string; harness?: string; model?: string; profile?: string; team?: string; dependencyIds: string[]; condition: SchedulerCondition; steps: SchedulerStep[]; schedule: Schedule;
  maxAttempts: number; retryDelayMs: number; status: SchedulerStatus; currentStep: number; attempts: number;
  confirmedStep?: number;
  targetCwd?: string;
  nextRunAt: number | null; createdAt: number; updatedAt: number; logs: SchedulerLog[];
}
export interface SchedulerOptions {
  executor: (task: SchedulerTask, step: SchedulerStep, signal: AbortSignal, log: (event: string, message: string) => void) => Promise<void>;
  checkTarget: (sessionId: string, workspaceId?: string, target?: Pick<SchedulerTask, 'harness' | 'model' | 'profile' | 'team' | 'targetCwd'>) => Promise<string | void> | string | void;
  notify?: (task: SchedulerTask, event: string) => Promise<void> | void;
  sanitizeLog?: (message: string) => string;
}
const MAX_TIMER = 2_147_483_647;
const BUSY_DELAY_MS = 1000;
const copy = <T>(value: T): T => structuredClone(value);
function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 100_000) throw new Error(`${name} must be a non-empty string`);
  return v.trim();
}
function integer(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return v;
}
function validate(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Task input is required');
  const title = str(input.title, 'title');
  const sessionId = str(input.sessionId, 'sessionId');
  const workspaceId = input.workspaceId == null ? undefined : str(input.workspaceId, 'workspaceId');
  const target = Object.fromEntries(['harness', 'model', 'profile', 'team'].map(key => [key, input[key] == null ? undefined : str(input[key], key)])) as Pick<SchedulerTask, 'harness' | 'model' | 'profile' | 'team'>;
  if (input.dependencyIds !== undefined && (!Array.isArray(input.dependencyIds) || input.dependencyIds.length > 50)) throw new Error('Invalid dependencyIds');
  const dependencyIds = (input.dependencyIds ?? []).map((v: unknown) => str(v, 'dependencyId'));
  if (new Set(dependencyIds).size !== dependencyIds.length) throw new Error('Duplicate dependency');
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 50) throw new Error('steps must contain 1 to 50 steps');
  const steps: SchedulerStep[] = input.steps.map((step: any) => {
    if (!step || typeof step !== 'object' || (step.requiresConfirmation !== undefined && typeof step.requiresConfirmation !== 'boolean')) throw new Error('Invalid step');
    return { prompt: str(step.prompt, 'prompt'), requiresConfirmation: step.requiresConfirmation === true };
  });
  const s = input.schedule;
  if (!s || typeof s !== 'object') throw new Error('schedule is required');
  let schedule: Schedule;
  switch (s.type) {
    case 'immediate': case 'manual': schedule = { type: s.type }; break;
    case 'delay': schedule = { type: 'delay', delayMs: integer(s.delayMs, 'delayMs', 0, 365 * 86400_000) }; break;
    case 'at': schedule = { type: 'at', at: integer(s.at, 'at', 0, Number.MAX_SAFE_INTEGER) }; break;
    default: throw new Error('Invalid schedule type');
  }
  return { title, sessionId, workspaceId, ...target, dependencyIds, steps, schedule, maxAttempts: integer(input.maxAttempts ?? 1, 'maxAttempts', 1, 10), retryDelayMs: integer(input.retryDelayMs ?? 1000, 'retryDelayMs', 0, 86400_000) };
}
function due(schedule: Schedule, now: number): number | null {
  return schedule.type === 'manual' ? null : schedule.type === 'delay' ? now + schedule.delayMs : schedule.type === 'at' ? schedule.at : now;
}

/** Single gateway process owns this store; each transition is persisted before its side effects. */
export class Scheduler {
  private readonly path: string;
  private tasks: SchedulerTask[];
  private timer?: NodeJS.Timeout;
  private started = false;
  private closed = false;
  private active = new Map<string, { controller: AbortController; sessionId: string }>();
  constructor(dataDir: string, private readonly options: SchedulerOptions) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, 'scheduler.json');
    if (existsSync(this.path)) {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('Invalid scheduler store');
      this.tasks = raw as SchedulerTask[];
      for (const task of this.tasks) {
        validate(task);
        if (!task.id || !Array.isArray(task.logs) || !['pending', 'scheduled', 'running', 'done', 'failed', 'canceled'].includes(task.status)) throw new Error('Invalid scheduler task in store');
        integer(task.currentStep, 'currentStep', 0, task.status === 'done' ? task.steps.length : task.steps.length - 1);
        integer(task.attempts, 'attempts', 0, Number.MAX_SAFE_INTEGER);
        if (task.nextRunAt !== null) integer(task.nextRunAt, 'nextRunAt', 0, Number.MAX_SAFE_INTEGER);
      }
    } else this.tasks = [];
  }
  private save(next: SchedulerTask[]) {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
      const dir = openSync(join(this.path, '..'), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (existsSync(tmp)) unlinkSync(tmp); }
    this.tasks = next;
  }
  private change(id: string, fn: (task: SchedulerTask) => void): SchedulerTask {
    const next = copy(this.tasks); const task = next.find(t => t.id === id);
    if (!task) throw new Error('Scheduled task not found');
    fn(task); task.updatedAt = Date.now(); this.save(next); return copy(task);
  }
  private log(task: SchedulerTask, event: string, message?: string, step = task.currentStep) {
    task.logs.push({ at: Date.now(), event, step, ...(message ? { message: (this.options.sanitizeLog?.(message) ?? message).slice(0, 1000) } : {}) });
    if (task.logs.length > 500) task.logs.splice(0, task.logs.length - 500);
  }
  private emit(task: SchedulerTask, event: string) {
    try { Promise.resolve(this.options.notify?.(copy(task), event)).catch(() => undefined); } catch { /* notification failure does not alter the queue */ }
  }
  start() {
    if (this.closed) throw new Error('Scheduler is closed');
    if (this.started) return;
    this.started = true;
    for (const t of this.tasks.filter(t => t.status === 'running')) {
      const task = this.change(t.id, x => { x.status = 'pending'; x.condition = 'interrupted'; x.nextRunAt = null; this.log(x, 'interrupted', 'Gateway restarted during execution'); });
      this.emit(task, 'interrupted');
    }
    this.arm();
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.started = false; clearTimeout(this.timer);
    for (const [id, active] of this.active) {
      const task = this.tasks.find(t => t.id === id);
      if (task?.status === 'running') {
        const updated = this.change(id, t => { t.status = 'pending'; t.condition = 'interrupted'; t.nextRunAt = null; this.log(t, 'interrupted', 'Gateway stopped during execution'); });
        this.emit(updated, 'interrupted');
      }
      active.controller.abort();
    }
  }
  list() { return copy([...this.tasks].sort((a, b) => b.createdAt - a.createdAt)); }
  async create(input: unknown) {
    const data = validate(input);
    const targetCwd = await this.options.checkTarget(data.sessionId, data.workspaceId, data);
    if (this.closed) throw new Error('Scheduler is closed');
    this.validateDependencies('', data.dependencyIds);
    const now = Date.now(); const nextRunAt = due(data.schedule, now);
    const task: SchedulerTask = { ...data, targetCwd: targetCwd || undefined, id: randomUUID(), status: nextRunAt !== null && nextRunAt > now ? 'scheduled' : 'pending', condition: nextRunAt === null ? 'manual_hold' : null, currentStep: 0, attempts: 0, nextRunAt, createdAt: now, updatedAt: now, logs: [] };
    this.log(task, 'created'); this.save([...this.tasks, task]); this.arm(); const current = this.get(task.id); this.emit(current, 'created'); return current;
  }
  async update(id: string, patch: any) {
    const old = this.get(id);
    if (!['pending', 'scheduled'].includes(old.status) || old.currentStep > 0 || old.attempts > 0 || old.condition === 'interrupted') throw new Error('Only tasks that have not started can be updated');
    const data = validate({ ...old, ...patch });
    this.validateDependencies(id, data.dependencyIds);
    const targetCwd = await this.options.checkTarget(data.sessionId, data.workspaceId, { ...data, targetCwd: data.sessionId === old.sessionId ? old.targetCwd : undefined });
    this.validateDependencies(id, data.dependencyIds);
    if (this.closed) throw new Error('Scheduler is closed');
    const task = this.change(id, t => {
      if (!['pending', 'scheduled'].includes(t.status) || t.currentStep > 0 || t.attempts > 0 || t.condition === 'interrupted' || JSON.stringify(t) !== JSON.stringify(old)) throw new Error('Task changed while updating');
      Object.assign(t, data, { targetCwd: targetCwd || undefined });
      delete t.confirmedStep;
      if (patch?.schedule !== undefined) t.nextRunAt = due(data.schedule, Date.now());
      else if (t.condition === 'awaiting_confirmation') t.nextRunAt = Date.now();
      t.status = t.nextRunAt !== null && t.nextRunAt > Date.now() ? 'scheduled' : 'pending';
      t.condition = t.nextRunAt === null ? 'manual_hold' : null;
      this.log(t, 'updated');
    });
    this.arm(); const current = this.get(id); this.emit(current, 'updated'); return current;
  }
  get(id: string) { const t = this.tasks.find(t => t.id === id); if (!t) throw new Error('Scheduled task not found'); return copy(t); }
  delete(id: string) {
    const task = this.get(id); if (this.tasks.some(t => t.dependencyIds.includes(id))) throw new Error('Task is required by another task'); if (this.active.has(id)) throw new Error('Cannot delete a running task');
    this.save(this.tasks.filter(t => t.id !== id)); this.arm(); this.emit(task, 'deleted'); return task;
  }
  cancel(id: string) {
    const task = this.change(id, t => {
      if (!['pending', 'scheduled', 'running'].includes(t.status)) throw new Error('Task cannot be cancelled');
      t.status = 'canceled'; t.condition = null; t.nextRunAt = null; this.log(t, 'canceled');
    });
    this.active.get(id)?.controller.abort(); this.arm(); this.emit(task, 'canceled'); return task;
  }
  release(id: string) {
    const task = this.change(id, t => { if (t.condition !== 'manual_hold' && t.condition !== 'interrupted') throw new Error('Task is not held or interrupted'); t.status = 'pending'; t.condition = null; t.nextRunAt = Date.now(); this.log(t, 'released'); });
    this.arm(); const current = this.get(id); this.emit(current, 'released'); return current;
  }
  confirm(id: string) {
    const task = this.change(id, t => { if (t.condition !== 'awaiting_confirmation') throw new Error('Task is not awaiting confirmation'); t.status = 'pending'; t.condition = null; t.nextRunAt = Date.now(); t.confirmedStep = t.currentStep; this.log(t, 'confirmed'); });
    this.arm(); this.emit(task, 'confirmed'); return task;
  }
  private validateDependencies(id: string, ids: string[]) {
    const graph = new Map(this.tasks.map(t => [t.id, t.dependencyIds]));
    graph.set(id, ids);
    for (const dep of ids) if (dep === id || !graph.has(dep)) throw new Error('Invalid or missing dependency');
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (node: string) => {
      if (visiting.has(node)) throw new Error('Dependency cycle');
      if (visited.has(node)) return;
      visiting.add(node); for (const dep of graph.get(node) ?? []) visit(dep);
      visiting.delete(node); visited.add(node);
    };
    visit(id);
  }
  private dependenciesReady(task: SchedulerTask) { return task.dependencyIds.every(id => this.tasks.find(t => t.id === id)?.status === 'done'); }
  private dependencyFailed(id: string) {
    const dep = this.tasks.find(t => t.id === id);
    return !dep || dep.status === 'failed' || dep.status === 'canceled' || dep.condition === 'dependency_failed';
  }
  private dependenciesFailed(task: SchedulerTask) { return task.dependencyIds.some(id => this.dependencyFailed(id)); }
  private refreshDependencies() {
    // Iterate to propagate failures through arbitrarily ordered chains.
    for (let i = 0; i < this.tasks.length; i++) {
      let changed = false;
      for (const task of this.tasks) {
        if (!['pending', 'scheduled'].includes(task.status) || ![null, 'dependency_wait', 'dependency_failed'].includes(task.condition)) continue;
        const condition = this.dependenciesFailed(task) ? 'dependency_failed' : !this.dependenciesReady(task) ? 'dependency_wait' : null;
        if (condition !== task.condition) {
          const updated = this.change(task.id, t => {
            t.condition = condition;
            const blocked = condition === 'dependency_failed' ? t.dependencyIds.filter(id => this.dependencyFailed(id)) : [];
            this.log(t, condition ?? 'dependencies_ready', blocked.length ? `Unsuccessful dependencies: ${blocked.join(', ')}` : undefined);
          });
          this.emit(updated, condition ?? 'dependencies_ready'); changed = true;
        }
      }
      if (!changed) break;
    }
  }
  private arm() {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.refreshDependencies();
    if (!this.started) return;
    const runnable = this.tasks.filter(t => ['pending', 'scheduled'].includes(t.status) && !['manual_hold', 'awaiting_confirmation', 'interrupted'].includes(t.condition ?? '') && t.nextRunAt !== null && this.dependenciesReady(t) && !this.dependenciesFailed(t) && !this.active.has(t.id) && ![...this.active.values()].some(a => a.sessionId === t.sessionId));
    if (!runnable.length) return;
    const next = Math.min(...runnable.map(t => t.nextRunAt!));
    this.timer = setTimeout(() => this.pump(), Math.min(MAX_TIMER, Math.max(0, next - Date.now()))).unref();
  }
  private pump() {
    if (!this.started || this.closed) return;
    for (const task of this.tasks) {
      if (!['pending', 'scheduled'].includes(task.status) || ['manual_hold', 'awaiting_confirmation', 'interrupted'].includes(task.condition ?? '') || !this.dependenciesReady(task) || task.nextRunAt === null || task.nextRunAt > Date.now() || this.active.has(task.id) || [...this.active.values()].some(a => a.sessionId === task.sessionId)) continue;
      if (task.steps[task.currentStep].requiresConfirmation && task.confirmedStep !== task.currentStep) {
        const updated = this.change(task.id, t => { t.status = 'pending'; t.condition = 'awaiting_confirmation'; t.nextRunAt = null; this.log(t, 'awaiting_confirmation'); }); this.emit(updated, 'awaiting_confirmation'); continue;
      }
      const controller = new AbortController();
      const running = this.change(task.id, t => {
        t.status = 'running'; t.condition = null; t.nextRunAt = null; t.attempts++;
        this.log(t, 'running', `Attempt ${t.attempts} of ${t.maxAttempts}`);
      });
      this.active.set(task.id, { controller, sessionId: task.sessionId });
      this.emit(running, 'running'); void this.execute(running, controller);
    }
    this.arm();
  }
  private async execute(task: SchedulerTask, controller: AbortController) {
    try {
      const cwd = await this.options.checkTarget(task.sessionId, task.workspaceId, task);
      if (controller.signal.aborted) return;
      if (cwd && !task.targetCwd) {
        task = this.change(task.id, t => { t.targetCwd = cwd; });
      }
      await this.options.executor(copy(task), copy(task.steps[task.currentStep]), controller.signal, (event, message) => {
        if (!this.closed && this.tasks.find(t => t.id === task.id)?.status === 'running') {
          const updated = this.change(task.id, t => this.log(t, event, message));
          this.emit(updated, event);
        }
      });
      if (controller.signal.aborted || this.get(task.id).status !== 'running') return;
      const updated = this.change(task.id, t => {
        this.log(t, 'step_completed'); t.currentStep++; t.attempts = 0; delete t.confirmedStep;
        if (t.currentStep === t.steps.length) { t.status = 'done'; t.nextRunAt = null; this.log(t, 'completed', undefined, t.currentStep - 1); }
        else { t.status = 'pending'; t.nextRunAt = Date.now(); }
      }); this.emit(updated, updated.status === 'done' ? 'completed' : 'step_completed');
    } catch (error) {
      if (!controller.signal.aborted && this.tasks.find(t => t.id === task.id)?.status === 'running') {
        const busy = error instanceof SessionBusy;
        const updated = this.change(task.id, t => {
          const message = error instanceof Error ? error.message : String(error);
          if (busy) {
            if (t.logs.at(-1)?.event === 'running') t.logs.pop();
            t.attempts--;
            t.status = 'scheduled';
            t.nextRunAt = Date.now() + BUSY_DELAY_MS;
            if (t.logs.at(-1)?.event !== 'target_busy') this.log(t, 'target_busy', message);
          } else {
            this.log(t, 'error', message);
            if ((error as { retryable?: boolean })?.retryable !== false && t.attempts < t.maxAttempts) {
              t.status = t.retryDelayMs ? 'scheduled' : 'pending'; t.nextRunAt = Date.now() + t.retryDelayMs;
              this.log(t, 'retry', `Attempt ${t.attempts} of ${t.maxAttempts} failed. Next run in ${t.retryDelayMs} ms.`);
            } else {
              t.status = 'failed'; t.nextRunAt = null; this.log(t, 'failed', message);
            }
          }
        });
        this.emit(updated, busy ? 'target_busy' : updated.status === 'failed' ? 'failed' : 'retry');
      }
    } finally { this.active.delete(task.id); this.arm(); }
  }
}

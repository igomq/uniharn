import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { HarnessRegistry } from './harnesses/registry.js';
import { formatScopedSessionId } from './harnesses/registry.js';
import type { Session } from './sessions.js';
import { incompleteTurn } from './sessions.js';
import {
  currentModeChoice,
  delegationApprovalProblem,
  effortOptionOf,
  findModeChoice,
  modelOptionOf,
  optionValueIds,
  recommendedDelegationMode,
  type SubagentSettings,
} from './subagents.js';

const execFileAsync = promisify(execFile);
type Json = any;

export type LinkKind = 'handoff' | 'delegate';
export type LinkStatus = 'running' | 'done' | 'error';

export interface SessionLink {
  id: string;
  kind: LinkKind;
  parentSessionId: string;
  childSessionId: string;
  harnessId: string;
  task: string;
  cwd: string;
  worktree: string | null;
  branch: string | null;
  /** Model the subagent was started with; null means the harness default. */
  model?: string | null;
  /** Git HEAD the session (or its worktree) started from; null outside a git repo. */
  baseSha?: string | null;
  /** Settings actually in effect on the child before its first prompt. */
  applied?: AppliedSettings;
  status: LinkStatus;
  output: string | null;
  stopReason: string | null;
  error: string | null;
  /** True when uniharn cancelled the child session (e.g. after a wait timeout). */
  cancelled?: boolean;
  /** Snapshot of the child's latest event and tool call, taken when the turn ended. */
  lastActivity?: Json | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppliedSettings {
  model: string | null;
  mode: string | null;
  config: Record<string, string | boolean>;
}

export type LinkSummary = Pick<
  SessionLink,
  'id' | 'kind' | 'parentSessionId' | 'childSessionId' | 'harnessId' | 'model' | 'status' | 'worktree' | 'branch' | 'createdAt' | 'updatedAt'
> & { title: string };

export interface LinkFilter {
  sessionId?: string;
  status?: string;
  id?: string;
}

export interface DelegationGroup {
  signal: AbortSignal;
  pending: Set<Promise<void>>;
  children: Set<string>;
}

interface DelegationOptions {
  cwd?: string;
  worktree?: boolean;
  includeContext?: boolean;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
  instruction?: string;
  prelude?: string;
  subagentModel?: string | null;
  envAllowlist?: string[];
  group?: DelegationGroup;
}

export const linkTitle = (task: string) => task.split('\n')[0].slice(0, 120);

/** A link without its task, output and error text, for cheap polling. */
export function summarizeLink(l: SessionLink): LinkSummary {
  return {
    id: l.id,
    kind: l.kind,
    parentSessionId: l.parentSessionId,
    childSessionId: l.childSessionId,
    harnessId: l.harnessId,
    model: l.model ?? null,
    status: l.status,
    title: linkTitle(l.task),
    worktree: l.worktree,
    branch: l.branch,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

/** Short contract prepended to every subagent prompt so workers keep the baseline and verification rules. */
export function delegationContract(link: SessionLink, applied: AppliedSettings | undefined): string {
  const settings = [applied?.model ? `model=${applied.model}` : null, applied?.mode ? `mode=${applied.mode}` : null, ...Object.entries(applied?.config ?? {}).map(([k, v]) => `${k}=${v}`)]
    .filter(Boolean)
    .join(', ');
  return [
    '[uniharn delegation contract]',
    `Task id: ${link.id}`,
    `Kind: ${link.kind}`,
    `Harness: ${link.harnessId}${settings ? ` (${settings})` : ''}`,
    `Work path: ${link.cwd}`,
    `Base SHA: ${link.baseSha ?? 'unknown'}`,
    `Branch: ${link.branch ?? 'n/a'}`,
    `Scope: stay inside the work path${link.branch ? ` and branch ${link.branch}` : ''}; if the task or transcript names owned files, interfaces, or verification commands, treat them as fixed. Before finishing, run the narrowest relevant verification and report the exact commands and results.`,
  ].join('\n') + '\n';
}

function text(content: Json): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(text).join('');
  return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

/** The first user message, kept separately because the transcript window can drop it. */
function firstUserText(s: Session, maxChars = 2000): string {
  let out = '';
  let seen = false;
  for (const { update: u } of s.events) {
    if (u?.sessionUpdate === 'user_message_chunk') {
      seen = true;
      out += text(u.content);
      if (out.length >= maxChars) break;
      continue;
    }
    if (seen) break;
  }
  return out.trim().slice(0, maxChars);
}

/** Renders a session's event log as a compact markdown transcript, keeping the newest part within `maxChars`. */
export function buildTranscript(s: Session, maxChars = 12000): string {
  const turns: { role: string; text: string }[] = [];
  const add = (role: string, t: string) => {
    if (!t) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += t;
    else turns.push({ role, text: t });
  };
  for (const { update: u } of s.events) {
    switch (u?.sessionUpdate) {
      case 'user_message_chunk':
        add('User', text(u.content));
        break;
      case 'agent_message_chunk':
        add('Assistant', text(u.content));
        break;
      case 'tool_call':
        if (u.title) add('Tool', `- ${u.title}\n`);
        break;
    }
  }
  let out = turns.map((t) => `**${t.role}:** ${t.text.trim()}`).join('\n\n');
  if (out.length > maxChars) out = '…\n' + out.slice(out.length - maxChars);
  return out;
}

/** Text of the agent's messages after the most recent user message. */
export function lastAgentReply(s: Session): string {
  let reply = '';
  for (const { update: u } of s.events) {
    if (u?.sessionUpdate === 'user_message_chunk') reply = '';
    else if (u?.sessionUpdate === 'agent_message_chunk') reply += text(u.content);
  }
  return reply.trim();
}

/** Compact child-session events after `sinceSeq`, for incremental delegation polling. */
function compactEvents(s: Session | undefined, sinceSeq: number, limit = 100, endSeq?: number): Json[] {
  if (!s) return [];
  const after = Math.max(0, sinceSeq);
  const n = Math.min(Math.max(0, limit), 500);
  return s.events
    .filter((e) => e.seq > after && (endSeq === undefined || e.seq <= endSeq))
    .slice(0, n)
    .map((e) => {
      const u = e.update ?? {};
      const kind = u.sessionUpdate ?? null;
      const out: Json = { seq: e.seq, at: e.at, sessionUpdate: kind };
      if (u.title) out.title = u.title;
      if (u.status) out.status = u.status;
      if (u.toolCallId) out.toolCallId = u.toolCallId;
      if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
        const t = text(u.content);
        if (t) out.text = t.length > 1000 ? `${t.slice(0, 1000)}…` : t;
      }
      if (kind === '_turn_end' && u.stopReason) out.stopReason = u.stopReason;
      if (kind === '_turn_error' && u.message) out.message = String(u.message).slice(0, 500);
      return out;
    });
}

/** Resolves when the turn started after event `afterSeq` ends; rejects on a turn error or timeout. */
export function waitForTurn(s: Session, afterSeq: number, timeoutMs = 60 * 60 * 1000, pollMs = 100): Promise<string | null> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      for (let i = s.events.length - 1; i >= 0 && s.events[i].seq > afterSeq; i--) {
        const u = s.events[i].update;
        if (u?.sessionUpdate === '_turn_end') return resolve(u.stopReason ?? null);
        if (u?.sessionUpdate === '_turn_error') return reject(new Error(u.message ?? 'Turn failed'));
      }
      if (Date.now() - started > timeoutMs) return reject(Object.assign(new Error('Timed out waiting for the subagent'), { _timeout: true }));
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function buildHandoffPrompt(fromHarness: string, s: Session, instruction?: string): string {
  const opening = firstUserText(s);
  return [
    `You are continuing a coding session handed off from the ${fromHarness} harness in ${s.cwd}.`,
    opening ? `Opening request (constraints agreed earlier):\n${opening}` : null,
    'Transcript so far (newest last):',
    '',
    buildTranscript(s) || '(empty)',
    '',
    instruction?.trim() ? `Next instruction: ${instruction.trim()}` : 'Continue the work from where it stopped.',
  ]
    .filter((x): x is string => !!x)
    .join('\n');
}

/** HEAD commit of the repo containing `cwd`, or null when it is not a git repo. */
export async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Current branch of the repo containing `cwd`, or null when it is not a git repo or is detached. */
export async function gitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current'], { timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const offeredText = (values: string[]) => (values.length > 20 ? `${values.slice(0, 20).join(', ')}, … ${values.length - 20} more` : values.join(', '));
const duration = (ms: number) => (ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`);

/** A session's latest event and tool call, for link `lastActivity`. Status-only tool updates keep the title of their tool call. */
function activityOf(s: Session | undefined | null): Json | null {
  if (!s) return null;
  const last = s.events[s.events.length - 1];
  const tool = [...s.events].reverse().find((e) => e.update?.sessionUpdate === 'tool_call' || e.update?.sessionUpdate === 'tool_call_update');
  // Status-only or content-only updates lack the other field; backfill each from the most
  // recent earlier event carrying it with the same toolCallId.
  const earlier = tool?.update?.toolCallId ? [...s.events].reverse().filter((e) => e !== tool && e.update?.toolCallId === tool.update.toolCallId) : [];
  const toolTitle = tool?.update?.title ?? earlier.find((e) => e.update?.title)?.update?.title ?? null;
  const toolStatus = tool?.update?.status ?? earlier.find((e) => e.update?.status)?.update?.status ?? null;
  return {
    updatedAt: s.updatedAt,
    running: s.running > 0,
    lastEvent: last ? { seq: last.seq, sessionUpdate: last.update?.sessionUpdate ?? null, ...(last.update?.title ? { title: last.update.title } : {}) } : null,
    lastTool: tool ? { title: toolTitle, status: toolStatus } : null,
  };
}

export async function createWorktree(repoCwd: string, id: string, checkPath?: (path: string) => string): Promise<{ path: string; branch: string; baseSha: string | null }> {
  const { stdout } = await execFileAsync('git', ['-C', repoCwd, 'rev-parse', '--show-toplevel'], { timeout: 10000 });
  const top = stdout.trim();
  const branch = `uniharn/sub-${id}`;
  const path = join(top, '.uniharn', 'worktrees', id);
  checkPath?.(top);
  checkPath?.(path);
  const { stdout: gitDir } = await execFileAsync('git', ['-C', top, 'rev-parse', '--git-common-dir'], { timeout: 10000 });
  const exclude = join(resolve(top, gitDir.trim()), 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('/.uniharn/')) appendFileSync(exclude, (current && !current.endsWith('\n') ? '\n' : '') + '/.uniharn/\n');
  const baseSha = await gitHead(top);
  await execFileAsync('git', ['-C', top, 'worktree', 'add', '-b', branch, path], { timeout: 60000 });
  return { path, branch, baseSha };
}

/** Removes a worktree and its branch created by {@link createWorktree}. */
export async function removeWorktree(repoCwd: string, wt: { path: string; branch: string }) {
  await execFileAsync('git', ['-C', repoCwd, 'worktree', 'remove', '--force', wt.path], { timeout: 60000 }).catch(() => undefined);
  await execFileAsync('git', ['-C', repoCwd, 'branch', '-D', wt.branch], { timeout: 10000 }).catch(() => undefined);
}

/**
 * Cross-harness coordination: hands a session's context to another harness and runs
 * subagent tasks on any harness, optionally isolated in a git worktree.
 */
export class Orchestrator extends EventEmitter {
  private links = new Map<string, SessionLink>();
  /** Child sessions started by this process, kept after completion so detail() can keep serving compact progress events without a session/load. */
  private children = new Map<string, Session>();
  /** Last event seq belonging to the delegation turn, so later chat turns on the same session are not reported as progress. */
  private eventEnd = new Map<string, number>();
  private delegationGroups = new Map<string, DelegationGroup>();
  private file: string;
  /** How long a delegation waits for the child's turn before cancelling it. */
  turnTimeoutMs = 60 * 60 * 1000;

  constructor(private registry: HarnessRegistry, dataDir: string, private settings: SubagentSettings | null = null, private paths?: {
    loadSource: (sessionId: string) => Promise<{ harnessId: string; session: Session }>;
    check: (cwd: string) => string;
  }) {
    super();
    this.registry.on('deleted', (sessionId: string) => this.forgetSession(sessionId));
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'orchestration.json');
    if (existsSync(this.file)) {
      try {
        for (const l of JSON.parse(readFileSync(this.file, 'utf8')).links ?? []) {
          if (l.status === 'running') Object.assign(l, { status: 'error', error: 'Gateway restarted before the task finished' });
          this.links.set(l.id, l);
        }
      } catch {
        // A corrupt file must not stop the gateway.
      }
    }
  }

  private save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ links: [...this.links.values()] }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private update(link: SessionLink, patch: Partial<SessionLink>) {
    if (patch.status === 'done' || patch.status === 'error') {
      const child = this.children.get(link.id);
      if (child) this.eventEnd.set(link.id, child.seq);
    }
    Object.assign(link, patch, { updatedAt: Date.now() });
    this.save();
    this.emit('link', { ...link });
    if (link.kind === 'delegate' && !this.delegationGroups.has(link.childSessionId) && (patch.status === 'done' || patch.status === 'error')) {
      this.registry.emit('subagent_completed', {
        taskId: link.id,
        harnessId: link.harnessId,
        title: linkTitle(link.task),
        parentSessionId: link.parentSessionId,
        ok: link.status === 'done',
        summary: (link.error ?? link.output ?? '').slice(0, 500),
      });
    }
  }

  /** Drops live child references when the session itself is deleted, so progress polling cannot resurrect it. */
  private forgetSession(sessionId: string) {
    for (const link of this.links.values()) {
      if (link.childSessionId === sessionId) {
        this.children.delete(link.id);
        this.eventEnd.delete(link.id);
      }
    }
  }

  list(sessionId?: string, filter: Omit<LinkFilter, 'sessionId'> = {}): SessionLink[] {
    return [...this.links.values()]
      .filter((l) => !sessionId || l.parentSessionId === sessionId || l.childSessionId === sessionId)
      .filter((l) => (!filter.status || l.status === filter.status) && (!filter.id || l.id === filter.id))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  summaries(filter: LinkFilter = {}): LinkSummary[] {
    return this.list(filter.sessionId, filter).map(summarizeLink);
  }

  get(id: string): SessionLink | undefined {
    return this.links.get(id);
  }

  /** One link with its child's latest activity — live for running tasks, the snapshot taken at finish otherwise. */
  async detail(id: string, opts: { sinceSeq?: number; limit?: number } = {}): Promise<(SessionLink & { lastActivity: Json; events?: Json[] }) | undefined> {
    const link = this.links.get(id);
    if (!link) return undefined;
    const lastActivity = link.lastActivity ?? activityOf(this.children.get(id));
    const events = typeof opts.sinceSeq === 'number' ? compactEvents(this.children.get(id), opts.sinceSeq, opts.limit ?? 100, this.eventEnd.get(id)) : undefined;
    return { ...link, lastActivity, ...(events ? { events } : {}) };
  }

  /**
   * Sessions that only exist as the child of a delegation with a live parent chat, in the scoped
   * form the app lists them under. Delegations without a parent session, or whose parent is gone,
   * stay in the session list so their transcripts remain reachable.
   */
  delegatedSessionIds(existingParents?: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const l of this.links.values()) {
      if (l.kind !== 'delegate' || !l.parentSessionId || !l.childSessionId) continue;
      if (existingParents && !existingParents.has(l.parentSessionId)) continue;
      out.add(l.childSessionId);
    }
    return out;
  }

  private async source(sessionId: string) {
    if (this.paths) return this.paths.loadSource(sessionId);
    const { adapter, harnessId, nativeId } = this.registry.resolveSession(sessionId);
    const s = await adapter.ensureLoaded(nativeId);
    return { harnessId, session: s };
  }

  /**
   * Applies the persisted per-harness delegation policy before the first prompt and returns the config it set.
   * Config values the current model does not offer are skipped: harnesses like Devin and Vibe change their
   * effort/speed options per model, and sending a stale value fails with `Invalid params`.
   */
  private async applyDelegationPolicy(child: Session, harnessId: string, modeOverride?: string | null): Promise<Record<string, string | boolean>> {
    const policy = this.settings?.policy(harnessId) ?? { mode: null, config: {}, enabled: true };
    if (!policy.enabled) throw new Error(`Delegation to ${harnessId} is disabled in Settings > Subagents`);
    const adapter = this.registry.require(harnessId);
    const applyMode = async (choice: Json) => {
      if (choice?.source === 'config') await adapter.setConfigOption(child.sessionId, choice.configId, String(choice.value ?? choice.id));
      else await adapter.setMode(child.sessionId, String(choice?.id ?? choice?.value));
    };
    const selectedMode = modeOverride ?? policy.mode;
    if (selectedMode) {
      const choice = findModeChoice(child.configOptions, child.modes, selectedMode);
      if (!choice) throw new Error(`${harnessId} does not offer delegation mode ${selectedMode}`);
      await applyMode(choice);
    } else {
      const recommended = recommendedDelegationMode(child.configOptions, child.modes);
      if (recommended) await applyMode(recommended);
    }
    const problem = delegationApprovalProblem(child.configOptions, child.modes);
    if (problem) throw new Error(`Delegation to ${harnessId} is unavailable: it ${problem}`);
    const applied: Record<string, string | boolean> = {};
    for (const [configId, value] of Object.entries(policy.config)) {
      const opt = (child.configOptions ?? []).find((o: Json) => o?.id === configId || o?.configId === configId);
      if (!opt) continue;
      const boolean = typeof opt.currentValue === 'boolean' || opt.type === 'boolean';
      const v = boolean ? value === true || value === 'true' : String(value);
      const offered = optionValueIds(opt);
      if (!boolean && offered.length && !offered.includes(v as string)) continue;
      await adapter.setConfigOption(child.sessionId, opt.id ?? configId, v);
      applied[opt.id ?? configId] = v;
    }
    return applied;
  }

  /** Best-effort removal of a child session whose setup failed before its link existed. */
  private async discardChildSession(harnessId: string, sessionId: string) {
    const adapter = this.registry.require(harnessId);
    await adapter.deleteSession(sessionId).catch(() => adapter.closeSession(sessionId).catch(() => undefined));
  }

  private async start(
    kind: LinkKind,
    parentSessionId: string,
    harnessId: string,
    cwd: string,
    task: string,
    prompt: string,
    worktree: { path: string; branch: string; baseSha?: string | null } | null,
    model: string | null = null,
    effort: string | null = null,
    mode?: string | null,
    prelude?: string,
    envAllowlist?: string[],
    subagentModel?: string | null,
    group?: DelegationGroup,
  ) {
    group?.signal.throwIfAborted();
    const adapter = this.registry.require(harnessId);
    const child = await this.registry.createSession(harnessId, worktree?.path ?? cwd, { prelude, envAllowlist, subagentModel });
    let applied: AppliedSettings;
    try {
      // The model goes first: the effort and speed options a harness offers can depend on it.
      if (model) {
        const opt = modelOptionOf(child.configOptions);
        if (!opt) throw new Error(`${harnessId} does not offer a model choice`);
        const offered = optionValueIds(opt);
        if (offered.length && !offered.includes(model)) throw new Error(`${harnessId} does not offer model ${model} (offered: ${offeredText(offered)})`);
        await adapter.setConfigOption(child.sessionId, opt.id, model);
      }
      const config = kind === 'delegate' ? await this.applyDelegationPolicy(child, harnessId, mode) : {};
      if (effort) {
        const opt = effortOptionOf(child.configOptions);
        if (!opt) throw new Error(`${harnessId} does not offer a reasoning effort choice${model ? ` for model ${model}` : ''}`);
        const offered = optionValueIds(opt);
        if (!offered.includes(effort)) throw new Error(`${harnessId} does not offer effort ${effort}${model ? ` for model ${model}` : ''} (offered: ${offeredText(offered)})`);
        await adapter.setConfigOption(child.sessionId, opt.id, effort);
        config[opt.id] = effort;
      }
      const currentMode = currentModeChoice(child.configOptions, child.modes);
      const current = modelOptionOf(child.configOptions)?.currentValue;
      applied = { model: typeof current === 'string' ? current : model, mode: currentMode ? String(currentMode.value ?? currentMode.id ?? '') || null : null, config };
    } catch (e) {
      await this.discardChildSession(harnessId, child.sessionId);
      throw e;
    }
    const [branch, baseSha] = worktree
      ? [worktree.branch, worktree.baseSha ?? null]
      : await Promise.all([gitBranch(cwd), gitHead(cwd)]);
    if (group?.signal.aborted) {
      await this.discardChildSession(harnessId, child.sessionId);
      group.signal.throwIfAborted();
    }
    const now = Date.now();
    const link: SessionLink = {
      id: randomUUID(),
      kind,
      parentSessionId,
      childSessionId: formatScopedSessionId(harnessId, child.sessionId),
      harnessId,
      task,
      cwd: worktree?.path ?? cwd,
      worktree: worktree?.path ?? null,
      branch,
      model,
      baseSha,
      applied,
      status: 'running',
      output: null,
      stopReason: null,
      error: null,
      cancelled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.links.set(link.id, link);
    this.children.set(link.id, child);
    try {
      this.save();
    } catch (error) {
      this.links.delete(link.id);
      this.children.delete(link.id);
      await this.discardChildSession(harnessId, child.sessionId);
      throw error;
    }
    if (group) {
      group.children.add(link.childSessionId);
      this.delegationGroups.set(link.childSessionId, group);
    }
    this.emit('link', { ...link });
    const promptText = `${delegationContract(link, applied)}\n${prompt}`;
    const before = child.seq;
    const timeoutMs = this.turnTimeoutMs;
    if (group) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([group.signal, timeout]);
      const done = adapter.promptAndWait(child.sessionId, promptText, signal).then(() => {
        if (signal.aborted) throw signal.reason;
        this.update(link, { status: 'done', output: lastAgentReply(child), stopReason: child.lastStopReason, lastActivity: activityOf(child) });
      }).catch(error => {
        const message = timeout.aborted ? `Timed out after ${duration(timeoutMs)}` : group.signal.aborted ? 'Scheduled team execution was canceled' : String(error?.message ?? error);
        const cancelled = signal.aborted && child.lastStopReason === 'cancelled';
        this.update(link, { status: 'error', error: message, stopReason: child.lastStopReason, cancelled, output: lastAgentReply(child) || null, lastActivity: activityOf(child) });
      });
      return { link, done };
    }
    const done = adapter
      .prompt(child.sessionId, promptText)
      .then(() => waitForTurn(child, before, timeoutMs))
      .then((stopReason) => {
        const error = stopReason === 'cancelled' ? 'Subagent turn was cancelled before it finished' : incompleteTurn(stopReason)?.message;
        const output = lastAgentReply(child);
        const lastActivity = activityOf(child);
        this.update(link, error ? { status: 'error', error, output: output || null, stopReason, lastActivity } : { status: 'done', output, stopReason, lastActivity });
      })
      .catch(async (e) => {
        if (!e?._timeout) return this.update(link, { status: 'error', error: `Subagent turn failed: ${String(e?.message ?? e)}`, output: lastAgentReply(child) || null, lastActivity: activityOf(child) });
        const cancelError = await adapter.cancel(child.sessionId).then(
          () => null,
          (err) => String(err?.message ?? err),
        );
        // `session/cancel` only asks the harness to stop; the turn is confirmed ended when a
        // _turn_end arrives — a non-timeout rejection (_turn_error) also means it ended.
        const confirmed = cancelError ? false : await waitForTurn(child, before, 15_000).then(() => true, (err) => !err?._timeout);
        this.update(link, {
          status: 'error',
          stopReason: 'timeout',
          cancelled: confirmed,
          error: `Timed out after ${duration(timeoutMs)}; ${cancelError ? `cancelling the subagent session failed: ${cancelError}` : confirmed ? 'subagent session was cancelled' : 'a cancel was sent but the subagent session did not stop'}`,
          output: lastAgentReply(child) || null,
          lastActivity: activityOf(child),
        });
      });
    return { link, done };
  }

  /** Starts a new session on `targetHarnessId` that continues `sessionId` with its transcript as context. */
  async handoff(sessionId: string, targetHarnessId: string, instruction?: string) {
    const { harnessId, session } = await this.source(sessionId);
    const prompt = buildHandoffPrompt(harnessId, session, instruction);
    return this.start('handoff', sessionId, targetHarnessId, session.cwd, instruction ?? '', prompt, null);
  }

  /**
   * Runs `task` as a subagent on `harnessId`, in `opts.cwd` (else the parent's folder)
   * or in an isolated worktree of it. `model: null` runs on the harness default model;
   * omitting it uses the default subagent model.
   */
  delegate(
    parentSessionId: string | null,
    harnessId: string,
    task: string,
    opts: DelegationOptions = {},
  ) {
    const group = opts.group ?? (parentSessionId ? this.delegationGroups.get(parentSessionId) : undefined);
    const launch = this.launchDelegation(parentSessionId, harnessId, task, opts, group);
    if (group) {
      const pending = launch.then(({ done }) => done).then(() => undefined, () => undefined);
      group.pending.add(pending);
      void pending.then(() => group.pending.delete(pending));
    }
    return launch;
  }

  async drainDelegations(group: DelegationGroup) {
    while (group.pending.size) await Promise.all(group.pending);
    for (const child of group.children) this.delegationGroups.delete(child);
  }

  private async launchDelegation(parentSessionId: string | null, harnessId: string, task: string, opts: DelegationOptions, group?: DelegationGroup) {
    group?.signal.throwIfAborted();
    if (!task.trim()) throw new Error('task is required');
    if (this.settings && !this.settings.policy(harnessId).enabled) {
      throw new Error(`Delegation to ${harnessId} is disabled in Settings > Subagents`);
    }
    const parent = parentSessionId ? await this.source(parentSessionId) : null;
    const requestedCwd = opts.cwd ?? parent?.session.cwd;
    if (!requestedCwd) throw new Error('sessionId or cwd is required');
    const cwd = this.paths?.check(requestedCwd) ?? requestedCwd;
    const wt = opts.worktree ? await createWorktree(cwd, randomUUID().slice(0, 8), this.paths?.check) : null;
    const roleTask = opts.instruction ? `Role instruction: ${opts.instruction}\n\n${task}` : task;
    const prompt = parent && opts.includeContext ? buildHandoffPrompt(parent.harnessId, parent.session, roleTask) : roleTask;
    try {
      const inheritedModel = opts.subagentModel !== undefined ? opts.subagentModel : parent?.session.options?.subagentModel;
      const model = opts.model === undefined ? (inheritedModel ?? this.settings?.defaultModel(harnessId) ?? null) : opts.model || null;
      const prelude = opts.prelude ?? parent?.session.options?.prelude;
      const envAllowlist = opts.envAllowlist ?? parent?.session.options?.envAllowlist;
      return await this.start('delegate', parentSessionId ?? '', harnessId, cwd, task, prompt, wt, model, opts.effort || null, opts.mode, prelude, envAllowlist, inheritedModel, group);
    } catch (e) {
      if (wt) await removeWorktree(cwd, wt);
      throw e;
    }
  }
}

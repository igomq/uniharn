import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessRegistry } from './harnesses/registry.js';
import type { DelegationGroup, Orchestrator } from './orchestrator.js';

export interface ProjectProfile {
  id: string;
  name: string;
  cwd: string;
  workspaceId?: string | null;
  harnessId: string;
  model?: string | null;
  subagentModel?: string | null;
  prelude?: string;
  envAllowlist?: string[];
  commonCommands?: string[];
  defaultBranch?: string | null;
  gitWorkflowNotes?: string;
}
export interface TeamRole {
  name: string;
  harnessId: string;
  model?: string | null;
  mode?: string | null;
  effort?: string | null;
  instruction?: string;
}
export interface Team { id: string; name: string; roles: TeamRole[]; cwd?: string; profileId?: string | null }

const UNSAFE_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|CDPATH|GLOBIGNORE|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/i;
export function safeEnvAllowlist(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('envAllowlist must be an array of environment variable names');
  return [...new Set(value.map((key) => {
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || UNSAFE_ENV.test(key)) throw new Error(`Unsafe environment variable name: ${String(key)}`);
    return key;
  }))];
}
function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
function optional(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}
function profile(input: any, checkPath: (cwd: string) => string): Omit<ProjectProfile, 'id'> {
  const prelude = optional(input.prelude, 'prelude');
  if (input.commonCommands !== undefined && (!Array.isArray(input.commonCommands) || input.commonCommands.some((x: unknown) => typeof x !== 'string'))) throw new Error('commonCommands must be an array of strings');
  return { name: required(input.name, 'name'), cwd: checkPath(required(input.cwd, 'cwd')), harnessId: required(input.harnessId, 'harnessId'),
    workspaceId: optional(input.workspaceId, 'workspaceId'), model: optional(input.model, 'model'), subagentModel: optional(input.subagentModel, 'subagentModel'),
    ...(prelude != null ? { prelude } : {}), envAllowlist: safeEnvAllowlist(input.envAllowlist),
    commonCommands: input.commonCommands ?? [], defaultBranch: optional(input.defaultBranch, 'defaultBranch'),
    gitWorkflowNotes: optional(input.gitWorkflowNotes, 'gitWorkflowNotes') ?? undefined };
}
function team(input: any, checkPath: (cwd: string) => string): Omit<Team, 'id'> {
  if (!Array.isArray(input.roles) || !input.roles.length) throw new Error('roles must contain at least one role');
  const roles = input.roles.map((r: any) => ({ name: required(r?.name, 'role.name'), harnessId: required(r?.harnessId, 'role.harnessId'), model: optional(r?.model, 'role.model'), mode: optional(r?.mode, 'role.mode'), effort: optional(r?.effort, 'role.effort'), instruction: optional(r?.instruction, 'role.instruction') ?? undefined }));
  return { name: required(input.name, 'name'), roles, ...(input.cwd ? { cwd: checkPath(required(input.cwd, 'cwd')) } : {}), profileId: optional(input.profileId, 'profileId') };
}
class Store<T extends { id: string }> {
  private items = new Map<string, T>();
  private file: string;
  constructor(dataDir: string, file: string, private normalize: (input: any) => Omit<T, 'id'>) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, file);
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data)) throw new Error(`Invalid ${file}`);
      for (const item of data) if (typeof item?.id === 'string') this.items.set(item.id, item);
    }
  }
  private save(next: Map<string, T>) {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify([...next.values()], null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
    this.items = next;
  }
  list(): T[] { return structuredClone([...this.items.values()]); }
  get(id: string): T | undefined { const item = this.items.get(id); return item ? structuredClone(item) : undefined; }
  create(input: Omit<T, 'id'>): T {
    const item = { ...this.normalize(input), id: randomUUID() } as T;
    const next = new Map(this.items); next.set(item.id, item); this.save(next); return structuredClone(item);
  }
  update(id: string, patch: Partial<Omit<T, 'id'>>): T {
    const previous = this.items.get(id); if (!previous) throw new Error(`Preset not found: ${id}`);
    const item = { ...this.normalize({ ...previous, ...patch }), id } as T;
    const next = new Map(this.items); next.set(id, item); this.save(next); return structuredClone(item);
  }
  delete(id: string): boolean { if (!this.items.has(id)) return false; const next = new Map(this.items); next.delete(id); this.save(next); return true; }
}
export class ProfileStore extends Store<ProjectProfile> {
  constructor(dataDir: string, checkPath: (cwd: string) => string = (cwd) => cwd) { super(dataDir, 'profiles.json', (x) => profile(x, checkPath)); }
}
export class TeamStore extends Store<Team> {
  constructor(dataDir: string, checkPath: (cwd: string) => string = (cwd) => cwd) { super(dataDir, 'teams.json', (x) => team(x, checkPath)); }
}
export function profilePrelude(profile: ProjectProfile): string {
  return [profile.prelude, profile.gitWorkflowNotes && `Git workflow: ${profile.gitWorkflowNotes}`, profile.defaultBranch && `Default branch: ${profile.defaultBranch}`, profile.commonCommands?.length && `Common commands:\n${profile.commonCommands.join('\n')}`].filter(Boolean).join('\n\n');
}
export async function launchProfile(registry: HarnessRegistry, profile: ProjectProfile, checkPath: (cwd: string) => string, mode?: string) {
  return registry.createSession(profile.harnessId, checkPath(profile.cwd), { model: profile.model ?? undefined, subagentModel: profile.subagentModel, prelude: profilePrelude(profile), mode, envAllowlist: profile.envAllowlist });
}
type StartedRole = Awaited<ReturnType<Orchestrator['delegate']>>;

export async function launchTeam(orchestrator: Orchestrator, team: Team, task: string, cwd: string, checkPath: (cwd: string) => string, parentSessionId: string | null = null, profile?: ProjectProfile, options?: {
  group: DelegationGroup;
  model?: string;
  onLaunch: (role: TeamRole, started: StartedRole) => void;
}) {
  const workPath = checkPath(cwd);
  const prelude = profile ? profilePrelude(profile) : undefined;
  const launched = [];
  for (const role of team.roles) {
    try {
      const started = await orchestrator.delegate(parentSessionId, role.harnessId, task, { cwd: workPath, model: options?.model ?? role.model, mode: role.mode, effort: role.effort, instruction: role.instruction, prelude, subagentModel: profile?.subagentModel, envAllowlist: profile?.envAllowlist, group: options?.group });
      launched.push(started);
      options?.onLaunch(role, started);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Team launch failed at role ${role.name}: ${message}; started task IDs: ${launched.map(({ link }) => link.id).join(', ') || 'none'}`, { cause: error });
    }
  }
  return launched;
}


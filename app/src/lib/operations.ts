// Project profiles, teams, scheduled tasks and usage: shapes shared by the gateway calls and the screens,
// plus the pure helpers the reactive store in api.svelte.ts uses. Profile and team fields follow
// gateway/src/presets.ts; scheduled tasks follow gateway/src/scheduler.ts.
import type { Json } from './types.ts';
import type { UsageReport } from './usage.ts';

/** A project folder with the harness, models and context every session started from it gets. */
export interface Profile {
  id: string;
  name: string;
  cwd: string;
  /** When set, the workspace's folder must be `cwd`. */
  workspaceId?: string | null;
  harnessId: string;
  model?: string | null;
  subagentModel?: string | null;
  /** Sent ahead of the first prompt, followed by the git notes, default branch and common commands. */
  prelude?: string;
  envAllowlist?: string[];
  commonCommands?: string[];
  defaultBranch?: string | null;
  gitWorkflowNotes?: string;
}
export type ProfileInput = Omit<Profile, 'id'>;

/** One delegated session a team starts for the same task. */
export interface TeamRole {
  name: string;
  harnessId: string;
  model?: string | null;
  mode?: string | null;
  effort?: string | null;
  instruction?: string;
}

/** Roles started together on one task, in an optional default folder and profile. */
export interface Team {
  id: string;
  name: string;
  roles: TeamRole[];
  cwd?: string;
  profileId?: string | null;
}
export type TeamInput = Omit<Team, 'id'>;

export type ScheduledTaskStatus = 'pending' | 'scheduled' | 'running' | 'done' | 'failed' | 'canceled';
/** The fields the store and shared screens read; the scheduled tasks screen owns the rest of the shape. */
export type ScheduledTask = { id: string; title: string; sessionId: string; status: ScheduledTaskStatus; updatedAt: number } & Record<string, Json>;

export interface OperationsState {
  profiles: Profile[];
  teams: Team[];
  tasks: ScheduledTask[];
  usage: UsageReport | null;
  /** Whether this gateway answered `profiles.list` (older gateways have no profiles or teams). */
  loaded: boolean;
}

export function emptyOperations(): OperationsState {
  return { profiles: [], teams: [], tasks: [], usage: null, loaded: false };
}

/** Screens a `uniharn:operations` event or a notification can open. */
export const OPERATION_SCREENS = ['tasks', 'usage', 'profiles', 'teams'] as const;
export type OperationScreen = (typeof OPERATION_SCREENS)[number];

/** The screen a `uniharn:operations` event asks to open: a screen name as the detail, or `{ open: name }`. */
export function operationScreen(detail: unknown): OperationScreen | null {
  const name = typeof detail === 'string' ? detail : (detail as { open?: unknown } | null)?.open;
  return OPERATION_SCREENS.find((screen) => screen === name) ?? null;
}

/**
 * Where opening a notification goes. Scheduled task notifications (dedup key `scheduler:<task>:…`) open the
 * Tasks screen for their session; the gateway's own route points at the session itself.
 */
export function notificationRoute(n: { route: string | null; dedupKey: string; sessionId: string | null }) {
  if (!n.dedupKey.startsWith('scheduler:')) return n.route;
  return '#/tasks' + (n.sessionId ? '?session=' + encodeURIComponent(n.sessionId) : '');
}

/** What the new-session button starts with: a bare harness or a saved profile. */
export type SessionChoice = { kind: 'harness'; harnessId: string } | { kind: 'profile'; profileId: string };

/** Stored as `harness:<id>` or `profile:<id>`; a bare id is a harness, as older versions saved it. */
export function parseSessionChoice(saved: string | null | undefined): SessionChoice {
  if (saved?.startsWith('profile:')) return { kind: 'profile', profileId: saved.slice('profile:'.length) };
  const harnessId = saved?.startsWith('harness:') ? saved.slice('harness:'.length) : saved;
  return { kind: 'harness', harnessId: harnessId || 'devin' };
}

export function sessionChoiceKey(choice: SessionChoice) {
  return choice.kind === 'profile' ? `profile:${choice.profileId}` : `harness:${choice.harnessId}`;
}

/**
 * `sessions.create` params for the chosen harness or profile. A harness needs a folder (null: no project);
 * a profile starts in its own folder unless another one is given, which a workspace-bound profile refuses.
 */
export function newSessionParams(cwd: string | null, choice: SessionChoice, profiles: Profile[]): Json {
  if (choice.kind === 'harness') return cwd ? { cwd, harnessId: choice.harnessId } : { noProject: true, harnessId: choice.harnessId };
  const profile = profiles.find((p) => p.id === choice.profileId);
  if (!profile) throw new Error('That profile no longer exists. Pick another one.');
  const elsewhere = cwd !== null && cwd !== profile.cwd;
  if (elsewhere && profile.workspaceId) throw new Error(`${profile.name} is tied to its workspace folder. Start it from the New session button.`);
  return { ...(elsewhere ? { cwd } : {}), harnessId: profile.harnessId, profileId: profile.id };
}

/** A profile as its edit form holds it: lists become text with one entry per line. */
export interface ProfileForm {
  name: string;
  cwd: string;
  workspaceId: string;
  harnessId: string;
  model: string;
  subagentModel: string;
  prelude: string;
  envAllowlist: string;
  commonCommands: string;
  defaultBranch: string;
  gitWorkflowNotes: string;
}

export function profileForm(profile: Partial<ProfileInput> = {}): ProfileForm {
  return {
    name: profile.name ?? '',
    cwd: profile.cwd ?? '',
    workspaceId: profile.workspaceId ?? '',
    harnessId: profile.harnessId ?? 'devin',
    model: profile.model ?? '',
    subagentModel: profile.subagentModel ?? '',
    prelude: profile.prelude ?? '',
    envAllowlist: (profile.envAllowlist ?? []).join('\n'),
    commonCommands: (profile.commonCommands ?? []).join('\n'),
    defaultBranch: profile.defaultBranch ?? '',
    gitWorkflowNotes: profile.gitWorkflowNotes ?? ''
  };
}

/**
 * The gateway input for a filled-in form. Every field is sent, so an update clears what the form emptied:
 * optional ids and models become null, text becomes '' and lists drop blank lines.
 */
export function profileInput(form: ProfileForm): ProfileInput {
  const orNull = (value: string) => value.trim() || null;
  return {
    name: form.name.trim(),
    cwd: form.cwd.trim(),
    workspaceId: orNull(form.workspaceId),
    harnessId: form.harnessId,
    model: orNull(form.model),
    subagentModel: orNull(form.subagentModel),
    prelude: form.prelude.trim(),
    envAllowlist: [...new Set(form.envAllowlist.split(/[\s,]+/).filter(Boolean))],
    commonCommands: form.commonCommands.split('\n').map((line) => line.trim()).filter(Boolean),
    defaultBranch: orNull(form.defaultBranch),
    gitWorkflowNotes: form.gitWorkflowNotes.trim()
  };
}

/** Why a profile cannot be saved yet, or null. Mirrors the gateway's required fields and workspace rule. */
export function profileProblem(input: ProfileInput, workspaces: { workspaceId: string; cwd: string }[]): string | null {
  if (!input.name) return 'Give the profile a name.';
  if (!input.cwd) return 'Pick the project folder.';
  if (!input.harnessId) return 'Pick a harness.';
  const ws = input.workspaceId ? workspaces.find((w) => w.workspaceId === input.workspaceId) : null;
  if (input.workspaceId && !ws) return 'That workspace no longer exists.';
  if (ws && ws.cwd !== input.cwd) return 'The folder must be the workspace folder.';
  const badEnv = input.envAllowlist?.find((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  if (badEnv) return `${badEnv} is not an environment variable name.`;
  return null;
}

export function blankRole(harnessId: string): TeamRole {
  return { name: '', harnessId, model: null, mode: null, effort: null, instruction: '' };
}

/** The gateway input for a team form: trimmed text, blank options as null, no default folder when empty. */
export function teamInput(team: { name: string; cwd?: string; profileId?: string | null; roles: TeamRole[] }): TeamInput {
  const orNull = (value: string | null | undefined) => value?.trim() || null;
  return {
    name: team.name.trim(),
    roles: team.roles.map((r) => ({ name: r.name.trim(), harnessId: r.harnessId, model: orNull(r.model), mode: orNull(r.mode), effort: orNull(r.effort), instruction: r.instruction?.trim() ?? '' })),
    cwd: team.cwd?.trim() ?? '',
    profileId: orNull(team.profileId)
  };
}

/** Why a team cannot be saved yet, or null. Mirrors the gateway: a name and at least one named role with a harness. */
export function teamProblem(team: TeamInput, profiles: Profile[]): string | null {
  if (!team.name) return 'Give the team a name.';
  if (!team.roles.length) return 'Add at least one role.';
  if (team.roles.some((r) => !r.name)) return 'Name every role.';
  if (team.roles.some((r) => !r.harnessId)) return 'Pick a harness for every role.';
  if (team.profileId && !profiles.some((p) => p.id === team.profileId)) return 'That profile no longer exists.';
  return null;
}

/** The folder a team starts in when none is picked: its own, then its profile's. */
export function teamFolder(team: Team, profiles: Profile[]) {
  return team.cwd || profiles.find((p) => p.id === team.profileId)?.cwd || '';
}

/** Teams that use a profile, so deleting it can say which teams would lose it. */
export function teamsUsingProfile(profileId: string, teams: Team[]) {
  return teams.filter((t) => t.profileId === profileId);
}

/** The list with `item` replacing the entry that has its id, or added first. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list];
}

export function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((x) => x.id !== id);
}

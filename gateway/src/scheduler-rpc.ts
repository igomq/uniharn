import { formatScopedSessionId, loadSessionInPath, type HarnessRegistry } from './harnesses/registry.js';
import { statSync } from 'node:fs';
import { SessionBusy } from './harnesses/types.js';
import type { Workspace, WorkspaceStore } from './workspaces.js';
import { launchTeam, profilePrelude, type ProfileStore, type TeamRole, type TeamStore } from './presets.js';
import type { DelegationGroup, Orchestrator, SessionLink } from './orchestrator.js';
import { modelOptionOf, optionValueIds } from './subagents.js';
import { Scheduler, type SchedulerOptions } from './scheduler.js';

/** RPC facade: unknown methods return undefined, as with the other gateway RPC modules. */
export function createSchedulerRpc(dataDir: string, options: SchedulerOptions) {
  const scheduler = new Scheduler(dataDir, options);
  const id = (p: any) => { const value = p?.taskId ?? p?.id; if (typeof value !== 'string' || !value.trim()) throw new Error('taskId is required'); return value; };
  return {
    scheduler,
    start: () => scheduler.start(),
    close: () => scheduler.close(),
    handle(type: string, p: any): Promise<any> | undefined {
      if (!['scheduler.list', 'scheduler.create', 'scheduler.update', 'scheduler.delete', 'scheduler.cancel', 'scheduler.release', 'scheduler.confirm'].includes(type)) return undefined;
      return Promise.resolve().then(async () => {
        switch (type) {
          case 'scheduler.list': return { tasks: scheduler.list().filter(task => (!p?.workspaceId || task.workspaceId === p.workspaceId) && (!p?.sessionId || task.sessionId === p.sessionId)) };
          case 'scheduler.create': return { task: await scheduler.create(p.task ?? p) };
          case 'scheduler.update': return { task: await scheduler.update(id(p), p.patch ?? p.task ?? p) };
          case 'scheduler.delete': return { task: scheduler.delete(id(p)) };
          case 'scheduler.cancel': return { task: scheduler.cancel(id(p)) };
          case 'scheduler.release': return { task: scheduler.release(id(p)) };
          case 'scheduler.confirm': return { task: scheduler.confirm(id(p)) };
        }
      });
    },
  };
}

/** Resolve live presets and checked session paths on both admission and execution. */
export function gatewaySchedulerOptions(registry: HarnessRegistry, workspaces: WorkspaceStore, checkPath: (path: string) => string, notify: NonNullable<SchedulerOptions['notify']>, presets?: { profiles: ProfileStore; teams: TeamStore; orchestrator: Orchestrator }): SchedulerOptions {
  async function target(sessionId: string, workspaceId?: string, selection?: Parameters<SchedulerOptions['checkTarget']>[2]) {
    const team = selection?.team ? presets?.teams.get(selection.team) : undefined;
    if (selection?.team && !team) throw new Error('Team not found');
    const profileId = selection?.profile ?? team?.profileId;
    const profile = profileId ? presets?.profiles.get(profileId) : undefined;
    if (profileId && !profile) throw new Error('Profile not found');
    if (workspaceId && profile?.workspaceId && profile.workspaceId !== workspaceId) throw new Error('Profile workspace does not match the task');

    const { adapter, harnessId, nativeId } = registry.resolveSession(sessionId);
    if (!adapter.info().enabled) throw new Error(`Harness ${harnessId} is disabled`);
    const scopedId = formatScopedSessionId(harnessId, nativeId);
    if (selection?.harness && selection.harness !== harnessId) throw new Error('Harness does not match the selected session');
    const belongs = (workspace: Workspace) => workspace.sessions.some(s => s.sessionId === scopedId && s.harnessId === harnessId);
    const requestedWorkspace = workspaceId ?? profile?.workspaceId;
    const workspace = requestedWorkspace ? workspaces.get(requestedWorkspace) : workspaces.list().find(belongs);
    if (requestedWorkspace && (!workspace || !belongs(workspace))) throw new Error('Session does not belong to workspace');
    const executionPath = (path: string) => {
      const cwd = checkPath(path);
      if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Scheduled target folder is missing or is not a directory');
      if (selection?.targetCwd && cwd !== selection.targetCwd) throw new Error('Scheduled target folder changed');
      return cwd;
    };
    const loaded = await loadSessionInPath(registry, sessionId, executionPath, workspace?.cwd ?? selection?.targetCwd);
    if (loaded.session.folderMissing) throw new Error('Scheduled target folder was recreated after being deleted');
    if (loaded.session.subagent) throw new Error('Native subagent sessions cannot be scheduled');
    if (team?.cwd && checkPath(team.cwd) !== loaded.cwd) throw new Error('Team folder does not match the session');
    if (profile) {
      if (checkPath(profile.cwd) !== loaded.cwd) throw new Error('Profile folder does not match the session');
      if (!team && profile.harnessId !== harnessId) throw new Error('Profile harness does not match the session');
      if (!team && profile.envAllowlist?.length && JSON.stringify([...profile.envAllowlist].sort()) !== JSON.stringify([...(loaded.session.options.envAllowlist ?? [])].sort())) throw new Error('Profile environment does not match the selected session');
    }
    if (team) for (const role of team.roles) {
      if (!registry.require(role.harnessId).info().enabled) throw new Error(`Harness ${role.harnessId} is disabled`);
    }
    return { ...loaded, team, profile };
  }

  return {
    checkTarget: async (sessionId, workspaceId, selection) => (await target(sessionId, workspaceId, selection)).cwd,
    notify,
    executor: async (task, step, signal, log) => {
      const { adapter, nativeId, session, cwd, team, profile } = await target(task.sessionId, task.workspaceId, task);
      if (signal.aborted) return;
      if (team && presets) {
        const controller = new AbortController();
        const group: DelegationGroup = { signal: AbortSignal.any([signal, controller.signal]), pending: new Set(), children: new Set() };
        const roles: { role: TeamRole; link: SessionLink }[] = [];
        let launchError: Error | undefined;
        try {
          await launchTeam(presets.orchestrator, team, step.prompt, cwd, checkPath, task.sessionId, profile, {
            group,
            model: task.model,
            onLaunch(role, { link }) {
              roles.push({ role, link });
              log('role_started', `${role.name} (${role.harnessId}): ${link.id}`);
            },
          });
        } catch (error) {
          launchError = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        }
        await presets.orchestrator.drainDelegations(group);
        if (signal.aborted) return;
        const failures = [];
        for (const { role, link } of roles) {
          if (link.status === 'done') log('role_completed', `${role.name}: ${link.id}`);
          else {
            log('role_failed', `${role.name}: ${link.error ?? link.stopReason ?? 'Role failed'} (${link.id})`);
            failures.push(role.name);
          }
        }
        if (launchError) throw Object.assign(launchError, { retryable: roles.length === 0 });
        if (failures.length) throw Object.assign(new Error(`Scheduled team failed at role(s): ${failures.join(', ')}`), { retryable: false });
        return;
      }

      if (session.running || session.permissions.size) throw new SessionBusy('Target session is busy');
      const selectedModel = task.model ?? profile?.model;
      if (selectedModel) {
        const model = modelOptionOf(session.configOptions);
        if (!model) throw Object.assign(new Error('Target session does not support model selection'), { retryable: false });
        const offered = optionValueIds(model);
        if (offered.length && !offered.includes(selectedModel)) throw Object.assign(new Error(`Target session does not offer model ${selectedModel}`), { retryable: false });
        if (model.currentValue !== selectedModel) await adapter.setConfigOption(nativeId, model.id, selectedModel);
      }
      if (signal.aborted) return;
      await adapter.promptAndWait(nativeId, step.prompt, signal, profile ? profilePrelude(profile) : undefined);
    },
  };
}

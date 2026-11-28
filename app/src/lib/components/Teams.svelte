<script lang="ts">
  import { untrack } from 'svelte';
  import { app, conn, errorText, openSession, ops, rpc } from '#lib/api.svelte.ts';
  import { go, route, toast } from '#lib/ui.svelte.ts';
  import { outdatedGateway } from '#lib/accounts.ts';
  import { shortPath } from '#lib/format.ts';
  import { shortHarnessName } from '#lib/labels.ts';
  import { blankRole, teamFolder, teamInput, teamProblem, type Team, type TeamRole } from '#lib/operations.ts';
  import type { SessionLink } from '#lib/types.ts';
  import BackButton from './BackButton.svelte';
  import DirPicker from './DirPicker.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      await Promise.all([rpc('teams.list'), rpc('profiles.list')]);
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    } finally {
      loading = false;
    }
    // Delegation modes per harness; the role editor falls back to free text without them.
    if (!app.subagentSettings.length) rpc('subagents.get').catch(() => {});
  }
  $effect(() => {
    if (route.name === 'teams' && conn.status === 'online' && conn.generation) untrack(load);
  });

  let online = $derived(conn.status === 'online');
  let usableHarnesses = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  let harnessName = (id: string) => app.harnesses.find((h) => h.id === id)?.name ?? id;
  let profileName = (id: string | null | undefined) => ops.profiles.find((p) => p.id === id)?.name ?? null;
  let teams = $derived([...ops.teams].sort((a, b) => a.name.localeCompare(b.name)));
  let modelsOf = (harnessId: string) => app.harnesses.find((h) => h.id === harnessId)?.models ?? [];
  let effortsOf = (role: TeamRole) => modelsOf(role.harnessId).find((m) => m.id === role.model)?.reasoningLevels ?? [];
  let modesOf = (harnessId: string) => (app.subagentSettings.find((s) => s.harnessId === harnessId)?.modes ?? []).filter((m) => m.id);

  // Team editor.
  type Draft = { name: string; cwd: string; profileId: string; roles: TeamRole[] };
  let editOpen = $state(false);
  let editingId = $state<string | null>(null);
  let draft = $state<Draft>({ name: '', cwd: '', profileId: '', roles: [] });
  let saving = $state(false);
  let confirmDelete = $state(false);
  let browsingFor = $state<'team' | 'start' | null>(null);
  let browsing = $state(false);
  let problem = $derived(teamProblem(teamInput(draft), ops.profiles));

  function openNew() {
    editingId = null;
    draft = { name: '', cwd: '', profileId: '', roles: [blankRole(usableHarnesses[0]?.id ?? 'devin')] };
    confirmDelete = false;
    editOpen = true;
  }
  function openEdit(t: Team) {
    editingId = t.id;
    draft = { name: t.name, cwd: t.cwd ?? '', profileId: t.profileId ?? '', roles: t.roles.map((r) => ({ ...blankRole(r.harnessId), ...r })) };
    confirmDelete = false;
    editOpen = true;
  }
  function pickHarness(role: TeamRole, id: string) {
    // Model, effort and mode belong to the harness they were chosen for.
    role.harnessId = id;
    role.model = null;
    role.effort = null;
    role.mode = null;
  }
  function pickModel(role: TeamRole, id: string) {
    role.model = id || null;
    if (role.effort && !effortsOf(role).includes(role.effort)) role.effort = null;
  }
  function moveRole(i: number, by: number) {
    const roles = [...draft.roles];
    [roles[i], roles[i + by]] = [roles[i + by], roles[i]];
    draft.roles = roles;
  }

  async function save() {
    if (problem) return toast(problem, 'error');
    const team = teamInput(draft);
    saving = true;
    try {
      if (editingId) await rpc('teams.update', { teamId: editingId, patch: team });
      else await rpc('teams.create', { team });
      editOpen = false;
      toast(editingId ? 'Team saved' : 'Team created');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      saving = false;
    }
  }
  async function remove() {
    if (!editingId) return;
    saving = true;
    try {
      await rpc('teams.delete', { teamId: editingId });
      editOpen = false;
      toast('Team deleted');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      saving = false;
    }
  }

  // Start sheet: one delegated session per role on the same task.
  let startOpen = $state(false);
  let startTeam = $state<Team | null>(null);
  let startForm = $state({ task: '', cwd: '', profileId: '', sessionId: '' });
  let startingTeam = $state(false);
  let parents = $derived(app.sessions.filter((s) => s.cwd && s.cwd === startForm.cwd));

  function openStart(t: Team) {
    startTeam = t;
    startForm = { task: '', cwd: teamFolder(t, ops.profiles), profileId: t.profileId ?? '', sessionId: '' };
    startOpen = true;
  }
  function pickStartProfile(id: string) {
    startForm.profileId = id;
    const profile = ops.profiles.find((p) => p.id === id);
    if (profile && !startTeam?.cwd) startForm.cwd = profile.cwd;
  }
  async function start() {
    const t = startTeam;
    if (!t) return;
    if (!startForm.task.trim()) return toast('Describe the task for the team.', 'error');
    if (!startForm.cwd.trim()) return toast('Pick the folder the team works in.', 'error');
    startingTeam = true;
    try {
      const links = (await rpc('teams.start', {
        teamId: t.id,
        task: startForm.task.trim(),
        cwd: startForm.cwd.trim(),
        profileId: startForm.profileId || undefined,
        sessionId: startForm.sessionId || undefined
      })) as SessionLink[];
      startOpen = false;
      toast(links.length === 1 ? 'Started 1 role' : 'Started ' + links.length + ' roles');
      const target = startForm.sessionId || links[0]?.childSessionId;
      if (target) {
        await openSession(target).catch(() => {});
        go('#/s/' + encodeURIComponent(target));
      }
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      startingTeam = false;
    }
  }

  function browse(target: 'team' | 'start') {
    browsingFor = target;
    browsing = true;
  }
  function picked(path: string) {
    browsing = false;
    if (browsingFor === 'team') draft.cwd = path;
    else startForm.cwd = path;
  }

  function summary(t: Team) {
    const roles = t.roles.map((r) => r.name + ' (' + shortHarnessName(harnessName(r.harnessId)) + ')').join(', ');
    const where = profileName(t.profileId) ?? (t.cwd ? shortPath(t.cwd, conn.info?.home) : null);
    return [roles, where].filter(Boolean).join(' · ');
  }
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to="#/" />
    <div class="title"><b>Teams</b></div>
    <button class="iconbtn glass" onclick={openNew} disabled={!online || !!loadError} aria-label="New team" title="New team"><Icon name="plus" /></button>
  </header>
  <main class="scroller">
    <div class="column">
      {#if loadError}
        <p class="muted detail bad">{outdatedGateway(conn.info, loadError) ?? loadError}</p>
      {:else if loading && !teams.length}
        <div class="empty"><span class="spinner" style="margin:auto"></span></div>
      {:else if !teams.length}
        <div class="empty">
          <h2>No teams yet</h2>
          <p>A team runs one task with several roles at once, each on its own harness, model, effort and mode.</p>
          <button class="btn primary" onclick={openNew} disabled={!online}><Icon name="plus" size={18} /> New team</button>
        </div>
      {:else}
        <div class="card list">
          {#each teams as t (t.id)}
            <div class="trow">
              <button class="ttext press" onclick={() => openEdit(t)} aria-label="Edit {t.name}">
                <b>{t.name}</b>
                <small>{summary(t)}</small>
              </button>
              <button class="btn startbtn" onclick={() => openStart(t)} disabled={!online}><Icon name="play" size={15} /> Start</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </main>
</div>

<Sheet bind:open={editOpen} title={editingId ? 'Edit team' : 'New team'} tall>
  <form class="form" onsubmit={(e) => (e.preventDefault(), save())}>
    <label class="field">
      <span>Name</span>
      <input bind:value={draft.name} placeholder="Build and review" autocomplete="off" />
    </label>
    <label class="field">
      <span>Profile</span>
      <select bind:value={draft.profileId}>
        <option value="">None</option>
        {#each ops.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        {#if draft.profileId && !profileName(draft.profileId)}<option value={draft.profileId}>Deleted profile</option>{/if}
      </select>
      <small>Roles get the profile's instructions, subagent model and environment.</small>
    </label>
    <div class="field">
      <span>Default folder</span>
      <div class="pathrow">
        <input bind:value={draft.cwd} placeholder={profileName(draft.profileId) ? "Profile's folder" : '~/code/project'} autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Default folder" />
        <button class="btn" type="button" onclick={() => browse('team')} disabled={!online}><Icon name="folder" size={18} /></button>
      </div>
    </div>

    <div class="rolehead"><span>Roles</span></div>
    {#each draft.roles as role, i (i)}
      {@const models = modelsOf(role.harnessId)}
      {@const efforts = effortsOf(role)}
      {@const modes = modesOf(role.harnessId)}
      <fieldset class="role card">
        <legend class="sr-only">Role {i + 1}</legend>
        <div class="rolebar">
          <input class="rolename" bind:value={role.name} placeholder="Role name" aria-label="Role {i + 1} name" autocomplete="off" />
          <button class="mini" type="button" onclick={() => moveRole(i, -1)} disabled={i === 0} aria-label="Move role up"><Icon name="down" size={16} /></button>
          <button class="mini" type="button" onclick={() => (draft.roles = draft.roles.filter((_, j) => j !== i))} disabled={draft.roles.length === 1} aria-label="Remove role"><Icon name="trash" size={16} /></button>
        </div>
        <div class="grid">
          <label class="field">
            <span>Harness</span>
            <select value={role.harnessId} onchange={(e) => pickHarness(role, e.currentTarget.value)}>
              {#each usableHarnesses as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
              {#if !usableHarnesses.some((h) => h.id === role.harnessId)}<option value={role.harnessId}>{harnessName(role.harnessId)} (unavailable)</option>{/if}
            </select>
          </label>
          <label class="field">
            <span>Model</span>
            {#if models.length}
              <select value={role.model ?? ''} onchange={(e) => pickModel(role, e.currentTarget.value)}>
                <option value="">Default</option>
                {#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
                {#if role.model && !models.some((m) => m.id === role.model)}<option value={role.model}>{role.model}</option>{/if}
              </select>
            {:else}
              <input value={role.model ?? ''} oninput={(e) => (role.model = e.currentTarget.value)} placeholder="Default" autocapitalize="off" autocorrect="off" spellcheck="false" />
            {/if}
          </label>
          <label class="field">
            <span>Effort</span>
            {#if efforts.length}
              <select value={role.effort ?? ''} onchange={(e) => (role.effort = e.currentTarget.value || null)}>
                <option value="">Default</option>
                {#each efforts as level (level)}<option value={level}>{level}</option>{/each}
                {#if role.effort && !efforts.includes(role.effort)}<option value={role.effort}>{role.effort}</option>{/if}
              </select>
            {:else}
              <input value={role.effort ?? ''} oninput={(e) => (role.effort = e.currentTarget.value)} placeholder="Default" autocapitalize="off" autocorrect="off" spellcheck="false" />
            {/if}
          </label>
          <label class="field">
            <span>Mode</span>
            {#if modes.length}
              <select value={role.mode ?? ''} onchange={(e) => (role.mode = e.currentTarget.value || null)}>
                <option value="">Default</option>
                {#each modes as m (m.id)}<option value={m.id}>{m.name ?? m.id}</option>{/each}
                {#if role.mode && !modes.some((m) => m.id === role.mode)}<option value={role.mode}>{role.mode}</option>{/if}
              </select>
            {:else}
              <input value={role.mode ?? ''} oninput={(e) => (role.mode = e.currentTarget.value)} placeholder="Default" autocapitalize="off" autocorrect="off" spellcheck="false" />
            {/if}
          </label>
        </div>
        <label class="field">
          <span>Instruction</span>
          <textarea bind:value={role.instruction} rows="2" placeholder="Review the change and report problems only"></textarea>
        </label>
      </fieldset>
    {/each}
    <button class="btn block" type="button" onclick={() => (draft.roles = [...draft.roles, blankRole(usableHarnesses[0]?.id ?? 'devin')])}><Icon name="plus" size={18} /> Add role</button>

    {#if problem && draft.name}<p class="muted detail bad">{problem}</p>{/if}
    <button class="btn primary block" type="submit" disabled={saving || !!problem || !online}>
      {#if saving}<span class="spinner"></span>{/if}{editingId ? 'Save' : 'Create team'}
    </button>
    {#if editingId}
      {#if confirmDelete}
        <button class="btn block danger" type="button" onclick={remove} disabled={saving}>Delete permanently</button>
        <button class="btn block" type="button" onclick={() => (confirmDelete = false)}>Keep team</button>
      {:else}
        <button class="btn block danger" type="button" onclick={() => (confirmDelete = true)}>Delete team</button>
      {/if}
    {/if}
  </form>
</Sheet>

<Sheet bind:open={startOpen} title={startTeam ? 'Start ' + startTeam.name : 'Start team'} tall>
  <form class="form" onsubmit={(e) => (e.preventDefault(), start())}>
    <label class="field">
      <span>Task</span>
      <textarea bind:value={startForm.task} rows="4" placeholder="What every role works on"></textarea>
    </label>
    <div class="field">
      <span>Folder</span>
      <div class="pathrow">
        <input bind:value={startForm.cwd} placeholder="~/code/project" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Folder" />
        <button class="btn" type="button" onclick={() => browse('start')} disabled={!online}><Icon name="folder" size={18} /></button>
      </div>
    </div>
    <label class="field">
      <span>Profile</span>
      <select value={startForm.profileId} onchange={(e) => pickStartProfile(e.currentTarget.value)}>
        <option value="">None</option>
        {#each ops.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </label>
    <label class="field">
      <span>Report to</span>
      <select bind:value={startForm.sessionId}>
        <option value="">No parent: list each role as a session</option>
        {#each parents as s (s.id)}<option value={s.id}>{s.title || 'New session'}</option>{/each}
      </select>
      <small>With a parent session the roles appear as its subagents. Only sessions in this folder are offered.</small>
    </label>
    {#if startTeam}
      <p class="muted detail">Starts {startTeam.roles.map((r) => r.name).join(', ')}.</p>
    {/if}
    <button class="btn primary block" type="submit" disabled={startingTeam || !online || !startForm.task.trim()}>
      {#if startingTeam}<span class="spinner"></span>{:else}<Icon name="play" size={16} />{/if} Start team
    </button>
  </form>
</Sheet>

<DirPicker bind:open={browsing} onpick={picked} />

<style>
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .list {
    margin-top: 12px;
    overflow: hidden;
  }
  .trow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 60px;
    padding-right: 10px;
  }
  .trow + .trow {
    border-top: 1px solid var(--line);
  }
  .ttext {
    flex: 1;
    min-width: 0;
    align-self: stretch;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 8px 0 8px 16px;
    text-align: left;
    color: var(--text);
  }
  .ttext b {
    font-size: 15.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ttext small {
    font-size: 12.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .startbtn {
    flex: none;
    min-height: 34px;
    padding: 0 12px;
    font-size: 13.5px;
    background: var(--accent-soft);
  }
  .empty .btn {
    margin-top: 16px;
  }
  .form {
    display: grid;
    gap: 2px;
  }
  .form > .btn {
    margin-top: 8px;
    background: var(--fill);
  }
  .form > .btn.primary {
    background: var(--accent);
  }
  .pathrow {
    display: flex;
    gap: 8px;
  }
  .pathrow input {
    flex: 1;
    min-width: 0;
  }
  .pathrow .btn {
    flex: none;
    min-height: 48px;
    padding: 0 14px;
    background: var(--fill);
  }
  .rolehead {
    margin: 10px 4px 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }
  .role {
    margin: 0 0 10px;
    padding: 10px 12px 0;
    border: 0;
    min-width: 0;
  }
  .rolebar {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 10px;
  }
  .rolename {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    padding: 0 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--bg-input);
    font-size: 16px;
    font-weight: 600;
  }
  .mini {
    flex: none;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-2);
  }
  .mini:first-of-type :global(svg) {
    transform: rotate(180deg);
  }
  .mini:disabled {
    opacity: 0.35;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 8px;
  }
  .grid .field {
    margin-bottom: 10px;
  }
  .grid .field select,
  .grid .field input {
    min-height: 42px;
    padding: 0 10px;
    font-size: 15px;
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 8px 4px 0;
  }
  .bad {
    color: var(--amber);
  }
</style>

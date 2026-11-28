<script lang="ts">
  import { untrack } from 'svelte';
  import { app, conn, errorText, openSession, ops, rpc } from '#lib/api.svelte.ts';
  import { go, route, toast } from '#lib/ui.svelte.ts';
  import { outdatedGateway } from '#lib/accounts.ts';
  import { shortPath } from '#lib/format.ts';
  import { shortHarnessName } from '#lib/labels.ts';
  import { newSessionParams, profileForm, profileInput, profileProblem, teamsUsingProfile, type Profile, type ProfileForm } from '#lib/operations.ts';
  import BackButton from './BackButton.svelte';
  import DirPicker from './DirPicker.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      await Promise.all([rpc('profiles.list'), rpc('teams.list')]);
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    if (route.name === 'profiles' && conn.status === 'online' && conn.generation) untrack(load);
  });

  let usableHarnesses = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  let harnessName = (id: string) => app.harnesses.find((h) => h.id === id)?.name ?? id;
  let profiles = $derived([...ops.profiles].sort((a, b) => a.name.localeCompare(b.name)));
  let online = $derived(conn.status === 'online');

  // The profile being edited; editingId is null for a new one.
  let sheetOpen = $state(false);
  let editingId = $state<string | null>(null);
  let form = $state<ProfileForm>(profileForm());
  let saving = $state(false);
  let confirmDelete = $state(false);
  let browsing = $state(false);
  let starting = $state<string | null>(null);

  function openNew() {
    editingId = null;
    form = profileForm({ harnessId: usableHarnesses[0]?.id ?? 'devin' });
    confirmDelete = false;
    sheetOpen = true;
  }
  function openEdit(p: Profile) {
    editingId = p.id;
    form = profileForm(p);
    confirmDelete = false;
    sheetOpen = true;
  }

  let models = $derived(app.harnesses.find((h) => h.id === form.harnessId)?.models ?? []);
  let workspace = $derived(app.workspaces.find((w) => w.workspaceId === form.workspaceId) ?? null);
  let affectedTeams = $derived(editingId ? teamsUsingProfile(editingId, ops.teams) : []);
  let problem = $derived(profileProblem(profileInput(form), app.workspaces));

  function pickHarness(id: string) {
    // Models belong to the harness they were chosen for.
    form.harnessId = id;
    form.model = '';
    form.subagentModel = '';
  }
  function pickWorkspace(id: string) {
    form.workspaceId = id;
    const ws = app.workspaces.find((w) => w.workspaceId === id);
    if (ws) form.cwd = ws.cwd;
  }
  function pickFolder(path: string) {
    form.cwd = path;
    // A workspace binding only holds while the folder is the workspace folder.
    if (workspace && workspace.cwd !== path) form.workspaceId = '';
  }

  async function save() {
    if (problem) return toast(problem, 'error');
    const profile = profileInput(form);
    saving = true;
    try {
      if (editingId) await rpc('profiles.update', { profileId: editingId, patch: profile });
      else await rpc('profiles.create', { profile });
      sheetOpen = false;
      toast(editingId ? 'Profile saved' : 'Profile created');
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
      await rpc('profiles.delete', { profileId: editingId });
      sheetOpen = false;
      toast('Profile deleted');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      saving = false;
    }
  }

  async function start(p: Profile) {
    starting = p.id;
    try {
      const r = await rpc('sessions.create', newSessionParams(null, { kind: 'profile', profileId: p.id }, ops.profiles));
      await openSession(r.id, r.cwd);
      go('#/s/' + encodeURIComponent(r.id));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      starting = null;
    }
  }

  function summary(p: Profile) {
    return [shortHarnessName(harnessName(p.harnessId)), p.model, shortPath(p.cwd, conn.info?.home)].filter(Boolean).join(' · ');
  }
</script>

{#snippet modelField(label: string, value: string, set: (v: string) => void, hint: string)}
  <label class="field">
    <span>{label}</span>
    {#if models.length}
      <select {value} onchange={(e) => set(e.currentTarget.value)}>
        <option value="">Harness default</option>
        {#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
        {#if value && !models.some((m) => m.id === value)}<option {value}>{value}</option>{/if}
      </select>
    {:else}
      <input {value} oninput={(e) => set(e.currentTarget.value)} placeholder="Harness default" autocapitalize="off" autocorrect="off" spellcheck="false" />
    {/if}
    <small>{hint}</small>
  </label>
{/snippet}

<div class="screen">
  <header class="topbar">
    <BackButton to="#/" />
    <div class="title"><b>Profiles</b></div>
    <button class="iconbtn glass" onclick={openNew} disabled={!online || !!loadError} aria-label="New profile" title="New profile"><Icon name="plus" /></button>
  </header>
  <main class="scroller">
    <div class="column">
      {#if loadError}
        <p class="muted detail bad">{outdatedGateway(conn.info, loadError) ?? loadError}</p>
      {:else if loading && !profiles.length}
        <div class="empty"><span class="spinner" style="margin:auto"></span></div>
      {:else if !profiles.length}
        <div class="empty">
          <h2>No profiles yet</h2>
          <p>A profile saves a project folder with its harness, models, standing instructions and git notes. Pick it when you start a session, a team or a task.</p>
          <button class="btn primary" onclick={openNew} disabled={!online}><Icon name="plus" size={18} /> New profile</button>
        </div>
      {:else}
        <div class="card list">
          {#each profiles as p (p.id)}
            <div class="prow">
              <button class="ptext press" onclick={() => openEdit(p)} aria-label="Edit {p.name}">
                <b>{p.name}</b>
                <small>{summary(p)}</small>
              </button>
              <button class="start" onclick={() => start(p)} disabled={!online || starting !== null} aria-label="Start a session with {p.name}" title="Start a session">
                {#if starting === p.id}<span class="spinner"></span>{:else}<Icon name="play" size={16} />{/if}
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </main>
</div>

<Sheet bind:open={sheetOpen} title={editingId ? 'Edit profile' : 'New profile'} tall>
  <form class="form" onsubmit={(e) => (e.preventDefault(), save())}>
    <label class="field">
      <span>Name</span>
      <input bind:value={form.name} placeholder="Web app" autocomplete="off" />
    </label>
    {#if app.workspaces.length}
      <label class="field">
        <span>Workspace</span>
        <select value={form.workspaceId} onchange={(e) => pickWorkspace(e.currentTarget.value)}>
          <option value="">None</option>
          {#each app.workspaces as w (w.workspaceId)}<option value={w.workspaceId}>{w.name}</option>{/each}
          {#if form.workspaceId && !workspace}<option value={form.workspaceId}>Deleted workspace</option>{/if}
        </select>
        <small>Sessions from a workspace profile join that workspace and must use its folder.</small>
      </label>
    {/if}
    <div class="field">
      <span>Project folder</span>
      <div class="pathrow">
        <input value={form.cwd} oninput={(e) => pickFolder(e.currentTarget.value)} placeholder="~/code/project" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Project folder" />
        <button class="btn" type="button" onclick={() => (browsing = true)} disabled={!online}><Icon name="folder" size={18} /> Browse</button>
      </div>
    </div>
    <label class="field">
      <span>Harness</span>
      <select value={form.harnessId} onchange={(e) => pickHarness(e.currentTarget.value)}>
        {#each usableHarnesses as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
        {#if !usableHarnesses.some((h) => h.id === form.harnessId)}<option value={form.harnessId}>{harnessName(form.harnessId)} (unavailable)</option>{/if}
      </select>
    </label>
    {@render modelField('Model', form.model, (v) => (form.model = v), 'The model new sessions start on.')}
    {@render modelField('Subagent model', form.subagentModel, (v) => (form.subagentModel = v), 'Used when these sessions start subagents.')}
    <label class="field">
      <span>Instructions</span>
      <textarea bind:value={form.prelude} rows="4" placeholder="Sent ahead of the first prompt"></textarea>
    </label>
    <label class="field">
      <span>Default branch</span>
      <input bind:value={form.defaultBranch} placeholder="main" autocapitalize="off" autocorrect="off" spellcheck="false" />
    </label>
    <label class="field">
      <span>Git workflow notes</span>
      <textarea bind:value={form.gitWorkflowNotes} rows="3" placeholder="Branch per feature, squash merge"></textarea>
    </label>
    <label class="field">
      <span>Common commands</span>
      <textarea class="mono" bind:value={form.commonCommands} rows="3" placeholder={'npm test\nnpm run build'} autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <small>One per line. Added to the instructions.</small>
    </label>
    <label class="field">
      <span>Environment variables</span>
      <textarea class="mono" bind:value={form.envAllowlist} rows="2" placeholder="GITHUB_TOKEN" autocapitalize="characters" autocorrect="off" spellcheck="false"></textarea>
      <small>Names only, one per line. Only these are passed from the gateway to the harness.</small>
    </label>
    {#if problem && form.name}<p class="muted detail bad">{problem}</p>{/if}
    <button class="btn primary block" type="submit" disabled={saving || !!problem || !online}>
      {#if saving}<span class="spinner"></span>{/if}{editingId ? 'Save' : 'Create profile'}
    </button>
    {#if editingId}
      {#if confirmDelete}
        {#if affectedTeams.length}<p class="muted detail bad">Used by {affectedTeams.map((t) => t.name).join(', ')}. Those teams cannot start until you pick another profile for them.</p>{/if}
        <button class="btn block danger" type="button" onclick={remove} disabled={saving}>Delete permanently</button>
        <button class="btn block" type="button" onclick={() => (confirmDelete = false)}>Keep profile</button>
      {:else}
        <button class="btn block danger" type="button" onclick={() => (confirmDelete = true)}>Delete profile</button>
      {/if}
    {/if}
  </form>
</Sheet>

<DirPicker bind:open={browsing} onpick={(path) => ((browsing = false), pickFolder(path))} />

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
  .prow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 60px;
    padding: 0 10px 0 0;
  }
  .prow + .prow {
    border-top: 1px solid var(--line);
  }
  .ptext {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-self: stretch;
    justify-content: center;
    padding: 8px 0 8px 16px;
    text-align: left;
    color: var(--text);
  }
  .ptext b {
    font-size: 15.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ptext small {
    font-size: 12.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .start {
    flex: none;
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--text);
  }
  .empty .btn {
    margin-top: 16px;
  }
  .form {
    display: grid;
    gap: 2px;
  }
  .form .btn {
    margin-top: 8px;
    background: var(--fill);
  }
  .form .btn.primary {
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
    margin: 0;
    min-height: 48px;
    padding: 0 14px;
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

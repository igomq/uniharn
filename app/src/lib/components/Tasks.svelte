<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { app, conn, errorText, ops, rpc } from '#lib/api.svelte.ts';
  import { go, route, toast } from '#lib/ui.svelte.ts';
  import { outdatedGateway } from '#lib/accounts.ts';
  import { shortHarnessName } from '#lib/labels.ts';
  import {
    CONDITION_LABEL,
    STATUS_LABEL,
    clockText,
    cyclicChoices,
    dependencyRows,
    dependents,
    draftFromTask,
    draftProblem,
    emptyDraft,
    lastResult,
    logLabel,
    normalizeTask,
    progressText,
    scheduleText,
    sortTasks,
    taskActions,
    taskInput,
    type Task,
    type TaskDraft,
    type When
  } from '#lib/scheduler.ts';
  import BackButton from './BackButton.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      await rpc('scheduler.list');
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    } finally {
      loading = false;
    }
    // Profiles and teams fill the editor's choices; older gateways without them still schedule tasks.
    Promise.allSettled([rpc('profiles.list'), rpc('teams.list')]);
  }
  $effect(() => {
    if (route.name === 'tasks' && conn.status === 'online' && conn.generation) untrack(load);
  });

  // Countdowns in the list move without a gateway push.
  let now = $state(Date.now());
  const clock = setInterval(() => (now = Date.now()), 15000);
  onDestroy(() => clearInterval(clock));

  let online = $derived(conn.status === 'online');
  let all = $derived(ops.tasks.map(normalizeTask));
  let sessionFilter = $derived(route.name === 'tasks' ? (route.id ?? null) : null);
  let sessionTitle = (id: string) => {
    const session = app.sessions.find((s) => s.id === id);
    if (session) return session.title || 'New session';
    return id ? 'Session ' + id.slice(-6) : 'No session';
  };
  let harnessName = (id: string | undefined) => app.harnesses.find((h) => h.id === id)?.name ?? id ?? '';

  type Filter = 'active' | 'attention' | 'finished' | 'all';
  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'active', label: 'Active' },
    { id: 'attention', label: 'Needs you' },
    { id: 'finished', label: 'Finished' },
    { id: 'all', label: 'All' }
  ];
  let filter = $state<Filter>('active');
  const needsYou = (t: Task) => t.condition === 'awaiting_confirmation' || t.condition === 'interrupted' || t.condition === 'dependency_failed' || t.condition === 'manual_hold' || t.status === 'failed';
  const finished = (t: Task) => t.status === 'done' || t.status === 'failed' || t.status === 'canceled';
  const matches: Record<Filter, (t: Task) => boolean> = { active: (t) => !finished(t), attention: needsYou, finished, all: () => true };
  let scoped = $derived(sessionFilter ? all.filter((t) => t.sessionId === sessionFilter) : all);
  let shown = $derived(sortTasks(scoped.filter(matches[filter])));
  let counts = $derived(Object.fromEntries(FILTERS.map((f) => [f.id, scoped.filter(matches[f.id]).length])) as Record<Filter, number>);

  // Detail sheet, kept on the live task so pushes update it in place.
  let detailOpen = $state(false);
  let detailId = $state<string | null>(null);
  let detail = $derived(all.find((t) => t.id === detailId) ?? null);
  let busy = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let confirming = $state<'cancel' | 'delete' | null>(null);
  let allLogs = $state(false);

  function openDetail(t: Task) {
    detailId = t.id;
    actionError = null;
    confirming = null;
    allLogs = false;
    detailOpen = true;
  }
  $effect(() => {
    // The task was deleted, here or on another device.
    if (detailOpen && detailId && !detail && !busy) detailOpen = false;
  });

  async function act(method: 'scheduler.confirm' | 'scheduler.release' | 'scheduler.cancel' | 'scheduler.delete', done: string) {
    const t = detail;
    if (!t) return;
    busy = method;
    actionError = null;
    try {
      await rpc(method, { taskId: t.id });
      confirming = null;
      toast(done);
      if (method === 'scheduler.delete') detailOpen = false;
    } catch (e) {
      actionError = errorText(e);
    } finally {
      busy = null;
    }
  }

  // Editor.
  let editOpen = $state(false);
  let editingId = $state<string | null>(null);
  let draft = $state<TaskDraft>(emptyDraft());
  let saving = $state(false);
  let editError = $state<string | null>(null);

  function openNew() {
    editingId = null;
    draft = emptyDraft(sessionFilter ?? app.sessions[0]?.id ?? '');
    editError = null;
    editOpen = true;
  }
  function openEdit(t: Task, copy = false) {
    editingId = copy ? null : t.id;
    draft = draftFromTask(t);
    if (copy) draft.title = t.title + ' (copy)';
    editError = null;
    detailOpen = false;
    editOpen = true;
  }

  let session = $derived(app.sessions.find((s) => s.id === draft.sessionId) ?? null);
  let sessionHarness = $derived(session?.harnessId ?? (draft.sessionId.includes(':') ? draft.sessionId.slice(0, draft.sessionId.indexOf(':')) : 'devin'));
  // The gateway refuses a profile or team whose folder or harness differs from the session's.
  let profileChoices = $derived(ops.profiles.filter((p) => !session?.cwd || (p.cwd === session.cwd && p.harnessId === sessionHarness)));
  let teamChoices = $derived(ops.teams.filter((t) => !session?.cwd || !t.cwd || t.cwd === session.cwd));
  let models = $derived(app.harnesses.find((h) => h.id === sessionHarness)?.models ?? []);
  let blocked = $derived(cyclicChoices(all, editingId));
  let dependencyChoices = $derived(all.filter((t) => !blocked.has(t.id) && t.id !== editingId));
  let problem = $derived(draftProblem(draft, now));

  function pickSession(id: string) {
    draft.sessionId = id;
    draft.profile = '';
    draft.team = '';
    draft.model = '';
  }
  function toggleDependency(id: string, on: boolean) {
    draft.dependencyIds = on ? [...draft.dependencyIds, id] : draft.dependencyIds.filter((x) => x !== id);
  }

  async function save() {
    if (problem) return (editError = problem);
    const input = taskInput(draft, sessionHarness);
    saving = true;
    editError = null;
    try {
      if (editingId) await rpc('scheduler.update', { taskId: editingId, patch: input });
      else await rpc('scheduler.create', { task: input });
      editOpen = false;
      toast(editingId ? 'Task saved' : 'Task scheduled');
    } catch (e) {
      editError = errorText(e);
    } finally {
      saving = false;
    }
  }

  const WHEN: { id: When; label: string }[] = [
    { id: 'immediate', label: 'Now' },
    { id: 'delay', label: 'Delay' },
    { id: 'at', label: 'At' },
    { id: 'manual', label: 'Hold' }
  ];
  const tone = (t: Task) =>
    t.status === 'running' ? 'running' : t.status === 'failed' || t.condition === 'dependency_failed' ? 'error' : needsYou(t) ? 'awaiting_permission' : '';
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to={sessionFilter ? '#/s/' + encodeURIComponent(sessionFilter) : '#/'} />
    <div class="title">
      <b>Tasks</b>
      {#if sessionFilter}<small>{sessionTitle(sessionFilter)}</small>{/if}
    </div>
    <button class="iconbtn glass" onclick={() => load()} disabled={loading || !online} aria-label="Refresh" title="Refresh"><Icon name="refresh" /></button>
    <button class="iconbtn glass" onclick={openNew} disabled={!online || !!loadError || !app.sessions.length} aria-label="New task" title="New task"><Icon name="plus" /></button>
  </header>
  <main class="scroller">
    <div class="column">
      <div class="filters" role="tablist" aria-label="Show">
        {#each FILTERS as f (f.id)}
          <button class="chip" class:on={filter === f.id} role="tab" aria-selected={filter === f.id} onclick={() => (filter = f.id)}>
            {f.label}{#if counts[f.id]}<span class="count">{counts[f.id]}</span>{/if}
          </button>
        {/each}
        {#if sessionFilter}
          <button class="chip on" onclick={() => go('#/tasks', true)} aria-label="Show tasks from every session"><Icon name="x" /> This session</button>
        {/if}
      </div>

      {#if loadError}
        <p class="muted detail bad">{outdatedGateway(conn.info, loadError) ?? loadError}</p>
      {:else if loading && !all.length}
        <div class="empty"><span class="spinner" style="margin:auto"></span></div>
      {:else if !shown.length}
        <div class="empty">
          {#if scoped.length}
            <h2>Nothing here</h2>
            <p>No {FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} tasks.</p>
          {:else}
            <h2>No tasks yet</h2>
            <p>A task sends one or more prompts to a session now, later or after other tasks finish. Steps that need your confirmation stop and wait.</p>
            <button class="btn primary" onclick={openNew} disabled={!online || !app.sessions.length}><Icon name="plus" size={18} /> New task</button>
          {/if}
        </div>
      {:else}
        <div class="card list">
          {#each shown as t (t.id)}
            <button class="trow press" onclick={() => openDetail(t)}>
              <span class="dot {tone(t)}"></span>
              <span class="ttext">
                <b>{t.title}</b>
                <small>{progressText(t, now)}{#if !sessionFilter} · {sessionTitle(t.sessionId)}{/if}</small>
              </span>
              <span class="tstatus" class:warn={needsYou(t)}>{t.condition && t.status !== 'running' ? CONDITION_LABEL[t.condition] : STATUS_LABEL[t.status]}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </main>
</div>

<Sheet bind:open={detailOpen} title={detail?.title ?? 'Task'} tall>
  {#if detail}
    {@const t = detail}
    {@const can = taskActions(t)}
    {@const deps = dependencyRows(t, all)}
    {@const waitingOnThis = dependents(all, t.id)}
    {@const result = lastResult(t)}
    <div class="dstate">
      <span class="dot {tone(t)}"></span>
      <b>{STATUS_LABEL[t.status]}</b>
      <span class="muted">{progressText(t, now)}</span>
    </div>

    {#if can.confirm}
      <div class="ask card">
        <p><b>Step {t.currentStep + 1} needs your confirmation</b></p>
        <p class="prompt">{t.steps[t.currentStep]?.prompt}</p>
        <button class="btn primary block" onclick={() => act('scheduler.confirm', 'Step confirmed')} disabled={!!busy || !online}>
          {#if busy === 'scheduler.confirm'}<span class="spinner"></span>{/if} Confirm and run
        </button>
      </div>
    {/if}
    {#if actionError}<p class="muted detail bad" role="alert">{actionError}</p>{/if}
    {#if result?.event === 'error' || result?.event === 'failed' || result?.event === 'interrupted'}
      <p class="muted detail bad">{logLabel(result.event)}{result.message ? ': ' + result.message : ''}</p>
    {/if}

    <div class="actions">
      {#if can.release}
        <button class="btn" onclick={() => act('scheduler.release', 'Task released')} disabled={!!busy || !online}>
          {#if busy === 'scheduler.release'}<span class="spinner"></span>{:else}<Icon name="play" size={16} />{/if} {t.condition === 'interrupted' ? 'Resume' : 'Release'}
        </button>
      {/if}
      {#if can.edit}<button class="btn" onclick={() => openEdit(t)} disabled={!online}><Icon name="edit" size={16} /> Edit</button>{/if}
      <button class="btn" onclick={() => openEdit(t, true)} disabled={!online}><Icon name="copy" size={16} /> Duplicate</button>
      <button class="btn" onclick={() => ((detailOpen = false), go('#/s/' + encodeURIComponent(t.sessionId)))}><Icon name="external" size={16} /> Session</button>
    </div>

    <div class="label">Details</div>
    <div class="card kvs">
      <div class="kv"><span>Session</span><b>{sessionTitle(t.sessionId)}</b></div>
      {#if t.harness}<div class="kv"><span>Harness</span><b>{shortHarnessName(harnessName(t.harness))}</b></div>{/if}
      {#if t.model}<div class="kv"><span>Model</span><b>{t.model}</b></div>{/if}
      {#if t.profile}<div class="kv"><span>Profile</span><b>{ops.profiles.find((p) => p.id === t.profile)?.name ?? 'Deleted profile'}</b></div>{/if}
      {#if t.team}<div class="kv"><span>Team</span><b>{ops.teams.find((x) => x.id === t.team)?.name ?? 'Deleted team'}</b></div>{/if}
      <div class="kv"><span>Start</span><b>{scheduleText(t.schedule, now)}</b></div>
      {#if t.maxAttempts > 1}<div class="kv"><span>Retries</span><b>Up to {t.maxAttempts} attempts per step, {Math.round(t.retryDelayMs / 1000)}s apart</b></div>{/if}
      <div class="kv"><span>Created</span><b>{clockText(t.createdAt, now)}</b></div>
    </div>

    <div class="label">Steps</div>
    <ol class="card steps">
      {#each t.steps as s, i (i)}
        <li class:done={i < t.currentStep || t.status === 'done'} class:current={i === t.currentStep && t.status !== 'done'}>
          <span class="snum">{#if i < t.currentStep || t.status === 'done'}<Icon name="check" size={14} />{:else}{i + 1}{/if}</span>
          <span class="stext">{s.prompt}{#if s.requiresConfirmation}<em><Icon name="shield" size={13} /> Needs confirmation</em>{/if}</span>
        </li>
      {/each}
    </ol>

    {#if deps.length || waitingOnThis.length}
      <div class="label">Dependencies</div>
      <div class="card kvs">
        {#each deps as d (d.id)}
          <button class="kv linkkv" onclick={() => all.some((x) => x.id === d.id) && (detailId = d.id)}><span>Waits for</span><b class:bad={d.status === 'failed' || d.status === 'canceled' || !d.status}>{d.title} · {d.status ? STATUS_LABEL[d.status] : 'Missing'}</b></button>
        {/each}
        {#each waitingOnThis as d (d.id)}
          <button class="kv linkkv" onclick={() => (detailId = d.id)}><span>Blocks</span><b>{d.title} · {STATUS_LABEL[d.status]}</b></button>
        {/each}
      </div>
    {/if}

    <div class="label">Log</div>
    <ol class="card logs">
      {#each (allLogs ? [...t.logs].reverse() : [...t.logs].reverse().slice(0, 12)) as l, i (i)}
        <li class:bad={l.event === 'error' || l.event === 'failed'}>
          <span class="lt">{clockText(l.at, now)}</span>
          <span class="le">{logLabel(l.event)}{t.steps.length > 1 ? ' · step ' + (l.step + 1) : ''}{#if l.message}<small>{l.message}</small>{/if}</span>
        </li>
      {:else}
        <li><span class="le muted">No entries</span></li>
      {/each}
    </ol>
    {#if t.logs.length > 12}<button class="btn block" onclick={() => (allLogs = !allLogs)}>{allLogs ? 'Show recent' : 'Show all ' + t.logs.length + ' entries'}</button>{/if}

    <div class="danger-zone">
      {#if confirming === 'cancel'}
        <p class="muted detail">{t.status === 'running' ? 'The running step is stopped.' : 'The task will not run.'}{waitingOnThis.length ? ' ' + waitingOnThis.length + ' dependent task(s) will fail.' : ''}</p>
        <button class="btn block danger" onclick={() => act('scheduler.cancel', 'Task canceled')} disabled={!!busy}>{#if busy === 'scheduler.cancel'}<span class="spinner"></span>{/if} Cancel task</button>
        <button class="btn block" onclick={() => (confirming = null)}>Keep it</button>
      {:else if confirming === 'delete'}
        <button class="btn block danger" onclick={() => act('scheduler.delete', 'Task deleted')} disabled={!!busy}>{#if busy === 'scheduler.delete'}<span class="spinner"></span>{/if} Delete permanently</button>
        <button class="btn block" onclick={() => (confirming = null)}>Keep it</button>
      {:else}
        {#if can.cancel}<button class="btn block danger" onclick={() => (confirming = 'cancel')} disabled={!online}>Cancel task…</button>{/if}
        {#if can.remove}
          <button class="btn block danger" onclick={() => (confirming = 'delete')} disabled={!online || waitingOnThis.length > 0}>Delete…</button>
          {#if waitingOnThis.length}<p class="muted detail">Delete the tasks that wait for this one first.</p>{/if}
        {/if}
      {/if}
    </div>
  {/if}
</Sheet>

<Sheet bind:open={editOpen} title={editingId ? 'Edit task' : 'New task'} tall>
  <form class="form" onsubmit={(e) => (e.preventDefault(), save())}>
    <label class="field">
      <span>Title</span>
      <input bind:value={draft.title} placeholder="Nightly dependency update" autocomplete="off" />
    </label>
    <label class="field">
      <span>Session</span>
      <select value={draft.sessionId} onchange={(e) => pickSession(e.currentTarget.value)}>
        {#if !draft.sessionId}<option value="">Pick a session</option>{/if}
        {#each app.sessions as s (s.id)}<option value={s.id}>{s.title || 'New session'} · {shortHarnessName(harnessName(s.harnessId ?? 'devin'))}</option>{/each}
        {#if draft.sessionId && !session}<option value={draft.sessionId}>{sessionTitle(draft.sessionId)}</option>{/if}
      </select>
      <small>Steps run one after another in this session, never while it is busy.</small>
    </label>

    <div class="field">
      <span>Steps</span>
      {#each draft.steps as step, i (i)}
        <div class="step card">
          <div class="stepbar">
            <b>Step {i + 1}</b>
            <label class="check"><input type="checkbox" bind:checked={step.requiresConfirmation} /> Confirm first</label>
            <button class="mini" type="button" onclick={() => (draft.steps = draft.steps.filter((_, j) => j !== i))} disabled={draft.steps.length === 1} aria-label="Remove step {i + 1}"><Icon name="trash" size={16} /></button>
          </div>
          <textarea bind:value={step.prompt} rows="3" placeholder="Prompt sent to the session" aria-label="Step {i + 1} prompt"></textarea>
        </div>
      {/each}
      <button class="btn block addstep" type="button" onclick={() => (draft.steps = [...draft.steps, { prompt: '', requiresConfirmation: false }])} disabled={draft.steps.length >= 50}><Icon name="plus" size={18} /> Add step</button>
    </div>

    <div class="field">
      <span>Start</span>
      <div class="seg" role="radiogroup" aria-label="Start">
        {#each WHEN as w (w.id)}
          <button type="button" role="radio" aria-checked={draft.when === w.id} class:on={draft.when === w.id} onclick={() => (draft.when = w.id)}>{w.label}</button>
        {/each}
      </div>
      {#if draft.when === 'delay'}
        <label class="inline"><input type="number" min="1" step="1" bind:value={draft.delayMinutes} /> minutes from saving</label>
      {:else if draft.when === 'at'}
        <input class="when" type="datetime-local" bind:value={draft.at} aria-label="Start time" />
      {:else if draft.when === 'manual'}
        <small>Waits on hold until you release it.</small>
      {/if}
    </div>

    {#if dependencyChoices.length}
      <div class="field">
        <span>Run after</span>
        <div class="card deps">
          {#each dependencyChoices as d (d.id)}
            <label class="dep"><input type="checkbox" checked={draft.dependencyIds.includes(d.id)} onchange={(e) => toggleDependency(d.id, e.currentTarget.checked)} /> <span>{d.title}</span><small>{STATUS_LABEL[d.status]}</small></label>
          {/each}
        </div>
        <small>The task waits until these are done, and fails if one fails or is canceled.</small>
      </div>
    {/if}

    <div class="grid">
      <label class="field">
        <span>Attempts</span>
        <input type="number" min="1" max="10" step="1" bind:value={draft.maxAttempts} />
      </label>
      <label class="field">
        <span>Retry after (s)</span>
        <input type="number" min="0" max="86400" step="1" bind:value={draft.retryDelaySeconds} disabled={draft.maxAttempts <= 1} />
      </label>
    </div>

    <label class="field">
      <span>Model</span>
      {#if models.length}
        <select bind:value={draft.model}>
          <option value="">Session's model</option>
          {#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
          {#if draft.model && !models.some((m) => m.id === draft.model)}<option value={draft.model}>{draft.model}</option>{/if}
        </select>
      {:else}
        <input bind:value={draft.model} placeholder="Session's model" autocapitalize="off" autocorrect="off" spellcheck="false" />
      {/if}
    </label>
    {#if profileChoices.length || draft.profile}
      <label class="field">
        <span>Profile</span>
        <select bind:value={draft.profile}>
          <option value="">None</option>
          {#each profileChoices as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
          {#if draft.profile && !profileChoices.some((p) => p.id === draft.profile)}<option value={draft.profile}>{ops.profiles.find((p) => p.id === draft.profile)?.name ?? 'Deleted profile'}</option>{/if}
        </select>
        <small>Adds the profile's instructions to every step. Only profiles for this session's folder and harness are offered.</small>
      </label>
    {/if}
    {#if teamChoices.length || draft.team}
      <label class="field">
        <span>Team</span>
        <select bind:value={draft.team}>
          <option value="">None: the session runs each step</option>
          {#each teamChoices as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
          {#if draft.team && !teamChoices.some((t) => t.id === draft.team)}<option value={draft.team}>{ops.teams.find((t) => t.id === draft.team)?.name ?? 'Deleted team'}</option>{/if}
        </select>
        <small>Each step is delegated to every role, and the next step waits for all of them.</small>
      </label>
    {/if}

    {#if editError}<p class="muted detail bad" role="alert">{editError}</p>{/if}
    <button class="btn primary block" type="submit" disabled={saving || !online}>
      {#if saving}<span class="spinner"></span>{/if}{editingId ? 'Save' : draft.when === 'manual' ? 'Create on hold' : 'Schedule task'}
    </button>
  </form>
</Sheet>

<style>
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .filters {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 4px 0 2px;
  }
  .filters .chip {
    flex: none;
    height: 32px;
  }
  .chip.on {
    background: var(--accent);
    color: var(--on-accent);
  }
  .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .list {
    margin-top: 12px;
    overflow: hidden;
  }
  .trow {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 8px 14px;
    text-align: left;
    color: var(--text);
  }
  .trow + .trow {
    border-top: 1px solid var(--line);
  }
  .ttext {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ttext b {
    font-size: 15px;
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
  .tstatus {
    flex: none;
    font-size: 12px;
    color: var(--text-2);
  }
  .tstatus.warn {
    color: var(--amber);
  }
  .empty .btn {
    margin-top: 16px;
  }
  .dstate {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 14px;
    margin-bottom: 10px;
  }
  .ask {
    padding: 12px 14px;
    margin-bottom: 10px;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--amber) 40%, transparent);
  }
  .ask p {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .prompt {
    white-space: pre-wrap;
    color: var(--text-2);
    max-height: 9em;
    overflow: auto;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .actions .btn {
    flex: 1 1 auto;
    min-height: 40px;
    padding: 0 12px;
    font-size: 14px;
    background: var(--fill);
  }
  .kvs {
    padding: 0 14px;
  }
  .kv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    width: 100%;
    min-height: 44px;
    padding: 10px 0;
    font-size: 14.5px;
    color: var(--text);
    text-align: left;
  }
  .kv + .kv {
    border-top: 1px solid var(--line);
  }
  .kv > span {
    flex: none;
    color: var(--text-2);
  }
  .kv b {
    font-weight: 500;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .steps,
  .logs {
    list-style: none;
    margin: 0;
    padding: 4px 14px;
  }
  .steps li {
    display: flex;
    gap: 10px;
    padding: 10px 0;
    font-size: 14px;
  }
  .steps li + li,
  .logs li + li {
    border-top: 1px solid var(--line);
  }
  .snum {
    flex: none;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--fill);
    font-size: 12px;
    font-weight: 600;
  }
  .steps li.done .snum {
    background: color-mix(in srgb, var(--green) 25%, transparent);
    color: var(--green);
  }
  .steps li.current .snum {
    background: var(--accent);
    color: var(--on-accent);
  }
  .steps .stext {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 8.5em;
    overflow: auto;
  }
  .steps em {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    font-style: normal;
    font-size: 12px;
    color: var(--amber);
  }
  .logs li {
    display: flex;
    gap: 10px;
    padding: 8px 0;
    font-size: 13px;
  }
  .lt {
    flex: none;
    width: 8.5em;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .le {
    flex: 1;
    min-width: 0;
  }
  .le small {
    display: block;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .logs li.bad .le {
    color: var(--amber);
  }
  .linkkv b.bad {
    color: var(--amber);
  }
  .danger-zone {
    margin-top: 18px;
    display: grid;
    gap: 8px;
  }
  .danger-zone .btn,
  .logs + .btn {
    background: var(--fill);
  }
  .logs + .btn {
    margin-top: 8px;
    min-height: 40px;
  }
  .form {
    display: grid;
    gap: 2px;
  }
  .form > .btn {
    margin-top: 8px;
  }
  .step {
    padding: 8px 10px 10px;
    margin-bottom: 8px;
  }
  .stepbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 13.5px;
  }
  .stepbar b {
    flex: 1;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-2);
  }
  .check input,
  .dep input {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }
  .mini {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-2);
  }
  .mini:disabled {
    opacity: 0.35;
  }
  .addstep {
    min-height: 40px;
    background: var(--fill);
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    padding: 3px;
    border-radius: 999px;
    background: var(--fill);
  }
  .seg button {
    min-height: 36px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-2);
  }
  .seg button.on {
    background: var(--bg-elev2);
    color: var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    font-size: 14px;
    color: var(--text-2);
  }
  .inline input {
    width: 96px;
  }
  .when {
    margin-top: 8px;
  }
  .deps {
    padding: 2px 12px;
    max-height: 220px;
    overflow: auto;
  }
  .dep {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    font-size: 14px;
  }
  .dep + .dep {
    border-top: 1px solid var(--line);
  }
  .dep span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dep small {
    margin: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 8px 4px;
    overflow-wrap: anywhere;
  }
  .bad {
    color: var(--amber);
  }
</style>

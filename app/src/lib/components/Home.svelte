<script lang="ts">
  import { app, conn, ops, rpc, refreshSessions, openSession, errorText } from '#lib/api.svelte.ts';
  import { newSessionParams, parseSessionChoice, sessionChoiceKey, type SessionChoice } from '#lib/operations.ts';
  import { normalizeTask } from '#lib/scheduler.ts';
  import type { SessionRow } from '#lib/types.ts';
  import { go, toast, route, requests, fresh } from '#lib/ui.svelte.ts';
  import { ago, shortPath } from '#lib/format.ts';
  import { isScratchPath, projectLabel, shortHarnessName } from '#lib/labels.ts';
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { notif } from '#lib/notifications.svelte.ts';
  import Sheet from './Sheet.svelte';
  import DirPicker from './DirPicker.svelte';
  import { getStorageItem, setStorageItem } from '#lib/storage.ts';
  import { SvelteSet } from 'svelte/reactivity';

  // embedded: rendered in the tablet sidebar next to the open session.
  let { embedded = false }: { embedded?: boolean } = $props();

  let picking = $state(false);
  // What the New session button starts: a harness (then a folder is picked) or a saved profile (its own folder).
  let choice = $state<SessionChoice>(parseSessionChoice(getStorageItem('harness')));
  let usableHarnesses = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  let harnessName = (id?: string) => app.harnesses.find((h) => h.id === id)?.name ?? id ?? '';
  let chosenProfile = $derived(choice.kind === 'profile' ? (ops.profiles.find((p) => p.id === (choice as { profileId: string }).profileId) ?? null) : null);
  let harnessId = $derived(choice.kind === 'harness' ? choice.harnessId : (chosenProfile?.harnessId ?? 'devin'));
  $effect(() => {
    if (choice.kind === 'harness' && usableHarnesses.length && !usableHarnesses.some((h) => h.id === harnessId)) choice = { kind: 'harness', harnessId: usableHarnesses[0].id };
    // A deleted profile falls back to a harness once the gateway has listed profiles.
    if (choice.kind === 'profile' && ops.loaded && !chosenProfile) choice = { kind: 'harness', harnessId: usableHarnesses[0]?.id ?? 'devin' };
  });
  let showPicker = $derived(usableHarnesses.length > 1 || ops.profiles.length > 0);
  // Scheduled tasks that wait for a decision, shown on the Tasks link.
  let tasksNeedingYou = $derived(
    ops.tasks.map(normalizeTask).filter((t) => t.condition === 'awaiting_confirmation' || t.condition === 'interrupted' || t.condition === 'dependency_failed').length
  );

  // Harness picker in the dock: a glass pill that opens an upward menu.
  let pickerOpen = $state(false);
  let pickerEl = $state<HTMLElement>();
  let pickerBtn = $state<HTMLButtonElement>();
  let pickerMenu = $state<HTMLElement>();
  let currentName = $derived(chosenProfile?.name ?? harnessName(harnessId));
  $effect(() => {
    if (!pickerOpen) return;
    tick().then(() => pickerMenu?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true }));
  });
  $effect(() => {
    if (selecting) pickerOpen = false;
  });
  function closePicker(refocus = false) {
    pickerOpen = false;
    if (refocus) pickerBtn?.focus();
  }
  function pick(next: SessionChoice) {
    choice = next;
    setStorageItem('harness', sessionChoiceKey(next));
    closePicker(true);
  }
  function pickerOutside(e: PointerEvent) {
    if (pickerOpen && pickerEl && !pickerEl.contains(e.target as Node)) closePicker();
  }
  function pickerFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (pickerOpen && pickerEl && next && !pickerEl.contains(next)) closePicker();
  }
  function menuKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...(pickerMenu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
  let creating = $state(false);
  let actionsFor = $state<SessionRow | null>(null);
  let actionsOpen = $state(false);
  let confirmDelete = $state(false);
  $effect(() => {
    if (!actionsOpen) confirmDelete = false;
  });
  let showEmpty = $state(false);
  let query = $state('');
  let searchInput = $state<HTMLInputElement>();
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (fresh(requests.newSession) && conn.status === 'online') untrack(newSession);
  });
  $effect(() => {
    if (fresh(requests.search)) searchInput?.focus();
  });

  let visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return app.sessions.filter((s) => {
      if (q) return (s.title ?? 'new session').toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q);
      return s.hasMessages || showEmpty || s.status !== 'idle';
    });
  });
  // Sessions blocked on an approval come first, whatever project they belong to.
  let waiting = $derived(visible.filter((s) => s.status === 'awaiting_permission'));
  // Sessions without a project each get their own scratch folder; they are listed as one group.
  const SCRATCH = ':scratch';
  let groups = $derived.by(() => {
    const by = new Map<string, SessionRow[]>();
    for (const s of visible) {
      if (s.status === 'awaiting_permission') continue;
      const key = isScratchPath(s.cwd, conn.info?.scratchDir) ? SCRATCH : s.cwd || '';
      const list = by.get(key);
      if (list) list.push(s);
      else by.set(key, [s]);
    }
    return [...by.entries()].map(([key, sessions]) => ({ key, cwd: key === SCRATCH ? null : key, sessions }));
  });
  let running = $derived(app.sessions.filter((s) => s.status === 'running').length);

  function readCollapsed(): string[] {
    try {
      const v = JSON.parse(getStorageItem('collapsedProjects') ?? '[]');
      return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }
  let collapsed = $state(readCollapsed());
  function toggleGroup(key: string) {
    collapsed = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setStorageItem('collapsedProjects', JSON.stringify(collapsed));
  }
  // A search shows every match, so groups are expanded while one is active.
  let isCollapsed = (key: string) => !query.trim() && collapsed.includes(key);

  // cwd null: no project for a harness (the gateway makes a fresh scratch folder), the profile's own folder for a profile.
  async function create(cwd: string | null, using: SessionChoice = choice) {
    creating = true;
    try {
      const r = await rpc('sessions.create', newSessionParams(cwd, using, ops.profiles));
      await openSession(r.id, r.cwd);
      query = '';
      go('#/s/' + encodeURIComponent(r.id));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      creating = false;
    }
  }
  function newSession() {
    if (choice.kind === 'profile') create(null);
    else picking = true;
  }

  function showActions(s: SessionRow) {
    actionsFor = s;
    actionsOpen = true;
  }
  function press(s: SessionRow) {
    if (selecting) return;
    pressTimer = setTimeout(() => showActions(s), 480);
  }

  async function act(method: 'session.close' | 'session.delete') {
    const s = actionsFor;
    actionsOpen = false;
    if (!s) return;
    try {
      await rpc(method, { id: s.id });
      toast(method === 'session.delete' ? 'Session deleted' : 'Session ended');
      if (route.id === s.id) go('#/', true);
      refreshSessions();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  // Select mode: rows toggle a selection instead of opening, and the dock offers bulk delete.
  let selecting = $state(false);
  let selected = new SvelteSet<string>();
  let bulkOpen = $state(false);
  let bulkBusy = $state(false);
  // Only sessions that are listed count, so hidden empty sessions or search misses are never deleted.
  let selectedIds = $derived(visible.filter((s) => selected.has(s.id)).map((s) => s.id));

  function startSelect(s?: SessionRow) {
    selected.clear();
    if (s) selected.add(s.id);
    actionsOpen = false;
    selecting = true;
  }
  function stopSelect() {
    selecting = false;
    bulkOpen = false;
    selected.clear();
  }
  function toggleSelected(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
  let allSelected = (list: SessionRow[]) => list.length > 0 && list.every((s) => selected.has(s.id));
  function toggleAll(list: SessionRow[]) {
    const all = allSelected(list);
    for (const s of list) {
      if (all) selected.delete(s.id);
      else selected.add(s.id);
    }
  }

  async function deleteSelected() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    bulkBusy = true;
    const results: PromiseSettledResult<unknown>[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        [results[i]] = await Promise.allSettled([rpc('session.delete', { id: ids[i] })]);
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(4, ids.length) }, worker));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const deleted = ids.filter((_, i) => results[i].status === 'fulfilled');
    if (!failed.length) toast(`Deleted ${ids.length} session${ids.length === 1 ? '' : 's'}`);
    else toast(`Deleted ${deleted.length} of ${ids.length}; ${failed.length} failed: ${errorText(failed[0].reason)}`, 'error');
    if (route.id && deleted.includes(route.id)) go('#/', true);
    bulkBusy = false;
    stopSelect();
    refreshSessions();
  }

  function selectKey(e: KeyboardEvent) {
    // An open harness menu takes Escape first, so neither select mode nor the chat beside reacts to it.
    if (e.key === 'Escape' && pickerOpen && !e.defaultPrevented) {
      e.preventDefault();
      closePicker(true);
      return;
    }
    // Capture phase: runs before the Sheet and search handlers, so an open sheet or a search query
    // takes the Escape first.
    if (e.key !== 'Escape' || !selecting || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
    // Mid-delete, Escape is swallowed: select mode stays until the delete finishes, and the chat beside it must not stop.
    if (bulkBusy) return e.preventDefault();
    if (e.target === searchInput && query) return;
    e.preventDefault();
    stopSelect();
  }

  function searchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Handled here, so the open chat beside the sidebar does not treat it as "stop".
      e.preventDefault();
      query = '';
      searchInput?.blur();
    } else if (e.key === 'Enter' && visible[0] && !selecting) {
      go('#/s/' + encodeURIComponent((waiting[0] ?? visible[0]).id));
    }
  }
</script>

{#snippet rowText(s: SessionRow, showFolder: boolean)}
  <span class="stext">
    <span class="stitle">{#if s.harnessId}<span class="hbadge" title={harnessName(s.harnessId)}>{shortHarnessName(harnessName(s.harnessId))}</span>{/if}{s.title || 'New session'}</span>
    {#if showFolder}<span class="sfolder">{projectLabel(s.cwd, conn.info?.scratchDir) || 'No folder'}</span>{/if}
  </span>
  <span class="smeta">
    {#if s.status === 'running'}Working{:else if s.status === 'awaiting_permission'}<em>Needs approval</em>{:else}{ago(s.updatedAt)}{/if}
  </span>
{/snippet}

{#snippet sessionRow(s: SessionRow, showFolder: boolean)}
  {#if selecting}
    {@const on = selected.has(s.id)}
    <button class="srow selrow" class:picked={on} role="checkbox" aria-checked={on} onclick={() => toggleSelected(s.id)} oncontextmenu={(e) => e.preventDefault()}>
      <span class="tick" class:on aria-hidden="true">{#if on}<Icon name="check" size={14} />{/if}</span>
      {@render rowText(s, showFolder)}
    </button>
  {:else}
    <a
      class="srow"
      class:on={embedded && route.id === s.id}
      href={'#/s/' + encodeURIComponent(s.id)}
      oncontextmenu={(e) => (e.preventDefault(), showActions(s))}
      ontouchstart={() => press(s)}
      ontouchend={() => clearTimeout(pressTimer)}
      ontouchmove={() => clearTimeout(pressTimer)}
    >
      <span class="dot {s.status}"></span>
      {@render rowText(s, showFolder)}
      <button class="smore" onclick={(e) => (e.preventDefault(), e.stopPropagation(), showActions(s))} aria-label="Session actions"><Icon name="more" size={18} /></button>
    </a>
  {/if}
{/snippet}

{#snippet selectAll(list: SessionRow[], name: string)}
  {@const all = allSelected(list)}
  <button class="gsel press" onclick={() => toggleAll(list)} disabled={!list.length} aria-label="{all ? 'Deselect' : 'Select'} all in {name}">{all ? 'Deselect all' : 'Select all'}</button>
{/snippet}

<svelte:window onkeydowncapture={selectKey} onpointerdown={pickerOutside} />

<div class="screen" class:embedded>
  <header class="topbar">
    <div class="title">
      <b>{conn.info?.host ?? 'uniharn'}</b>
      <small>
        <span class="dot" class:running={conn.status === 'online'} class:error={conn.status !== 'online'}></span>
        {conn.status === 'online' ? (running ? running + ' working' : 'Connected') : 'Reconnecting…'}
      </small>
    </div>
    <div class="glass-group glass">
      <button class="iconbtn bell" onclick={() => (notif.centerOpen = !notif.centerOpen)} aria-label={notif.unreadCount ? `Notifications, ${notif.unreadCount} unread` : 'Notifications'} title="Notifications"><Icon name="bell" />{#if notif.unreadCount}<span class="badge">{notif.unreadCount > 99 ? '99+' : notif.unreadCount}</span>{/if}</button>
      {#if app.sessions.length}<button class="iconbtn" class:active={selecting} onclick={() => (selecting ? stopSelect() : startSelect())} aria-pressed={selecting} aria-label="Select sessions" title="Select"><Icon name="checkSquare" /></button>{/if}
      <button class="iconbtn" onclick={() => go('#/terminal')} aria-label="Terminal" title="Terminal"><Icon name="terminal" /></button>
      <button class="iconbtn" onclick={() => go('#/settings')} aria-label="Settings" title="Settings (⌘,)"><Icon name="settings" /></button>
    </div>
  </header>

  <main class="scroller">
    <div class="column">
      {#if conn.info?.agent?.error}
        <button class="banner warn press" onclick={() => go('#/terminal?login')}>
          <Icon name="shield" size={16} /> Devin CLI is not running on the VM. Tap to log in from the terminal.
        </button>
      {/if}

      {#if app.sessions.length}
        <label class="search">
          <Icon name="search" size={17} />
          <input bind:this={searchInput} bind:value={query} onkeydown={searchKey} type="search" placeholder="Search sessions" aria-label="Search sessions" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" />
          {#if query}<button class="clear" onclick={() => (query = '')} aria-label="Clear search"><Icon name="x" size={14} /></button>{/if}
        </label>
      {/if}

      {#if ops.loaded}
        <nav class="opsnav" aria-label="Automation">
          <a class="chip" class:on={route.name === 'tasks'} href="#/tasks"><Icon name="list" /> Tasks{#if tasksNeedingYou}<span class="nbadge" title="{tasksNeedingYou} waiting for you">{tasksNeedingYou}</span>{/if}</a>
          <a class="chip" class:on={route.name === 'teams'} href="#/teams"><Icon name="subagents" /> Teams</a>
          <a class="chip" class:on={route.name === 'profiles'} href="#/profiles"><Icon name="folder" /> Profiles</a>
          <a class="chip" class:on={route.name === 'usage'} href="#/usage"><Icon name="bolt" /> Usage</a>
        </nav>
      {/if}

      {#if !app.sessionsLoaded}
        <div class="empty"><span class="spinner" style="margin:auto"></span></div>
      {:else if !waiting.length && !groups.length}
        <div class="empty">
          {#if query}
            <h2>No matching sessions</h2>
            <p>Nothing has “{query.trim()}” in its title or folder.</p>
          {:else}
            <h2>No sessions yet</h2>
            <p>Pick a project folder on the VM, or start without one, and tell the agent what to do.</p>
          {/if}
        </div>
      {:else}
        {#if waiting.length}
          <section>
            <div class="ghead"><span class="gname attention"><Icon name="shield" size={15} /> <b>Waiting for you</b></span>{#if selecting}<span class="gpath"></span>{@render selectAll(waiting, 'Waiting for you')}{/if}</div>
            <div class="card">
              {#each waiting as s (s.id)}{@render sessionRow(s, true)}{/each}
            </div>
          </section>
        {/if}
        {#each groups as g (g.key)}
          {@const name = g.cwd === null ? 'No project' : projectLabel(g.cwd, conn.info?.scratchDir) || 'No folder'}
          {@const shut = isCollapsed(g.key)}
          <section>
            <div class="ghead">
              <button class="gname gtoggle" onclick={() => toggleGroup(g.key)} aria-expanded={!shut} title={g.cwd ? shortPath(g.cwd, conn.info?.home) : undefined}>
                <span class="chev" class:open={!shut}><Icon name="chevron" size={14} /></span>
                <Icon name={g.cwd === null ? 'compose' : 'folder'} size={15} /> <b>{name}</b>
                {#if shut}<span class="gcount">{g.sessions.length}</span>{/if}
              </button>
              <span class="gpath"></span>
              {#if selecting}
                {@render selectAll(g.sessions, name)}
              {:else}
                <button class="gadd press" onclick={() => create(g.cwd, g.cwd === null ? { kind: 'harness', harnessId } : choice)} disabled={creating || g.cwd === '' || conn.status !== 'online'} aria-label="New session in {name}"><Icon name="plus" size={18} /></button>
              {/if}
            </div>
            {#if !shut}
              <div class="card">
                {#each g.sessions as s (s.id)}{@render sessionRow(s, false)}{/each}
              </div>
            {/if}
          </section>
        {/each}
      {/if}
      {#if app.sessionsLoaded && !query && app.sessions.some((s) => !s.hasMessages && s.status === 'idle')}
        <button class="toggle" onclick={() => (showEmpty = !showEmpty)}>{showEmpty ? 'Hide' : 'Show'} empty sessions</button>
      {/if}
    </div>
  </main>

  <div class="dock">
    {#if selecting}
      <button class="btn glass dockbtn" onclick={stopSelect} disabled={bulkBusy}>Cancel</button>
      <button class="btn danger dockbtn" onclick={() => (bulkOpen = true)} disabled={!selectedIds.length || bulkBusy}>
        {#if bulkBusy}<span class="spinner"></span>{:else}<Icon name="trash" size={18} />{/if} Delete ({selectedIds.length})
      </button>
    {:else}
    {#if showPicker}
      <div class="hpick" bind:this={pickerEl} onfocusout={pickerFocusOut}>
        <button
          bind:this={pickerBtn}
          class="hbtn glass press"
          class:open={pickerOpen}
          onclick={() => (pickerOpen = !pickerOpen)}
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          aria-label="New sessions use: {currentName}"
          title="New sessions use: {currentName}"
        >
          <span class="hcur">{chosenProfile ? currentName : shortHarnessName(currentName)}</span>
          <span class="hchev" aria-hidden="true"><Icon name="down" size={16} /></span>
        </button>
        {#if pickerOpen}
          <div class="hmenu glass-heavy" role="menu" aria-label="New sessions use" tabindex="-1" bind:this={pickerMenu} onkeydown={menuKey}>
            {#each usableHarnesses as h (h.id)}
              {@const on = choice.kind === 'harness' && h.id === harnessId}
              <button class="hitem" class:on role="menuitemradio" aria-checked={on} onclick={() => pick({ kind: 'harness', harnessId: h.id })}>
                <span class="hname">{h.name}</span>
                {#if on}<span class="hcheck"><Icon name="check" size={18} /></span>{/if}
              </button>
            {/each}
            {#if ops.profiles.length}
              <div class="hsep" role="presentation">Profiles</div>
              {#each ops.profiles as p (p.id)}
                {@const on = choice.kind === 'profile' && chosenProfile?.id === p.id}
                <button class="hitem" class:on role="menuitemradio" aria-checked={on} onclick={() => pick({ kind: 'profile', profileId: p.id })}>
                  <span class="hname">{p.name}<small>{shortHarnessName(harnessName(p.harnessId))} · {projectLabel(p.cwd, conn.info?.scratchDir)}</small></span>
                  {#if on}<span class="hcheck"><Icon name="check" size={18} /></span>{/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <button class="btn primary newbtn" onclick={newSession} disabled={creating || conn.status !== 'online'} title={chosenProfile ? 'New session in ' + chosenProfile.name + ' (⌘N)' : 'New session (⌘N)'}>
      {#if creating}<span class="spinner"></span>{:else}<Icon name="compose" size={18} />{/if} New session
    </button>
    {/if}
  </div>
</div>

<DirPicker bind:open={picking} onpick={create} onnoproject={conn.info?.scratchDir ? () => create(null) : undefined} />

<Sheet bind:open={actionsOpen} title={actionsFor?.title || 'Session'}>
  <p class="muted mono idline">{actionsFor?.id} · {shortPath(actionsFor?.cwd, conn.info?.home)}</p>
  <div class="actions">
    <button class="btn block" onclick={() => ((actionsOpen = false), go('#/s/' + encodeURIComponent(actionsFor?.id ?? '')))}>Resume</button>
    <button class="btn block" onclick={() => act('session.close')}>End session</button>
    <button class="btn block" onclick={() => actionsFor && startSelect(actionsFor)}>Select</button>
    {#if confirmDelete}
      <button class="btn block danger" onclick={() => act('session.delete')}>Delete permanently</button>
      <button class="btn block" onclick={() => (confirmDelete = false)}>Keep session</button>
    {:else}
      <button class="btn block danger" onclick={() => (confirmDelete = true)}>Delete session</button>
    {/if}
  </div>
</Sheet>

<Sheet bind:open={bulkOpen} title="Delete {selectedIds.length} session{selectedIds.length === 1 ? '' : 's'} permanently?">
  <div class="actions">
    <button class="btn block danger" onclick={() => ((bulkOpen = false), deleteSelected())} disabled={bulkBusy || !selectedIds.length}>Delete</button>
    <button class="btn block" onclick={() => (bulkOpen = false)}>Keep</button>
  </div>
</Sheet>

<style>
  .bell {
    position: relative;
  }
  .badge {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--red);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    pointer-events: none;
  }
  main {
    display: flex;
    flex-direction: column;
    padding-bottom: calc(var(--safe-bottom) + 96px);
  }
  .column {
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding: 4px calc(var(--safe-right) + 16px) 0 calc(var(--safe-left) + 16px);
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .embedded .column {
    padding: 2px 10px 0;
  }
  .banner {
    width: 100%;
    text-align: left;
    margin-bottom: 12px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 8px 0 13px;
    border-radius: 999px;
    background: var(--fill);
    color: var(--text-3);
    transition: box-shadow 0.2s ease, background-color 0.2s ease;
  }
  .search:focus-within {
    background: var(--bg-elev);
    box-shadow: 0 0 0 1px var(--line), 0 0 0 4px var(--accent-soft);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: none;
    font-size: 16px;
    color: var(--text);
    -webkit-appearance: none;
    appearance: none;
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .search input::placeholder {
    color: var(--text-3);
  }
  .clear {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--text-2);
  }
  section {
    padding-top: 18px;
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 6px 6px;
    min-height: 36px;
  }
  .gname {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    color: var(--text-2);
    flex: none;
    max-width: 60%;
    overflow: hidden;
    white-space: nowrap;
  }
  .gname b {
    font-weight: 650;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gname.attention {
    color: var(--amber);
  }
  .gtoggle {
    min-height: 36px;
    margin-left: -6px;
    padding: 0 8px 0 4px;
    border-radius: 10px;
    text-align: left;
  }
  .gtoggle:active {
    background: var(--fill);
  }
  .chev {
    flex: none;
    display: grid;
    color: var(--text-3);
    transition: rotate 0.2s var(--ease-out);
  }
  .chev.open {
    rotate: 90deg;
  }
  .gcount {
    flex: none;
    font-size: 12.5px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .gpath {
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gadd {
    flex: none;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    color: var(--text-2);
    border-radius: 50%;
  }
  .gadd:active:not(:disabled) {
    background: var(--fill);
  }
  .card {
    overflow: hidden;
  }
  .srow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 54px;
    padding: 6px 4px 6px 16px;
    color: var(--text);
    text-decoration: none;
    -webkit-touch-callout: none;
    user-select: none;
    transition: background-color 0.18s ease;
  }
  /* Inset hairline between rows, starting after the status dot like iOS lists. */
  .srow + .srow::before {
    content: '';
    position: absolute;
    top: 0;
    left: 36px;
    right: 0;
    border-top: 1px solid var(--line);
  }
  .srow:active {
    background: var(--fill);
  }
  .srow.on {
    background: var(--accent-soft);
  }
  .srow.on + .srow::before,
  .srow.on::before {
    border-color: transparent;
  }
  .stext {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .stitle {
    font-size: 15.5px;
    font-weight: 500;
    line-height: 1.35;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .srow.on .stitle {
    font-weight: 600;
  }
  .sfolder {
    font-size: 12.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smeta {
    font-size: 12.5px;
    color: var(--text-3);
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .smeta em {
    font-style: normal;
    font-weight: 500;
    color: var(--amber);
  }
  .smore {
    flex: none;
    width: 36px;
    height: 44px;
    display: grid;
    place-items: center;
    color: var(--text-3);
    border-radius: 12px;
  }
  .selrow {
    width: 100%;
    text-align: left;
    padding-right: 16px;
  }
  .srow.picked {
    background: var(--accent-soft);
  }
  .tick {
    flex: none;
    width: 22px;
    height: 22px;
    margin-left: -6px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    color: var(--on-accent);
  }
  .tick.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .gsel {
    flex: none;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--accent-text);
  }
  .gsel:active:not(:disabled) {
    background: var(--fill);
  }
  .iconbtn.active {
    color: var(--accent-text);
  }
  .dockbtn {
    pointer-events: auto;
    min-height: 50px;
    min-width: 120px;
    font-size: 16px;
  }
  .toggle {
    margin: 16px auto 0;
    min-height: 40px;
    font-size: 13.5px;
    color: var(--text-3);
    padding: 0 14px;
    border-radius: 999px;
  }
  .toggle:active {
    background: var(--fill);
  }
  .dock {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 15;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px 16px calc(var(--safe-bottom) + 14px);
    pointer-events: none;
    background: linear-gradient(to top, var(--bg) 18%, color-mix(in srgb, var(--bg) 0%, transparent));
  }
  .embedded .dock {
    background: linear-gradient(to top, color-mix(in srgb, var(--bg-elev) 85%, transparent) 30%, transparent);
    padding: 20px 12px 12px;
  }
  .newbtn {
    pointer-events: auto;
    min-width: 200px;
    min-height: 50px;
    font-size: 16px;
  }
  .hpick {
    position: relative;
    pointer-events: auto;
    min-width: 0;
    max-width: 45%;
    flex: 0 1 auto;
    display: flex;
  }
  .hbtn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    min-height: 50px;
    padding: 0 14px 0 18px;
    border-radius: 999px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    box-shadow: inset 0 1px 0 var(--glass-hi), inset 0 0 0 1px var(--glass-rim), var(--glass-drop-shadow);
  }
  .hbtn.open {
    box-shadow: inset 0 1px 0 var(--glass-hi), inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, var(--glass-rim)), var(--glass-drop-shadow);
  }
  .hcur {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hchev {
    flex: none;
    display: grid;
    color: var(--text-2);
    transition: rotate 0.25s var(--ease-out);
  }
  /* The menu opens upward, so the chevron points up while it is open. */
  .hbtn.open .hchev {
    rotate: 180deg;
  }
  .hmenu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    z-index: 20;
    width: max-content;
    min-width: 200px;
    max-width: min(300px, calc(100vw - 32px));
    max-height: min(360px, calc(var(--vvh, 100vh) * 0.5));
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: var(--r-lg);
    box-shadow: inset 0 1px 0 var(--glass-hi), inset 0 0 0 1px var(--glass-rim), 0 12px 32px rgba(0, 0, 0, 0.35);
    transform-origin: bottom left;
    animation: hmenu-in 0.22s var(--ease-out);
    outline: none;
  }
  @keyframes hmenu-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.96);
    }
  }
  .hitem {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 46px;
    padding: 0 12px 0 14px;
    border-radius: var(--r-md);
    text-align: left;
    font-size: 15px;
    color: var(--text);
    transition: background-color 0.18s ease;
  }
  .hitem:active,
  .hitem:focus-visible {
    background: var(--fill);
    outline: none;
  }
  .hitem.on {
    font-weight: 600;
  }
  .hname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hcheck {
    flex: none;
    display: grid;
    color: var(--accent-text);
  }
  .hname small {
    display: block;
    font-size: 12px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hsep {
    margin: 6px 14px 2px;
    padding-top: 8px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-3);
  }
  .opsnav {
    display: flex;
    gap: 6px;
    margin: 10px 0 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .opsnav .chip {
    flex: none;
    height: 32px;
    text-decoration: none;
    color: var(--text);
  }
  .opsnav .chip.on {
    background: var(--accent);
    color: var(--on-accent);
  }
  .nbadge {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--amber);
    color: #111;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
  }
  .hbadge {
    display: inline-block;
    max-width: 7em;
    vertical-align: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    font-weight: 500;
    line-height: 16px;
    padding: 0 6px;
    margin-right: 6px;
    border-radius: 6px;
    background: var(--fill);
    color: var(--text-2);
  }
  .embedded .newbtn {
    flex: 1 1 auto;
    min-width: 0;
    width: auto;
    white-space: nowrap;
  }
  .actions {
    display: grid;
    gap: 10px;
  }
  .actions .btn {
    background: var(--fill);
  }
  .idline {
    font-size: 12px;
    margin: 0 4px 16px;
    overflow-wrap: anywhere;
  }
</style>

<script lang="ts">
  import { tick } from 'svelte';
  import { app, conn, errorText, refreshSubagents, rpc, views } from '#lib/api.svelte.ts';
  import { shortHarnessName } from '#lib/labels.ts';
  import { ago, duration, markdown } from '#lib/format.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { SUBAGENT_GROUPS, linkOf, retryRequest, subagentGroup, subagentSummary, subagentsOf, type SubagentGroup } from '#lib/subagents.ts';
  import type { SubagentEntry } from '#lib/types.ts';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import SubagentTranscript from './SubagentTranscript.svelte';

  /** `compact` is the composer toolbar button, shown even before the first subagent; otherwise an inline summary row. */
  let { sessionId, compact = false }: { sessionId: string; compact?: boolean } = $props();

  let entries = $derived(subagentsOf(sessionId, app.subagents, app.links));
  const groupOf = (e: SubagentEntry) => subagentGroup(e.status, views[e.childSessionId]?.state.status);
  let groups = $derived(SUBAGENT_GROUPS.map((g) => ({ ...g, entries: entries.filter((e) => groupOf(e) === g.id) })).filter((g) => g.entries.length));
  let activeCount = $derived(entries.filter((e) => groupOf(e) === 'active').length);
  let waitingCount = $derived(entries.filter((e) => groupOf(e) === 'waiting').length);
  let runningCount = $derived(activeCount + waitingCount);
  let triggerLabel = $derived(
    runningCount ? `Subagents: ${activeCount} active${waitingCount ? `, ${waitingCount} waiting` : ''}` : entries.length ? `Subagents: ${entries.length} finished` : 'Subagents',
  );

  let sheet = $state(false);
  // Tracked by id so the detail follows live updates of the entry.
  let selectedId = $state<string | null>(null);
  let selected = $derived(entries.find((e) => e.childSessionId === selectedId) ?? null);
  let followUp = $state('');
  let sending = $state(false);
  let notice = $state<string | null>(null);
  let retrying = $state<string | null>(null);
  let listEl = $state<HTMLElement>();
  let backBtn = $state<HTMLButtonElement>();
  let followInput = $state<HTMLTextAreaElement>();

  $effect(() => {
    const sid = sessionId;
    conn.generation;
    app.links.length;
    if (conn.status !== 'online') return;
    rpc('orchestration.list', { id: sid }).catch(() => {});
    refreshSubagents(sid).catch(() => []);
  });
  $effect(() => {
    if (!sheet) selectedId = null;
  });

  // Elapsed and "updated" times only tick while the sheet shows them.
  let now = $state(Date.now());
  $effect(() => {
    if (!sheet) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  const harnessName = (id: string) => shortHarnessName(app.harnesses.find((h) => h.id === id)?.name ?? id);
  const isRunning = (g: SubagentGroup) => g === 'active' || g === 'waiting';
  const elapsed = (e: SubagentEntry) => duration((isRunning(groupOf(e)) ? now : e.updatedAt) - e.createdAt);
  function updated(e: SubagentEntry) {
    now;
    const when = ago(e.updatedAt);
    return when === 'now' ? 'updated now' : `updated ${when} ago`;
  }
  function statusLabel(e: SubagentEntry, g: SubagentGroup) {
    if (g === 'waiting') return e.status === 'queued' || e.status === 'pending' ? 'Queued' : 'Needs approval';
    if (g === 'active') return 'Working';
    if (g === 'failed') return /cancel/i.test(e.status) ? 'Stopped' : 'Failed';
    return e.status === 'idle' ? 'Idle' : 'Done';
  }
  const canStop = (e: SubagentEntry) => isRunning(groupOf(e)) && (e.kind === 'delegate' || e.canCancel);
  const canRetry = (e: SubagentEntry) => groupOf(e) === 'failed' && !!retryRequest(e);
  function configSummary(e: SubagentEntry) {
    const opts = e.configOptions ?? [];
    const pick = (re: RegExp) => opts.find((o) => re.test(`${o.id} ${o.name} ${o.category ?? ''}`) && o.currentValue !== undefined);
    const effort = pick(/reason|effort|thought|thinking/i);
    const fast = pick(/fast|speed|turbo|priority|tier/i);
    return [effort ? `${effort.name || effort.id}: ${String(effort.currentValue)}` : null, fast ? `${fast.name || fast.id}: ${String(fast.currentValue)}` : null].filter(Boolean).join(' · ');
  }

  async function openEntry(e: SubagentEntry, focusFollowUp = false) {
    selectedId = e.childSessionId;
    followUp = '';
    notice = null;
    await tick();
    if (focusFollowUp) followInput?.focus();
    else backBtn?.focus();
  }
  /** Back to the list, with focus on the row that was open so keyboard users keep their place. */
  async function closeEntry() {
    const id = selectedId;
    selectedId = null;
    await tick();
    if (id) listEl?.querySelector<HTMLElement>(`[data-child="${CSS.escape(id)}"]`)?.focus();
  }
  function openChat(e: SubagentEntry) {
    sheet = false;
    go('#/s/' + encodeURIComponent(e.childSessionId));
  }
  async function stop(e: SubagentEntry) {
    try {
      await rpc('session.cancel', { id: e.childSessionId });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }
  async function retry(e: SubagentEntry) {
    const request = retryRequest(e);
    if (!request || retrying) return;
    retrying = e.childSessionId;
    try {
      await rpc('orchestration.delegate', request);
      toast(`Retrying on ${harnessName(e.harnessId)}`, 'info');
      if (selectedId === e.childSessionId) await closeEntry();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      retrying = null;
    }
  }
  async function sendFollowUp() {
    if (!selected || !followUp.trim() || sending) return;
    sending = true;
    notice = null;
    try {
      const r = await rpc('subagents.message', { parentSessionId: sessionId, childSessionId: selected.childSessionId, text: followUp.trim() });
      notice = r?.delivery === 'parent' ? 'Sent through the parent session.' : r?.mode === 'steering' ? 'Steered into the running turn.' : 'Sent as a new prompt.';
      followUp = '';
    } catch (err) {
      notice = errorText(err);
    } finally {
      sending = false;
    }
  }
  function followUpKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendFollowUp();
    }
  }
</script>

{#snippet statusIcon(g: SubagentGroup, label: string)}
  <span class="sicon {g}" title={label} aria-hidden="true">
    {#if g === 'active'}<span class="spinner sm"></span>
    {:else if g === 'waiting'}<Icon name="shield" size={13} />
    {:else if g === 'failed'}<Icon name="x" size={13} />
    {:else}<Icon name="check" size={13} />{/if}
  </span>
{/snippet}

{#if compact}
  <button class="toolchip" class:live={runningCount > 0} onclick={() => (sheet = true)} aria-label={triggerLabel} aria-haspopup="dialog" title="Subagents">
    <Icon name="subagents" size={16} />
    <span class="tlabel">Subagents</span>
    {#if runningCount}<b class="count" aria-hidden="true">{runningCount}</b>{/if}
  </button>
{:else if entries.length}
  <div class="subagents">
    <button class="shead" onclick={() => (sheet = true)} aria-haspopup="dialog" aria-label={triggerLabel}>
      <Icon name="subagents" size={15} />
      <span class="label">Subagents</span>
      <span class="pill" aria-hidden="true">{entries.length}</span>
      {#if runningCount}<span class="pill live" aria-hidden="true">{runningCount} active</span>{/if}
      <span class="chev"><Icon name="chevron" size={14} /></span>
    </button>
  </div>
{/if}

<Sheet bind:open={sheet} title="Subagents" tall>
  {#if !selected}
    <div class="sheet-body" bind:this={listEl}>
      {#if !entries.length}
        <div class="none">
          <b>No subagents yet</b>
          <p>Work this session delegates to other harnesses shows up here while it runs and after it finishes.</p>
        </div>
      {/if}
      {#each groups as g (g.id)}
        <section class="group" aria-labelledby="sub-{g.id}">
          <h3 class="group-label" id="sub-{g.id}">{g.name} <span>{g.entries.length}</span></h3>
          <ul>
            {#each g.entries as e (e.childSessionId)}
              {@const label = statusLabel(e, g.id)}
              {@const summary = subagentSummary(e, linkOf(e, app.links), g.id)}
              <li class="row">
                <button class="row-main" data-child={e.childSessionId} onclick={() => openEntry(e)}>
                  {@render statusIcon(g.id, label)}
                  <span class="main">
                    <span class="title">{e.title}<span class="sr-only">, {label}</span></span>
                    <span class="meta">
                      <span>{harnessName(e.harnessId)}</span>
                      {#if e.model}<span class="mono">{e.model}</span>{/if}
                      <span class="num">{elapsed(e)}</span>
                      <span>{updated(e)}</span>
                    </span>
                    {#if summary}<span class="summary" class:bad={g.id === 'failed'}>{summary}</span>{/if}
                    {#if e.branch || e.worktree}
                      <span class="wt"><Icon name="git" size={12} /><span>{e.branch ?? 'worktree'}</span></span>
                    {/if}
                  </span>
                </button>
                <span class="ractions">
                  {#if canStop(e)}
                    <button class="mini stop" onclick={() => stop(e)} aria-label="Stop {e.title}" title="Stop"><Icon name="stop" size={13} /></button>
                  {/if}
                  {#if canRetry(e)}
                    <button class="mini" onclick={() => retry(e)} disabled={!!retrying || conn.status !== 'online'} aria-label="Retry {e.title}" title="Retry"><Icon name="refresh" size={15} /></button>
                  {/if}
                  <button class="mini" onclick={() => openEntry(e, true)} aria-label="Follow up with {e.title}" title="Follow up"><Icon name="compose" size={15} /></button>
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {:else}
    {@const e = selected}
    {@const g = groupOf(e)}
    {@const label = statusLabel(e, g)}
    {@const link = linkOf(e, app.links)}
    <div class="sheet-body detail">
      <button class="back" bind:this={backBtn} onclick={closeEntry}><Icon name="back" size={16} /> All subagents</button>
      <div class="dhead">
        {@render statusIcon(g, label)}
        <div class="dmain">
          <h3 class="dtitle">{e.title}</h3>
          <div class="dmeta"><span class="st {g}">{label}</span> · {harnessName(e.harnessId)}{#if e.model} · {e.model}{/if} · <span class="num">{elapsed(e)}</span> · {updated(e)}</div>
        </div>
      </div>
      <div class="dactions">
        {#if e.kind === 'delegate'}<button class="btn sm" onclick={() => openChat(e)}><Icon name="external" size={15} /> Open chat</button>{/if}
        {#if canStop(e)}<button class="btn sm danger" onclick={() => stop(e)}><Icon name="stop" size={13} /> Stop</button>{/if}
        {#if canRetry(e)}<button class="btn sm" onclick={() => retry(e)} disabled={!!retrying || conn.status !== 'online'}><Icon name="refresh" size={15} /> {retrying === e.childSessionId ? 'Retrying…' : 'Retry'}</button>{/if}
      </div>
      {#if e.description || e.task}<p class="desc">{e.description ?? e.task}</p>{/if}
      <dl class="facts">
        {#if e.cwd}<div><dt>Folder</dt><dd><code>{e.cwd}</code></dd></div>{/if}
        {#if e.branch}<div><dt>Branch</dt><dd><code>{e.branch}</code></dd></div>{/if}
        {#if e.worktree}<div><dt>Worktree</dt><dd><code>{e.worktree}</code></dd></div>{/if}
        {#if configSummary(e)}<div><dt>Settings</dt><dd><code>{configSummary(e)}</code></dd></div>{/if}
      </dl>
      {#if link?.error}<div class="out-error" role="status">{link.error}</div>{/if}
      {#if link?.output}
        <section class="output" aria-label="Output">
          <div class="out-head">Output</div>
          <div class="md out-body">{@html markdown(link.output)}</div>
        </section>
      {/if}
      {#if e.kind === 'native'}<p class="note">Native harness subagent. Follow-ups go to the parent session with instructions to forward them, because the harness does not accept client prompts for its children.</p>{/if}
      <div class="follow">
        <label class="follow-label" for="follow-{e.id}">{isRunning(g) ? 'Steer this subagent' : 'Follow up'}</label>
        <textarea id="follow-{e.id}" rows="2" bind:this={followInput} bind:value={followUp} onkeydown={followUpKey} placeholder={isRunning(g) ? 'Urgent instructions for the running turn' : 'Ask for changes or a next step'} disabled={sending}></textarea>
        <div class="follow-row">
          <button class="btn sm primary" onclick={sendFollowUp} disabled={sending || !followUp.trim() || conn.status !== 'online'}>{sending ? 'Sending…' : 'Send'}</button>
          {#if notice}<span class="notice" role="status">{notice}</span>{/if}
        </div>
      </div>
      <div class="transcript-wrap">
        <SubagentTranscript sessionId={e.childSessionId} cwd={e.cwd} />
      </div>
    </div>
  {/if}
</Sheet>

<style>
  .count {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--green);
    color: var(--bg);
    font: 700 11px/18px var(--mono);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .subagents {
    border-radius: var(--r-md);
    background: var(--bg-elev);
    box-shadow: 0 0 0 1px var(--line);
    overflow: hidden;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 40px;
    padding: 0 12px;
    color: var(--text-2);
    text-align: left;
  }
  .shead .label {
    margin: 0;
    font-size: 13px;
  }
  .pill {
    font: 600 11px var(--mono);
    color: var(--text-3);
    background: var(--fill);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .pill.live {
    color: var(--green);
  }
  .chev {
    display: grid;
    margin-left: auto;
    color: var(--text-3);
  }
  .sheet-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 2px 12px 18px;
  }
  .none {
    padding: 28px 16px;
    text-align: center;
    color: var(--text-2);
    font-size: 14px;
  }
  .none b {
    color: var(--text);
    font-weight: 650;
  }
  .none p {
    margin: 6px auto 0;
    max-width: 320px;
    text-wrap: pretty;
  }
  .group ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .group-label {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 6px 4px;
    font-size: 12.5px;
    font-weight: 650;
    color: var(--text-2);
  }
  .group-label span {
    font: 600 11px var(--mono);
    color: var(--text-3);
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    border-radius: var(--r-md);
    transition: background-color 0.18s ease;
  }
  .row:hover {
    background: var(--fill);
  }
  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 4px 9px 8px;
    border-radius: inherit;
    text-align: left;
  }
  .row-main:active {
    background: var(--fill);
  }
  .sicon {
    flex: none;
    width: 22px;
    height: 22px;
    margin-top: 1px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--text-3);
    background: var(--fill);
  }
  .sicon.active {
    background: color-mix(in srgb, var(--green) 14%, transparent);
  }
  .sicon.active .spinner {
    border-color: color-mix(in srgb, var(--green) 30%, transparent);
    border-top-color: var(--green);
  }
  .sicon.waiting {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 16%, transparent);
  }
  .sicon.done {
    color: var(--green);
  }
  .sicon.failed {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 14%, transparent);
  }
  .spinner.sm {
    width: 12px;
    height: 12px;
  }
  .main {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    color: var(--text);
    font-size: 14.5px;
    font-weight: 600;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    column-gap: 6px;
    color: var(--text-3);
    font-size: 12px;
  }
  .meta > span + span::before {
    content: '·';
    margin-right: 6px;
  }
  .meta .mono {
    font-size: 11.5px;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .summary {
    color: var(--text-2);
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .summary.bad {
    color: var(--red);
  }
  .wt {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    align-self: flex-start;
    max-width: 100%;
    margin-top: 2px;
    padding: 1px 7px;
    border-radius: 6px;
    background: var(--fill);
    color: var(--text-2);
    font: 11px var(--mono);
  }
  .wt span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ractions {
    flex: none;
    display: flex;
    gap: 2px;
    padding: 6px 4px 0 0;
  }
  .mini {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .mini:hover:not(:disabled),
  .mini:active:not(:disabled) {
    background: var(--fill-2);
    color: var(--text);
  }
  .mini.stop {
    color: var(--red);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    min-height: 32px;
    padding: 0 8px 0 4px;
    border-radius: 999px;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 600;
  }
  .detail {
    min-height: 0;
  }
  .dhead {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .dmain {
    min-width: 0;
  }
  .dtitle {
    margin: 0;
    font-size: 17px;
    font-weight: 700;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .dmeta {
    color: var(--text-3);
    font-size: 12px;
    margin-top: 2px;
  }
  .st.active {
    color: var(--green);
  }
  .st.waiting {
    color: var(--amber);
  }
  .st.failed {
    color: var(--red);
  }
  .dactions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .dactions:empty {
    display: none;
  }
  .btn.sm {
    min-height: 36px;
    padding: 0 14px;
    gap: 6px;
    font-size: 13px;
  }
  .desc {
    margin: 0;
    color: var(--text-2);
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 9.5em;
    overflow-y: auto;
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: 0;
  }
  .facts:empty {
    display: none;
  }
  .facts div {
    display: grid;
    grid-template-columns: 68px 1fr;
    gap: 8px;
    font-size: 12px;
  }
  .facts dt {
    color: var(--text-3);
  }
  .facts dd {
    margin: 0;
    min-width: 0;
  }
  .facts code {
    display: block;
    color: var(--text-2);
    font: 11.5px var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .out-error {
    padding: 8px 12px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--red) 10%, transparent);
    color: var(--red);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .output {
    border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--line);
    overflow: hidden;
  }
  .out-head {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 650;
    color: var(--text-2);
    background: var(--fill);
  }
  .out-body {
    max-height: 240px;
    overflow-y: auto;
    padding: 8px 12px;
    font-size: 13.5px;
    line-height: 1.5;
  }
  .note {
    margin: 0;
    color: var(--text-3);
    font-size: 12px;
  }
  .follow {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .follow-label {
    font-size: 12.5px;
    font-weight: 650;
    color: var(--text-2);
  }
  .follow textarea {
    width: 100%;
    resize: vertical;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--fill);
    color: var(--text);
    padding: 9px 12px;
    font: inherit;
    font-size: 15px;
  }
  .follow textarea:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 55%, var(--line-strong));
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .follow-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .notice {
    color: var(--text-2);
    font-size: 12px;
  }
  .transcript-wrap {
    min-height: 260px;
    border-radius: var(--r-lg);
    box-shadow: 0 0 0 1px var(--line);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  @media (hover: none) {
    .row:hover {
      background: none;
    }
  }
</style>

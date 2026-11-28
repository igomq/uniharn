<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, errorText, ops, rpc } from '#lib/api.svelte.ts';
  import { route, toast } from '#lib/ui.svelte.ts';
  import { outdatedGateway } from '#lib/accounts.ts';
  import { ago } from '#lib/format.ts';
  import { SOURCE_LABEL, USAGE_URL, compact, manualForm, manualPatch, type HarnessUsage, type ManualForm, type UsageSource } from '#lib/usage.ts';
  import BackButton from './BackButton.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function load(refresh = false) {
    loading = true;
    try {
      await rpc('usage.list', { refresh });
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    if (route.name === 'usage' && conn.status === 'online' && conn.generation) untrack(() => load());
  });

  let online = $derived(conn.status === 'online');
  let report = $derived(ops.usage);
  // Harnesses that are set up or have something to show; the rest would be empty cards.
  let harnesses = $derived(
    (report?.harnesses ?? [])
      .filter((h) => h.installed || h.enabled || h.manual || h.sessions.count || h.delegations.count)
      .sort((a, b) => Number(a.custom) - Number(b.custom) || Number(!a.installed) - Number(!b.installed))
  );
  let totals = $derived.by(() => {
    const list = report?.harnesses ?? [];
    return {
      sessions: list.reduce((n, h) => n + h.sessions.count, 0),
      running: list.reduce((n, h) => n + h.sessions.running, 0),
      tokens: list.reduce((n, h) => n + h.sessions.tokens.total, 0),
      delegations: list.reduce((n, h) => n + h.delegations.count, 0),
      delegating: list.reduce((n, h) => n + h.delegations.running, 0)
    };
  });

  const resetText = (iso: string) => {
    const at = Date.parse(iso);
    const left = at - Date.now();
    const when = new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (left <= 0) return when + ' (passed)';
    const hours = Math.round(left / 3600000);
    return when + ' · in ' + (hours < 1 ? Math.max(1, Math.round(left / 60000)) + 'm' : hours < 48 ? hours + 'h' : Math.round(hours / 24) + 'd');
  };
  const usageLine = (h: HarnessUsage) => {
    const u = h.usage;
    if (u.kind === 'percent' && u.percent !== null) return Math.round(u.percent) + '% ' + (u.remaining ? 'left' : 'used');
    if (u.kind === 'tokens' && u.tokens) return compact(u.tokens.total) + ' tokens' + (u.tokens.cachedRead ? ' · ' + compact(u.tokens.cachedRead) + ' cached' : '');
    return 'Not reported';
  };
  // Bar width is always the share left, so a manual "used" figure is turned around.
  const leftPercent = (h: HarnessUsage) => (h.usage.kind === 'percent' && h.usage.percent !== null ? (h.usage.remaining ? h.usage.percent : 100 - h.usage.percent) : null);

  // Manual entry.
  let editOpen = $state(false);
  let editing = $state<HarnessUsage | null>(null);
  let form = $state<ManualForm>(manualForm(null));
  let saving = $state(false);
  let formError = $state<string | null>(null);
  let confirmReset = $state(false);

  function openEdit(h: HarnessUsage) {
    editing = h;
    form = manualForm(h.manual);
    formError = null;
    confirmReset = false;
    editOpen = true;
  }
  async function save() {
    if (!editing) return;
    const result = manualPatch(form);
    if ('problem' in result) return (formError = result.problem);
    saving = true;
    formError = null;
    try {
      await rpc('usage.update', { harnessId: editing.harnessId, manual: result.patch });
      editOpen = false;
      toast('Usage saved');
    } catch (e) {
      formError = errorText(e);
    } finally {
      saving = false;
    }
  }
  async function resetManual() {
    if (!editing) return;
    saving = true;
    try {
      await rpc('usage.update', { harnessId: editing.harnessId, reset: true });
      editOpen = false;
      toast('Manual values cleared');
    } catch (e) {
      formError = errorText(e);
    } finally {
      saving = false;
    }
  }
</script>

{#snippet source(s: UsageSource)}
  {#if s !== 'none'}<span class="src {s}">{SOURCE_LABEL[s]}</span>{/if}
{/snippet}

<div class="screen">
  <header class="topbar">
    <BackButton to="#/" />
    <div class="title">
      <b>Usage</b>
      {#if report}{@const since = ago(Date.parse(report.generatedAt))}<small>Updated {since === 'now' ? 'just now' : since + ' ago'}</small>{/if}
    </div>
    <button class="iconbtn glass" onclick={() => load(true)} disabled={loading || !online} aria-label="Check again" title="Check again">{#if loading}<span class="spinner"></span>{:else}<Icon name="refresh" />{/if}</button>
  </header>
  <main class="scroller">
    <div class="column">
      {#if loadError}
        <p class="muted detail bad">{outdatedGateway(conn.info, loadError) ?? loadError}</p>
      {:else if !report}
        <div class="empty"><span class="spinner" style="margin:auto"></span></div>
      {:else}
        <div class="summary card">
          <div><b>{totals.sessions}</b><span>Sessions{totals.running ? ' · ' + totals.running + ' active' : ''}</span></div>
          <div><b>{compact(totals.tokens)}</b><span>Tokens</span></div>
          <div><b>{totals.delegations}</b><span>Delegations{totals.delegating ? ' · ' + totals.delegating + ' running' : ''}</span></div>
        </div>
        <p class="muted note">Session tokens are counted by the gateway since it started. Official figures come from each harness account; enter the rest by hand.</p>
        {#if report.officialError}<p class="muted detail bad">Official usage unavailable: {report.officialError}</p>{/if}

        {#each harnesses as h (h.harnessId)}
          {@const left = leftPercent(h)}
          <div class="label">{h.name}</div>
          <div class="card hcard">
            <div class="kv">
              <span>Usage</span>
              <b class:bad={left !== null && left <= 10}>{usageLine(h)} {@render source(h.sources.usage)}</b>
            </div>
            {#if left !== null}<div class="bar" class:warn={left <= 20}><i style="width: {Math.max(0, Math.min(100, left))}%"></i></div>{/if}
            {#each h.windows as w (w.id)}
              <div class="kv sub"><span>{w.label}</span><b>{Math.round(w.remainingPercent)}% left{w.resetsAt ? ' · resets ' + resetText(w.resetsAt) : ''}</b></div>
            {/each}
            {#if h.reset}<div class="kv"><span>Resets</span><b>{h.reset.label ? h.reset.label + ' · ' : ''}{resetText(h.reset.at)} {@render source(h.sources.reset)}</b></div>{/if}
            {#if h.accountLabel}<div class="kv"><span>Account</span><b>{h.accountLabel} {@render source(h.sources.accountLabel)}</b></div>{/if}
            {#if h.plan}<div class="kv"><span>Plan</span><b>{h.plan} {@render source(h.sources.plan)}</b></div>{/if}
            {#if h.credit}<div class="kv"><span>Credit</span><b>{h.credit}</b></div>{/if}
            {#if h.preferredUseCase}<div class="kv"><span>Best for</span><b>{h.preferredUseCase}</b></div>{/if}
            <div class="kv">
              <span>Sessions</span>
              <b>{h.sessions.count}{h.sessions.running ? ' · ' + h.sessions.running + ' active' : ''}{h.sessions.tokens.total ? ' · ' + compact(h.sessions.tokens.input) + ' in / ' + compact(h.sessions.tokens.output) + ' out' : ''}{h.sessions.lastUsedAt ? ' · ' + ago(h.sessions.lastUsedAt) : ''}</b>
            </div>
            {#if h.delegations.count}
              <div class="kv">
                <span>Delegations</span>
                <b class:bad={h.delegations.error > 0}>{h.delegations.count} · {h.delegations.done} done{h.delegations.running ? ' · ' + h.delegations.running + ' running' : ''}{h.delegations.error ? ' · ' + h.delegations.error + ' failed' : ''}</b>
              </div>
            {/if}
            {#if h.auth.status !== 'authenticated' && h.auth.detail}<p class="muted detail">{h.auth.detail}</p>{/if}
            {#if h.note}<p class="muted detail notep">{h.note}</p>{/if}
            <div class="row2">
              <button class="btn" onclick={() => openEdit(h)} disabled={!online}><Icon name="edit" size={16} /> {h.manual ? 'Edit manual values' : 'Add manual values'}</button>
              {#if h.harnessId === 'devin'}<a class="btn" href={USAGE_URL} target="_blank" rel="noreferrer"><Icon name="external" size={16} /> Devin usage</a>{/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </main>
</div>

<Sheet bind:open={editOpen} title={editing ? editing.name + ' usage' : 'Usage'} tall>
  {#if editing}
    <form class="form" onsubmit={(e) => (e.preventDefault(), save())}>
      <p class="muted detail">Official values take precedence; manual ones fill what the harness does not report. Leave a field empty to clear it.</p>
      <div class="grid">
        <label class="field">
          <span>Used (%)</span>
          <input type="text" inputmode="decimal" bind:value={form.usagePercent} placeholder="0–100" />
        </label>
        <label class="field">
          <span>Resets at</span>
          <input type="datetime-local" bind:value={form.resetAt} />
        </label>
      </div>
      <div class="grid three">
        <label class="field"><span>Input tokens</span><input type="text" inputmode="numeric" bind:value={form.input} /></label>
        <label class="field"><span>Output tokens</span><input type="text" inputmode="numeric" bind:value={form.output} /></label>
        <label class="field"><span>Cached</span><input type="text" inputmode="numeric" bind:value={form.cachedRead} /></label>
      </div>
      <label class="field"><span>Account</span><input bind:value={form.accountLabel} maxlength="120" autocomplete="off" /></label>
      <div class="grid">
        <label class="field"><span>Plan</span><input bind:value={form.plan} maxlength="80" autocomplete="off" /></label>
        <label class="field"><span>Credit</span><input bind:value={form.credit} maxlength="200" placeholder="$20 left" autocomplete="off" /></label>
      </div>
      <label class="field"><span>Best for</span><input bind:value={form.preferredUseCase} maxlength="120" placeholder="Long refactors" autocomplete="off" /></label>
      <label class="field"><span>Note</span><textarea bind:value={form.note} maxlength="500" rows="3"></textarea></label>
      {#if formError}<p class="muted detail bad" role="alert">{formError}</p>{/if}
      <button class="btn primary block" type="submit" disabled={saving || !online}>{#if saving}<span class="spinner"></span>{/if} Save</button>
      {#if editing.manual}
        {#if confirmReset}
          <button class="btn block danger" type="button" onclick={resetManual} disabled={saving}>Clear all manual values</button>
          <button class="btn block" type="button" onclick={() => (confirmReset = false)}>Keep them</button>
        {:else}
          <button class="btn block danger" type="button" onclick={() => (confirmReset = true)}>Reset manual values…</button>
        {/if}
      {/if}
    </form>
  {/if}
</Sheet>

<style>
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 8px;
    padding: 12px 6px;
    text-align: center;
  }
  .summary div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .summary div + div {
    border-left: 1px solid var(--line);
  }
  .summary b {
    font-size: 19px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .summary span {
    font-size: 12px;
    color: var(--text-3);
  }
  .note {
    font-size: 12.5px;
    line-height: 1.45;
    margin: 10px 4px 0;
  }
  .hcard {
    padding: 0 16px;
  }
  .kv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    min-height: 44px;
    padding: 10px 0;
    font-size: 14.5px;
  }
  .kv + .kv {
    border-top: 1px solid var(--line);
  }
  .kv.sub {
    min-height: 34px;
    padding: 4px 0 4px 12px;
    font-size: 13px;
    border-top: 0;
  }
  .kv > span {
    flex: none;
    color: var(--text-2);
  }
  .kv b {
    font-weight: 500;
    text-align: right;
    overflow-wrap: anywhere;
    display: inline-flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .kv b.bad {
    color: var(--amber);
  }
  .src {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--fill);
    color: var(--text-2);
  }
  .src.official {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 14%, transparent);
  }
  .src.manual {
    color: var(--blue);
    background: color-mix(in srgb, var(--blue) 14%, transparent);
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--fill);
    overflow: hidden;
    margin-bottom: 10px;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .bar.warn i {
    background: var(--amber);
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 4px 0 10px;
    overflow-wrap: anywhere;
  }
  .notep {
    white-space: pre-wrap;
  }
  .bad {
    color: var(--amber);
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 4px 0 14px;
  }
  .row2 .btn {
    flex: 1;
    min-height: 40px;
    padding: 0 12px;
    font-size: 14px;
    white-space: nowrap;
    background: var(--fill);
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
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .grid.three {
    grid-template-columns: 1fr 1fr 1fr;
  }
  .grid .field input {
    min-width: 0;
    padding: 0 12px;
  }
</style>

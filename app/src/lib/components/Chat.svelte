<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { views, conn, rpc, leaveSession, openSession, app, errorText } from '#lib/api.svelte.ts';
  import { emptyState } from '#lib/timeline.ts';
  import type { AttachedFile, Item, TextItem, ToolItem } from '#lib/types.ts';
  import { go, toast, copyText } from '#lib/ui.svelte.ts';
  import { getStorageItem, removeStorageItem, setStorageItem } from '#lib/storage.ts';
  import { markdown, duration } from '#lib/format.ts';
  import { isScratchPath, projectLabel, shortHarnessName } from '#lib/labels.ts';
  import { decodeText, isTextFile } from '#lib/textfile.ts';
  import { fileUrlsToPaths, localImages } from '#lib/localImages.ts';
  import AttachmentViewer, { type Viewed } from './AttachmentViewer.svelte';
  import SubagentsPanel from './SubagentsPanel.svelte';
  import { applyCommand, commandToken, matchCommands } from '#lib/commands.ts';
  import Icon from './Icon.svelte';
  import BackButton from './BackButton.svelte';
  import ToolCall from './ToolCall.svelte';
  import Permission from './Permission.svelte';
  import SessionControls from './SessionControls.svelte';
  import { effortControl, fastControl } from '#lib/quickControls.ts';
  import { compact } from '#lib/usage.ts';

  type Steps = { kind: 'steps'; id: string; items: (TextItem | ToolItem)[] };

  let { id }: { id: string } = $props();
  let view = $derived(views[id]);
  const blank = emptyState();
  let st = $derived(view?.state ?? blank);
  // The unsent message survives leaving the session and restarting the app.
  // svelte-ignore state_referenced_locally
  const draftSuffix = 'draft.' + id;
  let text = $state(getStorageItem(draftSuffix) ?? '');
  $effect(() => {
    if (text) setStorageItem(draftSuffix, text);
    else removeStorageItem(draftSuffix);
  });
  let harnessLabel = $derived.by(() => {
    const known = app.sessions.find((s) => s.id === id);
    const hid = known?.harnessId ?? (id.includes(':') ? id.slice(0, id.indexOf(':')) : 'devin');
    return app.harnesses.find((h) => h.id === hid)?.name ?? (hid === 'devin' ? 'Devin' : hid);
  });
  let harnessShort = $derived(shortHarnessName(harnessLabel));
  let sending = $state(false);
  let controls = $state(false);
  let scroller = $state<HTMLElement>();
  let input = $state<HTMLTextAreaElement>();
  let pinned = $state(true);
  let openGroups = $state<Record<string, boolean>>({});
  let loadError = $state<string | null>(null);
  let dockHeight = $state(0);

  $effect(() => {
    const sid = id;
    conn.generation;
    if (conn.status !== 'online') return;
    loadError = null;
    untrack(() => {
      const known = app.sessions.find((s) => s.id === sid);
      openSession(sid, known?.cwd).catch((e) => (loadError = errorText(e)));
    });
  });

  // Unsubscribe when the chat closes, so the gateway can let go of the session once it is idle.
  $effect(() => {
    const sid = id;
    return () => untrack(() => leaveSession(sid));
  });

  // Fold runs of thinking and tool calls into one collapsible "steps" block between messages.
  let blocks = $derived.by(() => {
    const out: (Exclude<Item, ToolItem> | Steps)[] = [];
    for (const it of view?.items ?? []) {
      if (it.kind === 'thought' || it.kind === 'tool') {
        const last = out[out.length - 1];
        if (last?.kind === 'steps') last.items.push(it);
        else out.push({ kind: 'steps', id: 'g' + it.id, items: [it] });
      } else out.push(it);
    }
    return out;
  });
  let busy = $derived(st.status === 'running' || st.status === 'awaiting_permission');
  let mode = $derived((st.modes ?? []).find((m) => m.id === st.mode));
  let suggestions = $derived(matchCommands(st.commands ?? [], text));

  // Live elapsed time of the running turn, counted from the prompt that started it.
  let now = $state(Date.now());
  $effect(() => {
    if (!busy) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // A backwards loop: Array.prototype.findLast needs iOS 15.4, and the app supports 15.0.
  let turnStart = $derived.by(() => {
    const items = view?.items ?? [];
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].ts;
    return null;
  });
  let elapsed = $derived(busy && turnStart ? duration(now - turnStart) : '');

  // Quick composer controls: reasoning effort and fast mode, when the agent exposes them.
  let effort = $derived(effortControl(st.configOptions));
  let effortOpt = $derived(effort?.option);
  let levels = $derived(effort?.levels ?? []);
  let effortDraft = $state<number | null>(null);
  let effortShown = $derived(effortDraft ?? effort?.index ?? -1);
  // "Medium (default)" reads as "Medium".
  const levelName = (i: number) => (levels[i] ? levels[i].name.replace(/\s*\(.*\)\s*$/, '').trim() || levels[i].value : '');
  let effortText = $derived(levels[effortShown] ? levelName(effortShown) : String(effortOpt?.currentValue ?? 'Default'));
  let effortPct = $derived(levels.length > 1 && effortShown >= 0 ? (effortShown / (levels.length - 1)) * 100 : 0);
  let fast = $derived(fastControl(st.configOptions, effortOpt));
  let fastPending = $state<boolean | null>(null);
  let fastOn = $derived(fastPending ?? fast?.on ?? false);
  let quickBusy = $state(false);
  let hasQuick = $derived(!!fast || (!!effortOpt && levels.length > 1));
  // Composer gauge: the needle and arc follow the effort level; the popover holds the slider and the fast switch.
  let gaugeOpen = $state(false);
  let gaugeBtn = $state<HTMLElement>();
  let gaugePanel = $state<HTMLElement>();
  let composerEl = $state<HTMLElement>();
  // Cap the popover at the space above the composer so a long draft can't push it offscreen.
  let quickMax = $state<number | null>(null);
  $effect(() => {
    if (gaugeOpen && composerEl) quickMax = Math.max(140, Math.floor(composerEl.getBoundingClientRect().top - 88));
  });
  let gaugeFill = $derived(effortOpt && levels.length > 1 ? Math.max(4, effortPct) : 0);
  let gaugeAngle = $derived(-90 + (gaugeFill / 100) * 180);
  $effect(() => {
    if (!hasQuick) gaugeOpen = false;
  });
  function outsideGauge(e: PointerEvent) {
    if (!gaugeOpen) return;
    const t = e.target as Node;
    if (gaugePanel?.contains(t) || gaugeBtn?.contains(t)) return;
    gaugeOpen = false;
  }
  // Modes that skip approvals tint the shield, so full access is visible at a glance.
  let openMode = $derived(!!mode && /bypass|full|yolo|danger|auto|accept/i.test(`${mode.id} ${mode.name}`));
  let quickDisabled = $derived(quickBusy || !view?.ready || conn.status !== 'online');

  async function setOption(configId: string, value: string | boolean) {
    quickBusy = true;
    try {
      await rpc('session.setConfig', { id, configId, value });
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      quickBusy = false;
    }
  }
  async function commitEffort(i: number) {
    const o = effortOpt;
    const v = levels[i];
    if (!o || !v || v.value === o.currentValue) return (effortDraft = null);
    effortDraft = i;
    await setOption(o.id, v.value);
    effortDraft = null;
  }
  async function toggleFast() {
    if (!fast) return;
    const next = !fastOn;
    fastPending = next;
    await setOption(fast.option.id, next ? fast.onValue : fast.offValue);
    fastPending = null;
  }

  // Context window meter above the composer.
  let ctx = $derived(st.context && st.context.size > 0 ? st.context : null);
  let ctxPct = $derived(ctx ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : 0);

  // Composer toolbar destinations. The router opens the Tasks screen when it sees this window event.
  let changesHash = $derived('#/s/' + encodeURIComponent(id) + '/changes');
  function openTasks() {
    window.dispatchEvent(new CustomEvent('uniharn:operations', { detail: { open: 'tasks', sessionId: id } }));
  }

  // Spoken turn status for screen readers; the header shows the same thing visually.
  let announcement = $state('');
  let announcedStatus = '';
  $effect(() => {
    const status = st.status;
    const name = harnessShort;
    untrack(() => {
      if (status === announcedStatus) return;
      const wasBusy = announcedStatus === 'running' || announcedStatus === 'awaiting_permission';
      announcedStatus = status;
      if (status === 'running') announcement = `${name} is working`;
      else if (status === 'awaiting_permission') announcement = `${name} needs approval`;
      else if (wasBusy) announcement = status === 'error' ? `${name} stopped with an error` : `${name} finished`;
    });
  });

  // Working-tree summary for the composer toolbar, refreshed whenever a tool call finishes.
  let changes = $state<{ files: number; added: number; removed: number } | null>(null);
  let toolsDone = $derived((view?.items ?? []).filter((i) => i.kind === 'tool' && (i.status === 'completed' || i.status === 'failed')).length);
  $effect(() => {
    const cwd = view?.cwd;
    toolsDone;
    conn.generation;
    if (!cwd || conn.status !== 'online') return;
    untrack(async () => {
      try {
        const s = await rpc('git.status', { cwd });
        const files: { added: number | null; removed: number | null }[] = s.repo ? s.files : [];
        changes = { files: files.length, added: files.reduce((n, f) => n + (f.added ?? 0), 0), removed: files.reduce((n, f) => n + (f.removed ?? 0), 0) };
      } catch {
        changes = null;
      }
    });
  });

  function summary(g: Steps) {
    const tools = g.items.filter((i) => i.kind === 'tool');
    const active = tools.filter((t) => t.status === 'pending' || t.status === 'in_progress').pop();
    if (active) return active.title;
    if (!tools.length) return 'Thought';
    const failed = tools.filter((t) => t.status === 'failed').length;
    return `${tools.length} step${tools.length > 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`;
  }
  const working = (g: Steps) => g.items.some((i) => i.kind === 'tool' && (i.status === 'pending' || i.status === 'in_progress'));
  const isOpen = (g: Steps, last: boolean) => openGroups[g.id] ?? (last && busy);
  /** A reply gets a Copy button once its turn is over: the next block, skipping notices such as "stopped", is a prompt or nothing. */
  function endsTurn(i: number) {
    let j = i + 1;
    while (blocks[j]?.kind === 'notice') j++;
    return blocks[j] ? blocks[j].kind === 'user' : !busy;
  }

  function onScroll() {
    if (scroller) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }
  async function toBottom(force = false) {
    await tick();
    if (scroller && (pinned || force)) scroller.scrollTop = scroller.scrollHeight;
  }
  $effect(() => {
    view?.seq;
    st.permissions?.length;
    dockHeight;
    toBottom();
  });

  function autosize() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }
  $effect(() => {
    if (input) untrack(autosize);
  });

  type Attachment = { mimeType: string; data: string; name: string; url: string };
  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
  let images = $state<Attachment[]>([]);
  const MAX_FILES = 10;
  const MAX_FILE_BYTES = 1024 * 1024;
  let docs = $state<AttachedFile[]>([]);
  let viewing = $state<Viewed | null>(null);
  let fileInput = $state<HTMLInputElement>();
  let dropping = $state(false);
  const rawSize = (b64: string) => Math.floor((b64.length * 3) / 4);

  /** Shared by the file picker, paste and drag-and-drop. */
  async function addFiles(files: File[]) {
    // Images and text share one budget so the whole prompt stays under the gateway's message limit.
    const textBytes = (t: string) => new TextEncoder().encode(t).length;
    let total = images.reduce((n, i) => n + rawSize(i.data), 0) + docs.reduce((n, d) => n + textBytes(d.text), 0);
    let skipped = 0;
    let skippedDocs = 0;
    for (const f of files) {
      if (!f.type.startsWith('image/') && isTextFile(f)) {
        if (docs.length >= MAX_FILES || f.size > MAX_FILE_BYTES) {
          skippedDocs++;
          continue;
        }
        const text = decodeText(new Uint8Array(await f.arrayBuffer()));
        if (total + textBytes(text) > MAX_TOTAL_BYTES) {
          skippedDocs++;
          continue;
        }
        total += textBytes(text);
        docs.push({ name: f.name || 'Pasted text', mimeType: f.type || 'text/plain', text });
        continue;
      }
      if (images.length >= MAX_IMAGES || !f.type.startsWith('image/') || f.size > MAX_IMAGE_BYTES || total + f.size > MAX_TOTAL_BYTES) {
        skipped++;
        continue;
      }
      total += f.size;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      images.push({ mimeType: f.type, data: btoa(bin), name: f.name || 'Pasted image', url: URL.createObjectURL(f) });
    }
    if (skipped) toast(`Up to ${MAX_IMAGES} images, 8 MB each.`, 'error');
    if (skippedDocs) toast(`Up to ${MAX_FILES} text files, 1 MB each, 20 MB with images.`, 'error');
  }

  async function onfiles(e: Event) {
    await addFiles([...((e.target as HTMLInputElement).files ?? [])]);
    if (fileInput) fileInput.value = '';
  }

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/') || isTextFile(f));
    if (!files.length || !view?.ready) return;
    // Keep normal text paste when the clipboard also carries text.
    if (!e.clipboardData?.getData('text/plain')) e.preventDefault();
    addFiles(files);
  }

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  function ondragover(e: DragEvent) {
    if (!hasFiles(e) || !view?.ready) return;
    e.preventDefault();
    dropping = true;
  }
  function ondrop(e: DragEvent) {
    dropping = false;
    if (!hasFiles(e) || !view?.ready) return;
    e.preventDefault();
    addFiles([...(e.dataTransfer?.files ?? [])]);
  }

  function removeImage(i: number) {
    const [img] = images.splice(i, 1);
    if (img) URL.revokeObjectURL(img.url);
  }

  onDestroy(() => images.forEach((i) => URL.revokeObjectURL(i.url)));

  async function send() {
    const t = text.trim();
    if ((!t && !images.length && !docs.length) || sending) return;
    sending = true;
    const keep = text;
    const keepImages = images;
    const keepDocs = docs;
    images = [];
    docs = [];
    text = '';
    await tick();
    autosize();
    pinned = true;
    try {
      // Older gateways drop `files`, so the text goes inline in the message instead.
      const inline = conn.info?.textAttachments ? '' : keepDocs.map((f) => `\n\n<attachment name="${f.name}">\n${f.text}\n</attachment>`).join('');
      await rpc('session.prompt', { id, text: t + inline, images: keepImages.map(({ mimeType, data }) => ({ mimeType, data })), ...(inline ? {} : { files: keepDocs }) });
      keepImages.forEach((i) => URL.revokeObjectURL(i.url));
      toBottom(true);
    } catch (e) {
      text = keep;
      images = keepImages;
      docs = keepDocs;
      toast(errorText(e), 'error');
    } finally {
      sending = false;
    }
  }

  async function stop() {
    try {
      await rpc('session.cancel', { id });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  function keydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    // Enter sends with a hardware keyboard and pointer; on touch keyboards it inserts a newline. Cmd/Ctrl+Enter always sends.
    if (e.metaKey || e.ctrlKey || matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      send();
    }
  }

  // Esc stops the running turn, like the Devin and Claude Code TUIs, unless a sheet is open.
  function windowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && gaugeOpen) {
      gaugeOpen = false;
      gaugeBtn?.focus();
      return;
    }
    if (e.key === 'Escape' && busy && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) stop();
  }

  async function copyReply(source: string, e: MouseEvent) {
    const btn = e.currentTarget as HTMLElement;
    if (!(await copyText(source))) return toast('Could not copy', 'error');
    btn.classList.add('done');
    setTimeout(() => btn.classList.remove('done'), 1400);
  }

  function copyCode(e: MouseEvent) {
    const btn = (e.target as Element).closest?.('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('code')?.innerText ?? '';
    copyText(code).then((ok) => {
      if (!ok) return;
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  }
</script>

<svelte:window onkeydown={windowKey} onpointerdown={outsideGauge} />
<AttachmentViewer bind:item={viewing} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="screen" ondragover={ondragover} ondragleave={() => (dropping = false)} ondrop={ondrop}>
  <header class="topbar">
    <BackButton to="#/" label="Back to sessions" />
    <button class="title press" onclick={() => (controls = true)}>
      <b>{st.title || 'New session'}</b>
      <small>
        <span class="dot {st.status}"></span>
        {#if conn.status !== 'online'}Reconnecting…{:else if st.status === 'running'}Working {elapsed}{:else if st.status === 'awaiting_permission'}Needs approval{:else}{projectLabel(view?.cwd, conn.info?.scratchDir)}{/if}
        {#if mode}<span class="sep">·</span> {mode.name}{/if}
      </small>
    </button>
    <button class="iconbtn glass" onclick={() => (controls = true)} aria-label="Session settings"><Icon name="settings" /></button>
  </header>
  <span class="sr-only" role="status">{announcement}</span>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="log scroller" bind:this={scroller} onscroll={onScroll} onclick={copyCode} style:padding-bottom={dockHeight + 20 + 'px'}>
    <div class="column">
      {#if view?.ready && st.folderMissing}
        <div class="notice warn">This session's folder had been deleted. Its conversation is shown, and the folder was recreated empty, so the agent no longer has the old files.</div>
      {/if}
      {#if !view?.ready}
        <div class="empty">
          {#if loadError}<h2>Could not open this session</h2><p>{loadError}</p><button class="btn" onclick={() => go('#/')}>Back to sessions</button>
          {:else}<span class="spinner" style="margin:auto"></span>{/if}
        </div>
      {:else if blocks.length === 0}
        <div class="empty">
          <h2>What should {harnessShort} work on?</h2>
          {#if isScratchPath(view.cwd, conn.info?.scratchDir)}<p class="small">No project</p>{:else}<p class="mono small">{view.cwd}</p>{/if}
        </div>
      {:else}
        {#each blocks as b, i (b.id)}
          {#if b.kind === 'user'}
            <div class="msg user">
              <div class="bubble">
                {#if b.images}
                  <div class="pics">
                    {#each b.images as img, n}
                      {@const src = `data:${img.mimeType};base64,${img.data}`}
                      <button class="pic" onclick={() => (viewing = { kind: 'image', src, name: `Image ${n + 1}` })} aria-label="View image"><img {src} alt="Attachment" /></button>
                    {/each}
                  </div>
                {/if}
                {#if b.files}
                  <div class="files">
                    {#each b.files as f}
                      <button class="filechip" onclick={() => (viewing = { kind: 'text', ...f })}><Icon name="file" size={14} /><span>{f.name}</span></button>
                    {/each}
                  </div>
                {/if}
                {b.text}
              </div>
            </div>
          {:else if b.kind === 'assistant'}
            <div class="msg assistant">
              <div class="md" use:localImages={{ cwd: view?.cwd, open: (src, name) => (viewing = { kind: 'image', src, name }) }}>{@html markdown(fileUrlsToPaths(b.text))}</div>
              {#if endsTurn(i)}
                <div class="msgbar">
                  <button class="copy press" onclick={(e) => copyReply(b.text, e)} aria-label="Copy reply"><Icon name="copy" size={15} /><Icon name="check" size={15} /></button>
                </div>
              {/if}
            </div>
          {:else if b.kind === 'steps'}
            {@const last = i === blocks.length - 1}
            {@const opened = isOpen(b, last)}
            <div class="steps">
              <button class="shead" onclick={() => (openGroups[b.id] = !opened)} aria-expanded={opened}>
                {#if working(b) || (last && busy)}<span class="spinner sm"></span>{:else}<Icon name="list" size={15} />{/if}
                <span class="stext">{summary(b)}</span>
                <span class="chev" class:open={opened}><Icon name="chevron" size={14} /></span>
              </button>
              {#if opened}
                <div class="sbody">
                  {#each b.items as it (it.id)}
                    {#if it.kind === 'thought'}
                      <details class="thought">
                        <summary><Icon name="brain" size={14} /> Thinking <span class="peek">{it.text.slice(0, 80)}</span></summary>
                        <div class="md ttext">{@html markdown(it.text)}</div>
                      </details>
                    {:else if it.kind === 'tool'}
                      <ToolCall item={it} />
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {:else if b.kind === 'plan'}
            <div class="plan card">
              <div class="phead"><Icon name="list" size={15} /> Plan</div>
              {#each b.entries as e}
                <div class="pitem {e.status}"><span class="box">{#if e.status === 'completed'}<Icon name="check" size={12} />{/if}</span><span>{e.content}</span></div>
              {/each}
            </div>
          {:else if b.kind === 'notice'}
            <div class="notice {b.level}">{b.text}</div>
          {/if}
        {/each}
        {#if st.status === 'running' && blocks[blocks.length - 1]?.kind === 'user'}
          <div class="typing" aria-hidden="true"><span></span><span></span><span></span></div>
        {/if}
      {/if}
    </div>
  </div>

  {#if !pinned}
    <button class="jump iconbtn glass" style:bottom={dockHeight + 12 + 'px'} onclick={() => ((pinned = true), toBottom(true))} aria-label="Scroll to latest"><Icon name="down" size={20} /></button>
  {/if}

  <div class="dock" bind:clientHeight={dockHeight}>
    <div class="dock-inner">
      {#if st.permissions?.length}
        <div class="perms">
          {#each st.permissions as p (p.reqId)}
            <Permission sessionId={id} request={p} />
          {/each}
        </div>
      {/if}
      {#if suggestions.length}
        <div class="sugg glass">
          {#each suggestions as c}
            <button onclick={() => ((text = applyCommand(text, c)), input?.focus())}><b class="mono">{commandToken(c)}</b><small>{c.description}</small></button>
          {/each}
        </div>
      {/if}
      <div class="tools" role="group" aria-label="Session tools">
        <SubagentsPanel sessionId={id} compact />
        <button class="toolchip" onclick={openTasks} aria-label="Tasks" title="Tasks"><Icon name="checkSquare" size={16} /><span class="tlabel">Tasks</span></button>
        <button class="toolchip" onclick={() => go(changesHash + '?tab=runs')} aria-label="Runs" title="Runs"><Icon name="terminal" size={16} /><span class="tlabel">Runs</span></button>
        <button
          class="toolchip"
          onclick={() => go(changesHash)}
          aria-label={changes?.files ? `Changes: ${changes.files} files, ${changes.added} added, ${changes.removed} removed lines` : 'Changes'}
          title="Changes"
        >
          <Icon name="diff" size={16} />
          <span class="tlabel">Changes</span>
          {#if changes && changes.files}<span class="delta" aria-hidden="true"><span class="plus">+{changes.added}</span><span class="minus">−{changes.removed}</span></span>{/if}
        </button>
        <span class="grow"></span>
        {#if ctx}
          <button
            class="toolchip ctxm"
            class:warn={ctxPct >= 80 && ctxPct < 95}
            class:full={ctxPct >= 95}
            onclick={() => (controls = true)}
            aria-label="Context window: {compact(ctx.used)} of {compact(ctx.size)} tokens used, {ctxPct}%. Open session settings"
            title="Context window"
          >
            <span class="ctxbar" aria-hidden="true"><i style:width={ctxPct + '%'}></i></span>
            <span class="ctxt" aria-hidden="true"><span class="ctx-tokens">{compact(ctx.used)}/{compact(ctx.size)} · </span>{ctxPct}%</span>
          </button>
        {/if}
      </div>
      <div class="composer" bind:this={composerEl}>
        <div class="box glass" class:dropping>
          {#if images.length || docs.length}
            <div class="thumbs">
              {#each images as img, i (img.url)}
                <span class="thumb">
                  <button class="pic" onclick={() => (viewing = { kind: 'image', src: img.url, name: img.name })} aria-label="View image"><img src={img.url} alt={img.name} /></button>
                  <button aria-label="Remove image" onclick={() => removeImage(i)}><Icon name="x" size={12} /></button>
                </span>
              {/each}
              {#each docs as f, i}
                <span class="thumb">
                  <button class="filechip" onclick={() => (viewing = { kind: 'text', ...f })}><Icon name="file" size={14} /><span>{f.name}</span></button>
                  <button aria-label="Remove file" onclick={() => docs.splice(i, 1)}><Icon name="x" size={12} /></button>
                </span>
              {/each}
            </div>
          {/if}
          <textarea
            bind:this={input}
            bind:value={text}
            oninput={autosize}
            onkeydown={keydown}
            {onpaste}
            rows="1"
            placeholder={dropping ? 'Drop images or text files to attach' : busy ? `Add instructions while ${harnessLabel} works…` : `Message ${harnessLabel}`}
            aria-label="Message"
            disabled={!view?.ready}
          ></textarea>
          <div class="bar">
            <button class="round attach" onclick={() => fileInput?.click()} disabled={!view?.ready} aria-label="Attach image or text file"><Icon name="plus" size={18} /></button>
            <input bind:this={fileInput} type="file" accept="image/*,text/*,.md,.markdown,.txt,.log,.csv,.json,.yaml,.yml,.toml" multiple hidden onchange={onfiles} />
            <button class="round tool" class:open-mode={openMode} onclick={() => (controls = true)} aria-label="Permission mode: {mode?.name ?? 'default'}. Open session settings" title={mode?.name ?? 'Permission mode'}>
              <Icon name="shield" size={18} />
            </button>
            <span class="grow"></span>
            {#if hasQuick}
              <button
                bind:this={gaugeBtn}
                class="round tool gauge"
                class:on={gaugeOpen}
                onclick={() => (gaugeOpen = !gaugeOpen)}
                aria-haspopup="dialog"
                aria-expanded={gaugeOpen}
                aria-label="Reasoning: {effortOpt && levels.length > 1 ? effortText : 'default'}{fast ? `, fast mode ${fastOn ? 'on' : 'off'}` : ''}"
                title="Reasoning and speed"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke-linecap="round" aria-hidden="true">
                  <path class="arc-bg" d="M4.5 16.5a7.5 7.5 0 1115 0" pathLength="100" />
                  <path class="arc" d="M4.5 16.5a7.5 7.5 0 1115 0" pathLength="100" stroke-dasharray="{gaugeFill} 100" />
                  <line class="needle" x1="12" y1="16.5" x2="12" y2="10.5" style:transform="rotate({gaugeAngle}deg)" />
                  <circle class="hub" cx="12" cy="16.5" r="1.6" />
                </svg>
                {#if fastOn}<span class="fastdot" aria-hidden="true"><Icon name="bolt" size={9} /></span>{/if}
              </button>
            {/if}
            {#if busy}
              <button class="round stop" onclick={stop} aria-label="Stop" title="Stop (Esc)"><Icon name="stop" size={15} /></button>
            {/if}
            {#if !busy || text.trim() || images.length || docs.length}
              <button class="round send" onclick={send} disabled={(!text.trim() && !images.length && !docs.length) || sending || conn.status !== 'online'} aria-label="Send"><Icon name="send" size={18} /></button>
            {/if}
          </div>
        </div>
        {#if gaugeOpen && hasQuick}
          <div
            class="quick glass-heavy"
            bind:this={gaugePanel}
            role="dialog"
            aria-label="Reasoning and speed"
            style:max-height={quickMax ? quickMax + 'px' : null}
          >
            {#if effortOpt && levels.length > 1}
              <div class="qrow">
                <span class="qlabel"><Icon name="brain" size={15} />{effortOpt.name || 'Reasoning effort'}</span>
                <b class="qval" class:busy={effortDraft !== null}>{effortText}</b>
              </div>
              <span class="track" style:--pct={effortPct + '%'}>
                <span class="rail" aria-hidden="true"><i></i></span>
                <span class="ticks" aria-hidden="true">{#each levels as lv, i (lv.value)}<i class:lit={i <= effortShown}></i>{/each}</span>
                <input
                  type="range"
                  min="0"
                  max={levels.length - 1}
                  step="1"
                  value={Math.max(0, effortShown)}
                  disabled={quickDisabled}
                  aria-label={effortOpt.name || 'Reasoning effort'}
                  aria-valuetext={effortText}
                  oninput={(e) => (effortDraft = +e.currentTarget.value)}
                  onchange={(e) => commitEffort(+e.currentTarget.value)}
                />
              </span>
              <div class="qscale" aria-hidden="true"><span>{levelName(0)}</span><span>{levelName(levels.length - 1)}</span></div>
            {/if}
            {#if fast}
              <button class="qrow fast" class:on={fastOn} role="switch" aria-checked={fastOn} aria-label={fast.option.name || 'Fast mode'} disabled={quickDisabled} onclick={toggleFast}>
                <span class="qlabel"><Icon name="bolt" size={15} />{fast.option.name || 'Fast mode'}</span>
                <span class="sw" aria-hidden="true"><i></i></span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<SessionControls bind:open={controls} sessionId={id} {view} />

<style>
  button.title {
    text-align: left;
    min-height: 44px;
    border-radius: 14px;
  }
  .sep {
    color: var(--text-3);
  }
  /* Permanent row above the composer: subagents, tasks, runs, changes and the context meter. */
  .tools {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-bottom: -2px;
  }
  .delta {
    display: inline-flex;
    gap: 5px;
    font: 600 12px var(--mono);
    font-variant-numeric: tabular-nums;
  }
  .plus {
    color: var(--green);
  }
  .minus {
    color: var(--red);
  }
  .log {
    display: flex;
    flex-direction: column;
  }
  .column {
    width: 100%;
    max-width: var(--column);
    margin: 0 auto;
    padding: 8px calc(var(--safe-right) + 16px) 0 calc(var(--safe-left) + 16px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    flex: 1;
  }
  .small {
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .msg.user {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .bubble {
    max-width: min(86%, 560px);
    padding: 10px 15px;
    border-radius: 22px 22px 8px 22px;
    background: color-mix(in srgb, var(--accent) 13%, var(--bg-elev2));
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  .msg.assistant {
    font-size: 16px;
    line-height: 1.6;
  }
  .msgbar {
    display: flex;
    margin: 4px 0 0 -8px;
  }
  .copy {
    position: relative;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-3);
  }
  .copy:active {
    background: var(--fill);
  }
  .copy :global(svg) {
    grid-area: 1 / 1;
    transition: opacity 0.2s ease, transform 0.25s var(--ease-out);
  }
  .copy :global(svg:last-child),
  .copy:global(.done) :global(svg:first-child) {
    opacity: 0;
    transform: scale(0.6);
  }
  .copy:global(.done) :global(svg:last-child) {
    opacity: 1;
    transform: none;
    color: var(--green);
  }
  .steps {
    margin: -4px 0;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    max-width: 100%;
    padding: 0 12px 0 10px;
    margin-left: -10px;
    border-radius: 999px;
    color: var(--text-2);
    font-size: 13.5px;
    transition: background-color 0.18s ease;
  }
  .shead:active {
    background: var(--fill);
  }
  .stext {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    display: grid;
    transition: transform 0.25s var(--ease-out);
    color: var(--text-3);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .spinner.sm {
    width: 13px;
    height: 13px;
  }
  .sbody {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 0 2px 12px;
    margin-left: 2px;
    border-left: 2px solid var(--line);
  }
  .thought summary {
    display: flex;
    align-items: center;
    gap: 6px;
    list-style: none;
    cursor: pointer;
    color: var(--text-2);
    font-size: 13px;
    min-height: 32px;
  }
  .thought summary::-webkit-details-marker {
    display: none;
  }
  .peek {
    flex: 1;
    min-width: 0;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thought[open] .peek {
    display: none;
  }
  .ttext {
    color: var(--text-2);
    font-size: 13.5px;
    padding: 2px 0 6px 20px;
  }
  .plan {
    padding: 12px 14px;
    font-size: 14.5px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .pitem {
    display: flex;
    gap: 10px;
    padding: 4px 0;
  }
  .pitem .box {
    flex: none;
    width: 18px;
    height: 18px;
    margin-top: 2px;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    display: grid;
    place-items: center;
  }
  .pitem.completed {
    color: var(--text-3);
    text-decoration: line-through;
  }
  .pitem.completed .box {
    background: var(--green);
    border-color: var(--green);
    color: var(--bg);
  }
  .pitem.in_progress .box {
    border-color: var(--green);
    box-shadow: inset 0 0 0 3px var(--bg-elev), inset 0 0 0 9px var(--green);
  }
  .notice {
    font-size: 13.5px;
    padding: 10px 14px;
    border-radius: var(--r-md);
    background: var(--fill);
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .notice.error {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 10%, transparent);
  }
  .typing {
    display: flex;
    gap: 5px;
    padding: 8px 2px;
  }
  .typing span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-3);
    animation: pulse 1.1s ease-in-out infinite;
  }
  .typing span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .typing span:nth-child(3) {
    animation-delay: 0.3s;
  }
  .jump {
    position: absolute;
    left: 50%;
    translate: -50% 0;
    z-index: 16;
    animation: materialize 0.25s var(--ease-out);
  }
  /* Floating dock: approvals and the composer, with the log fading out behind it. */
  .dock {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 15;
    padding: 14px calc(var(--safe-right) + 10px) calc(var(--safe-bottom) + 10px) calc(var(--safe-left) + 10px);
    pointer-events: none;
  }
  .dock::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(to top, var(--bg) 0%, color-mix(in srgb, var(--bg) 70%, transparent) 45%, transparent);
    pointer-events: none;
  }
  .dock-inner {
    max-width: calc(var(--column) + 8px);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dock-inner > * {
    pointer-events: auto;
  }
  .perms {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: calc(var(--vvh) * 0.5);
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .box {
    border-radius: 26px;
    padding: 8px 8px 8px 16px;
    transition: box-shadow 0.2s ease;
  }
  .box:focus-within {
    box-shadow: inset 0 1px 0 var(--glass-hi), inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, var(--glass-rim)), var(--glass-drop-shadow);
  }
  .box.dropping {
    box-shadow: inset 0 0 0 2px var(--accent), var(--glass-drop-shadow);
  }
  textarea {
    display: block;
    width: 100%;
    border: 0;
    outline: 0;
    resize: none;
    background: none;
    padding: 6px 0 8px;
    max-height: 180px;
    line-height: 1.45;
    font-size: 16px;
  }
  textarea::placeholder {
    color: var(--text-3);
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-left: -8px;
  }
  .thumbs {
    display: flex;
    gap: 8px;
    padding: 6px 0 8px;
    overflow-x: auto;
  }
  .thumb {
    position: relative;
    flex: none;
  }
  .thumb img {
    display: block;
    width: 58px;
    height: 58px;
    object-fit: cover;
    border-radius: 14px;
    box-shadow: 0 0 0 1px var(--line);
  }
  .thumb > button:last-child {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--text);
    color: var(--bg);
  }
  .pics {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }
  .pic {
    display: block;
    padding: 0;
    border-radius: 14px;
  }
  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }
  .filechip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    height: 36px;
    padding: 0 12px;
    border-radius: 12px;
    background: var(--fill);
    color: var(--text);
    font-size: 13px;
  }
  .filechip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thumb .filechip {
    height: 58px;
    border-radius: 14px;
    box-shadow: 0 0 0 1px var(--line);
  }
  .pics img {
    max-width: 160px;
    max-height: 160px;
    border-radius: 14px;
    display: block;
  }
  .grow {
    flex: 1;
  }
  /* Context window meter at the end of the toolbar. */
  .ctxm {
    font: 500 11.5px var(--mono);
    font-variant-numeric: tabular-nums;
  }
  .ctxbar {
    width: 36px;
    height: 3px;
    border-radius: 99px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .ctxbar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--text-2);
    transition: width 0.4s var(--ease-out), background-color 0.2s ease;
  }
  .ctxm.warn {
    color: var(--amber);
  }
  .ctxm.warn .ctxbar i {
    background: var(--amber);
  }
  .ctxm.full {
    color: var(--red);
  }
  .ctxm.full .ctxbar i {
    background: var(--red);
  }
  @media (max-width: 430px) {
    .ctx-tokens {
      display: none;
    }
  }
  /* Reasoning and speed: a gauge button in the bar opens this popover above the composer. */
  .composer {
    position: relative;
  }
  .quick {
    position: absolute;
    right: 4px;
    bottom: calc(100% + 8px);
    overflow-y: auto;
    overscroll-behavior: contain;
    z-index: 2;
    width: min(300px, calc(100vw - 32px - var(--safe-left) - var(--safe-right)));
    padding: 14px 16px 12px;
    border-radius: 22px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transform-origin: calc(100% - 60px) 100%;
    animation: materialize 0.2s var(--ease-out);
  }
  .qrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 28px;
    width: 100%;
    text-align: left;
  }
  .qlabel {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 600;
  }
  .qlabel :global(svg) {
    flex: none;
  }
  .qval {
    font-size: 13px;
    font-weight: 650;
    color: var(--text);
  }
  .qval.busy {
    color: var(--text-2);
  }
  .qscale {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--text-3);
    margin-bottom: 4px;
  }
  .qrow.fast {
    min-height: 44px;
    margin-top: 2px;
    border-top: 1px solid var(--line);
    padding-top: 4px;
  }
  .qrow.fast:disabled {
    opacity: 0.6;
  }
  .qrow.fast.on > .qlabel {
    color: var(--text);
  }
  .qrow.fast.on > .qlabel :global(svg) {
    color: var(--amber);
  }
  .track {
    position: relative;
    display: block;
    height: 32px;
    margin: 2px -2px 0;
  }
  .rail {
    position: absolute;
    left: 7px;
    right: 7px;
    top: 50%;
    height: 4px;
    margin-top: -2px;
    border-radius: 99px;
    background: var(--fill-2);
  }
  .rail i {
    display: block;
    height: 100%;
    width: var(--pct);
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.2s var(--ease-out);
  }
  .ticks {
    position: absolute;
    left: 7px;
    right: 7px;
    top: 50%;
    height: 4px;
    margin-top: -2px;
    display: flex;
    justify-content: space-between;
    pointer-events: none;
  }
  .ticks i {
    width: 4px;
    height: 4px;
    margin: 0 -2px;
    border-radius: 50%;
    background: var(--text-3);
  }
  .ticks i.lit {
    background: var(--on-accent);
  }
  .track input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
    touch-action: pan-y;
  }
  .track input:disabled {
    cursor: default;
  }
  .track input::-webkit-slider-runnable-track {
    height: 32px;
    background: transparent;
  }
  .track input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    margin-top: 9px;
    border-radius: 50%;
    background: var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--line-strong);
    transition: transform 0.2s var(--ease-spring);
  }
  .track input:active::-webkit-slider-thumb {
    transform: scale(1.15);
  }
  .track input:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 0 0 4px var(--accent-soft), 0 0 0 1px var(--line-strong);
  }
  .track input::-moz-range-track {
    background: transparent;
  }
  .track input::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: 0;
    border-radius: 50%;
    background: var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45), 0 0 0 1px var(--line-strong);
  }
  .track input:focus-visible::-moz-range-thumb {
    box-shadow: 0 0 0 4px var(--accent-soft), 0 0 0 1px var(--line-strong);
  }
  .sw {
    flex: none;
    position: relative;
    width: 22px;
    height: 14px;
    border-radius: 99px;
    background: var(--fill-2);
    transition: background-color 0.2s ease;
  }
  .sw i {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-3);
    transition: translate 0.25s var(--ease-spring), background-color 0.2s ease;
  }
  .qrow.fast.on .sw {
    background: var(--accent);
  }
  .qrow.fast.on .sw i {
    translate: 8px 0;
    background: var(--on-accent);
  }
  .round.tool {
    position: relative;
    color: var(--text-2);
  }
  .round.tool:active:not(:disabled),
  .round.tool.on {
    background: var(--fill);
    color: var(--text);
  }
  .round.tool.open-mode {
    color: var(--amber);
  }
  .gauge svg {
    width: 20px;
    height: 20px;
  }
  .gauge .arc-bg {
    stroke: var(--fill-2);
    stroke-width: 2.4;
  }
  .gauge .arc {
    stroke: var(--accent);
    stroke-width: 2.4;
    transition: stroke-dasharray 0.25s var(--ease-out);
  }
  .gauge .needle {
    stroke: currentColor;
    stroke-width: 1.8;
    transform-box: view-box;
    transform-origin: 12px 16.5px;
    transition: transform 0.25s var(--ease-out);
  }
  .gauge .hub {
    fill: currentColor;
  }
  .fastdot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--amber);
    color: var(--bg);
  }
  .fastdot :global(svg) {
    stroke-width: 2.6;
  }
  .round {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
  }
  .round.attach {
    background: var(--fill);
    color: var(--text-2);
  }
  .round.send {
    background: var(--accent);
    color: var(--on-accent);
  }
  .round.send:not(:disabled) {
    animation: pop 0.32s var(--ease-spring);
  }
  .round.send:disabled {
    background: var(--fill-2);
    color: var(--text-3);
    opacity: 1;
  }
  .round.stop {
    background: color-mix(in srgb, var(--red) 16%, transparent);
    color: var(--red);
  }
  @keyframes pop {
    from {
      transform: scale(0.7);
    }
  }
  .sugg {
    border-radius: 20px;
    overflow-y: auto;
    max-height: min(320px, calc(var(--vvh) * 0.3));
    overscroll-behavior: contain;
  }
  .sugg button {
    display: flex;
    gap: 10px;
    align-items: baseline;
    width: 100%;
    min-height: 44px;
    text-align: left;
    padding: 11px 16px;
  }
  .sugg button + button {
    border-top: 1px solid var(--line);
  }
  .sugg button:active {
    background: var(--fill);
  }
  .sugg b {
    font-size: 13px;
    flex: none;
  }
  .sugg small {
    color: var(--text-2);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

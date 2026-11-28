<script lang="ts">
  import { conn, forgetConnection, rpc } from '#lib/api.svelte.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import BackButton from './BackButton.svelte';
  import Icon from './Icon.svelte';
  import ThemePicker from './ThemePicker.svelte';
  import Devices from './Devices.svelte';
  import { compareVersions } from '#lib/pairing.ts';
  import type { Json, NotificationEventType, NotificationPrefs } from '#lib/types.ts';
  import { notif, EVENT_LABELS, savePrefs, sendTest, enablePush, disablePush, enableSystemNotifications, pushUnavailableReason } from '#lib/notifications.svelte.ts';

  let checking = $state(false);
  let testing = $state(false);
  async function testNotification() {
    testing = true;
    try {
      const r = await sendTest();
      if (!r.delivered) toast(r.reason, 'error');
      else toast(r.push?.sent ? `Test sent (also pushed to ${r.push.sent} device${r.push.sent === 1 ? '' : 's'})` : 'Test sent', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      testing = false;
    }
  }
  async function toggle(patch: Partial<NotificationPrefs>) {
    try {
      await savePrefs(patch);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  let agent = $derived(conn.info?.agent ?? null);

  // What the gateway reported about itself in hello; older gateways send none of this.
  let security = $derived(conn.info?.security ?? null);
  let securityNotes = $derived(
    security
      ? [
          security.isRoot && 'The gateway runs as root. Run it as a regular user.',
          security.publicBindWarning && 'The gateway listens on all network interfaces. Bind it to loopback or your Tailscale address.',
          !security.strictRoots && 'Folders outside the configured roots are browsable.'
        ].filter((x): x is string => !!x)
      : []
  );
  let versionWarning = $derived.by(() => {
    const info = conn.info;
    if (!info) return null;
    if (info.outdated) return 'The gateway on the VM was updated but still runs the old version. Restart it to load the update.';
    if ((info.protocolVersion ?? 1) < 2) return 'This gateway is older than the app. Update it to use pairing codes and device management.';
    if (info.minAppVersion && compareVersions(__APP_VERSION__, info.minAppVersion) < 0) return `This gateway needs app version ${info.minAppVersion} or newer. Update the app.`;
    return null;
  });

  async function recheck() {
    checking = true;
    try {
      const a = await rpc('agent.status');
      if (conn.info) conn.info.agent = a;
    } catch {}
    checking = false;
  }
  $effect(() => {
    if (conn.status === 'online') recheck();
  });
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to="#/" />
    <div class="title"><b>Settings</b></div>
  </header>
  <main class="scroller">
    <div class="column">
      <ThemePicker />

      <div class="label">Notifications</div>
      <div class="card notif">
        {#if notif.prefs}
          {@const p = notif.prefs}
          <label class="kv"><span>Notifications</span><input type="checkbox" checked={p.enabled} onchange={(e) => toggle({ enabled: e.currentTarget.checked })} /></label>
          <label class="kv"><span>In-app banners</span><input type="checkbox" checked={p.inApp} disabled={!p.enabled} onchange={(e) => toggle({ inApp: e.currentTarget.checked })} /></label>
          <label class="kv"><span>Hide details on lock screen</span><input type="checkbox" checked={p.hideSensitiveDetails} onchange={(e) => toggle({ hideSensitiveDetails: e.currentTarget.checked })} /></label>
          <p class="muted detail">When on, push and system notifications only say what kind of event happened. Tokens and passwords are always removed.</p>
          <div class="kv">
            <span>Web Push on this device</span>
            {#if notif.push.state === 'on'}
              <button class="btn turnon" disabled={notif.push.busy} onclick={disablePush}>Turn off</button>
            {:else if notif.push.state === 'off'}
              <button class="btn turnon" disabled={notif.push.busy || !p.enabled} onclick={enablePush}>Turn on</button>
            {:else}
              <b class="bad">Unavailable</b>
            {/if}
          </div>
          {#if pushUnavailableReason()}<p class="muted detail">{pushUnavailableReason()}</p>{/if}
          {#if notif.push.error}<p class="muted detail bad">{notif.push.error}</p>{/if}
          {#if notif.push.state !== 'on' && notif.permission !== 'granted' && typeof Notification !== 'undefined'}
            <div class="kv"><span>Background alerts while connected</span><button class="btn turnon" onclick={enableSystemNotifications}>Allow</button></div>
          {/if}
          <div class="sublabel">Notify me about</div>
          {#each Object.keys(EVENT_LABELS) as NotificationEventType[] as e}
            <label class="kv"><span>{EVENT_LABELS[e]}</span><input type="checkbox" checked={p.events[e]} disabled={!p.enabled} onchange={(ev) => toggle({ events: { ...p.events, [e]: ev.currentTarget.checked } })} /></label>
          {/each}
          <div class="row2"><button class="btn" onclick={testNotification} disabled={testing || !p.enabled}>Send test notification</button></div>
        {:else}
          <p class="muted detail">Connect to a gateway to manage notifications.</p>
        {/if}
      </div>

      <div class="label">Gateway</div>
      <div class="card">
        <div class="kv"><span>Status</span><b><span class="dot" class:running={conn.status === 'online'} class:error={conn.status !== 'online'}></span> {conn.status === 'online' ? 'Connected' : 'Reconnecting…'}</b></div>
        <div class="kv"><span>Address</span><b class="mono">{conn.url}</b></div>
        <div class="kv"><span>Host</span><b>{conn.info?.host}</b></div>
        <div class="kv"><span>Version</span><b>{conn.info?.version}</b></div>
        <div class="kv"><span>Protocol</span><b>{conn.info?.protocolVersion ?? 1}</b></div>
        {#if conn.info?.gatewayId}<div class="kv"><span>Gateway ID</span><b class="mono" title={conn.info.gatewayId}>{conn.info.gatewayId.slice(0, 8)}</b></div>{/if}
        {#if conn.info?.authKind}<div class="kv"><span>Signed in as</span><b>{conn.info.authKind === 'master' ? 'Master token' : (conn.info.deviceName ?? 'This device')}</b></div>{/if}
        <div class="kv"><span>Agent</span><b>{agent?.agentInfo?.title ?? agent?.agentInfo?.name ?? 'Devin'} {agent?.agentInfo?.version ?? ''}</b></div>
        {#each securityNotes as note}
          <div class="kv warn"><span><Icon name="shield" size={18} /></span><b class="bad">{note}</b></div>
        {/each}
        {#if versionWarning}
          <div class="kv warn"><span><Icon name="refresh" size={18} /></span><b class="bad">{versionWarning}</b></div>
        {/if}
      </div>

      <Devices />

      <div class="label">Projects and automation</div>
      <div class="card links">
        <button class="linkrow press" onclick={() => go('#/tasks')}>
          <span><b>Tasks</b><small>Scheduled prompts, dependencies and confirmations</small></span>
          <Icon name="chevron" size={16} />
        </button>
        <button class="linkrow press" onclick={() => go('#/profiles')}>
          <span><b>Profiles</b><small>Folder, harness, models and instructions for new sessions</small></span>
          <Icon name="chevron" size={16} />
        </button>
        <button class="linkrow press" onclick={() => go('#/teams')}>
          <span><b>Teams</b><small>Roles that work on one task together</small></span>
          <Icon name="chevron" size={16} />
        </button>
        <button class="linkrow press" onclick={() => go('#/usage')}>
          <span><b>Usage</b><small>Quota, resets, tokens and delegations per harness</small></span>
          <Icon name="chevron" size={16} />
        </button>
      </div>

      <div class="label">Harness accounts</div>
      <button class="card linkrow press" onclick={() => go('#/accounts')}>
        <span>Logins, plans and Devin usage limits</span>
        <Icon name="chevron" size={16} />
      </button>

      <div class="label">Subagents</div>
      <button class="card linkrow press" onclick={() => go('#/subagents')}>
        <span>Model each harness uses as a subagent</span>
        <Icon name="chevron" size={16} />
      </button>

      <button class="btn block danger disconnect" onclick={() => (forgetConnection(), go('#/'))}>Disconnect and forget this server</button>
    </div>
  </main>
</div>

<style>
  .notif input[type='checkbox'] {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
  .notif label.kv {
    cursor: pointer;
  }
  .sublabel {
    margin: 12px 0 4px;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .card {
    padding: 0 16px;
  }
  .kv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 48px;
    padding: 12px 0;
    font-size: 15px;
  }
  .kv + .kv {
    border-top: 1px solid var(--line);
  }
  .kv > span {
    color: var(--text-2);
    flex: none;
  }
  .kv b {
    font-weight: 500;
    text-align: right;
    overflow-wrap: anywhere;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .kv b.bad {
    color: var(--amber);
  }
  .kv.warn {
    justify-content: flex-start;
    gap: 10px;
  }
  .kv.warn > span {
    color: var(--amber);
    display: inline-flex;
  }
  .kv.warn b {
    text-align: left;
    font-size: 14px;
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
    padding: 0 0 14px;
    overflow-wrap: anywhere;
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 2px 0 14px;
  }
  .row2 .btn {
    flex: 1;
    min-height: 42px;
    padding: 0 14px;
    font-size: 14px;
    white-space: nowrap;
  }
  .card .btn {
    background: var(--fill);
  }
  .turnon {
    flex: none;
    min-height: 34px;
    padding: 0 14px;
    font-size: 14px;
  }
  .linkrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    font: inherit;
    font-size: 15px;
    color: var(--text);
    text-align: left;
    border: 0;
  }
  .linkrow :global(svg) {
    color: var(--text-2);
  }
  .links .linkrow {
    padding: 8px 0;
  }
  .links .linkrow + .linkrow {
    border-top: 1px solid var(--line);
  }
  .links .linkrow > span {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .links small {
    font-size: 12.5px;
    color: var(--text-3);
  }
  .disconnect {
    margin-top: 28px;
    background: var(--fill);
  }
</style>

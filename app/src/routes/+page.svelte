<script lang="ts">
  import { conn, configured } from '#lib/api.svelte.ts';
  import { route, sidebarShown } from '#lib/ui.svelte.ts';
  import Connect from '#lib/components/Connect.svelte';
  import Home from '#lib/components/Home.svelte';
  import Chat from '#lib/components/Chat.svelte';
  import Changes from '#lib/components/Changes.svelte';
  import Terminal from '#lib/components/Terminal.svelte';
  import Settings from '#lib/components/Settings.svelte';
  import Accounts from '#lib/components/Accounts.svelte';
  import Subagents from '#lib/components/Subagents.svelte';
  import Profiles from '#lib/components/Profiles.svelte';
  import Teams from '#lib/components/Teams.svelte';
  import Tasks from '#lib/components/Tasks.svelte';
  import Usage from '#lib/components/Usage.svelte';

  // Stay in the app while reconnecting; only fall back to pairing when there is nothing to connect to.
  let paired = $derived(configured() && conn.status !== 'unauthorized' && (conn.info !== null || conn.status !== 'offline'));
  let split = $derived(sidebarShown());
</script>

{#if !paired || (conn.info === null && conn.error)}
  <div class="shell"><Connect /></div>
{:else}
  <div class="shell" class:split>
    {#if split}
      <aside class="side"><Home embedded /></aside>
    {/if}
    <div class="pane">
      {#if route.name === 'session' && route.id && route.tab === 'changes'}
        <Changes id={route.id} />
      {:else if route.name === 'session' && route.id && route.tab === 'terminal'}
        {#key route.id}<Terminal sessionId={route.id} />{/key}
      {:else if route.name === 'session' && route.id}
        {#key route.id}<Chat id={route.id} />{/key}
      {:else if route.name === 'terminal'}
        {#key route.login + ':' + (route.install ?? '')}<Terminal login={route.login} install={route.install} />{/key}
      {:else if route.name === 'settings'}
        <Settings />
      {:else if route.name === 'accounts'}
        <Accounts />
      {:else if route.name === 'subagents'}
        <Subagents />
      {:else if route.name === 'profiles'}
        <Profiles />
      {:else if route.name === 'teams'}
        <Teams />
      {:else if route.name === 'tasks'}
        <Tasks />
      {:else if route.name === 'usage'}
        <Usage />
      {:else if split}
        <div class="screen placeholder">
          <div class="empty">
            <h2>No session selected</h2>
            <p>Choose one from the list or start a new session.</p>
          </div>
        </div>
      {:else}
        <Home />
      {/if}
    </div>
  </div>
{/if}

<style>
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
  }
  .side {
    flex: none;
    display: flex;
    width: clamp(290px, 32vw, 360px);
    margin: calc(var(--safe-top) + 10px) 0 calc(var(--safe-bottom) + 10px) calc(var(--safe-left) + 10px);
    border-radius: var(--r-xl);
    overflow: hidden;
    /* A resting surface with a glass rim. No backdrop-filter here: it would make the sidebar the containing
       block for the fixed-position sheets opened from it and clip them. */
    background: color-mix(in srgb, var(--sidebar) 72%, transparent);
    box-shadow: inset 0 0 0 1px var(--line);
    animation: side-in 0.32s var(--ease-out);
  }
  /* Inside the floating sidebar the safe area is already cleared by its margin. */
  .side :global(.screen) {
    --safe-top: 0px;
    --safe-bottom: 0px;
    --safe-left: 0px;
    --bar-h: 64px;
    background: transparent;
    animation: none;
  }
  .side :global(.topbar::before) {
    background: linear-gradient(to bottom, color-mix(in srgb, var(--sidebar) 96%, transparent) 0%, color-mix(in srgb, var(--sidebar) 70%, transparent) 55%, transparent 100%);
  }
  .split .pane :global(.screen) {
    --safe-left: 0px;
  }
  @keyframes side-in {
    from {
      opacity: 0;
      transform: translateX(-12px);
    }
  }
</style>

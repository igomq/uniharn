<p align="center">
  <img src="app/app-icon.png" alt="uniharn logo, two coral strokes that merge into one line" width="112" height="112">
</p>

<h1 align="center">uniharn</h1>

<p align="center">
  Run and steer the coding agent CLIs on your own Linux VM from an iPhone, Android device, iPad or browser, over Tailscale.
</p>

<p align="center">
  <a href="https://github.com/igomq/uniharn/actions/workflows/ci.yml"><img src="https://github.com/igomq/uniharn/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://github.com/igomq/uniharn/releases/latest"><img src="https://img.shields.io/github/v/release/igomq/uniharn" alt="Latest release"></a>
</p>

uniharn is an unofficial, community-maintained open-source project, formerly called Devin Mobile. It is not affiliated with, endorsed by or supported by Cognition (Devin), OpenAI, Anthropic, AWS (Kiro), Google, xAI, Mistral or any other AI provider.

The app is a chat-first remote control. Every model call and file change happens in the harness CLIs installed on your VM. A small gateway on the VM talks to those harnesses through the Agent Client Protocol (ACP) and structured adapters, and keeps sessions running while your phone is away.

```
 app (Tauri v2 + SvelteKit) ──WebSocket over Tailscale──▶ uniharn gateway (Node) ──HarnessRegistry──▶ ACP and CLI harnesses
                                                           ├─ workspaces, profiles, teams and sessions
                                                           ├─ task scheduler and usage reports
                                                           ├─ Git status, diffs and GitHub PRs
                                                           ├─ test runner
                                                           └─ PTY terminals
```

The repository has two packages.

- [gateway/](gateway/README.md) (`uniharn-gateway`) is the VM-side service. It wraps every harness behind one adapter layer, keeps sessions alive while clients disconnect, replays history on reconnect and serves the web UI.
- [app/](app/README.md) (`uniharn-app`) is the SvelteKit interface, packaged for iOS, iPadOS and Android with Tauri v2 under the app identifier `me.gomq.uniharn`.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Install the app](#install-the-app)
- [Pairing](#pairing)
- [Development](#development)
- [Releasing](#releasing)
- [Verification status](#verification-status)
- [Security](#security)
- [Migrating from Devin Mobile](#migrating-from-devin-mobile)
- [Contributing](#contributing)
- [License](#license)

## Features

### Sessions and projects

- Start a session in a folder under the gateway's `--roots`, or in a fresh scratch folder with no project. Resume, switch between, end and delete sessions, and see each one's live status.
- Search sessions by title or folder. Sessions waiting for your approval are listed first, and the rest are grouped by project.
- Select several sessions and delete them together.

### Harnesses

- One app for Devin CLI, OpenAI Codex CLI, Claude Code, OpenCode, Kiro CLI, Grok CLI and Mistral Vibe CLI over ACP, plus any ACP agent you add with its own command, arguments, working directory and environment allowlist. Command Code and Google Antigravity are listed but stay off until they ship an ACP entry point.
- Modes, models and options come from what each agent reports, so every harness shows its own pickers.
- A missing CLI shows an **Install & setup** action that runs its installer and sign-in command in the terminal. Sign-in errors say how to log in.
- [docs/HARNESSES.md](docs/HARNESSES.md) lists tested versions and known limits.

### Profiles

- A profile saves a project folder with its harness, model, subagent model, standing instructions, default branch, Git workflow notes, common commands and an environment variable allowlist. It can also be bound to a workspace.
- Pick a profile next to **New session** to start sessions in its folder with those settings, or start one directly from the Profiles screen.
- The instructions, Git notes, default branch and common commands are sent ahead of the first prompt.

### Teams

- A team is a set of roles that work on one task at the same time. Each role has its own name, harness, model, reasoning effort, mode and instruction.
- Start a team with a task, a folder and an optional profile. Each role runs as a delegated session. With a parent session the roles appear as its subagents, and without one they are listed as ordinary sessions.

### Scheduled tasks

- A task sends one or more prompts to a session right away, after a delay, at a set time, or when you release it from hold.
- Tasks can wait for other tasks to finish, and fail if one of those fails or is canceled. The editor only offers dependencies that cannot form a loop.
- A step marked **Confirm first** pauses the task until you confirm it, which suits destructive or expensive steps.
- Steps can retry with a delay, run under a profile, or be delegated to every role of a team.
- The Tasks screen filters by **Active**, **Needs you** and **Finished**, shows each task's steps, dependencies and log, and offers confirm, release, resume, edit, duplicate, cancel and delete as the task's state allows.
- The chat toolbar's **Tasks** button opens the tasks for that session, and scheduled task notifications open the same view.

### Usage

- The Usage screen shows, for each harness, the official quota and reset time where the harness reports them, plus the account, plan and credit.
- Enter values the harness does not report by hand, such as a usage percentage, token counts, a reset time, the plan, the credit left or a note. Official figures take precedence, every value is labeled with its source, and **Reset manual values** clears them.
- Session and delegation totals per harness, counted by the gateway since it started.
- The Harness accounts screen shows each harness's sign-in state as its own CLI reports it.

### Handoff and subagents

- Hand a session off to another harness. The new session starts in the same folder with the transcript and an optional next instruction.
- Delegate a task to a subagent on any harness, optionally in its own Git worktree so its edits stay off your branch. Subagents appear under their parent session with their status and result, and a notification arrives when one finishes.
- Every ACP harness gets a `uniharn` MCP server with `delegate_task`, `list_harnesses` and related tools, so agents can delegate to each other. Ask in the chat ("have Codex review this") and the agent starts the subagent itself.
- **Settings › Subagents** sets the model each harness uses as a subagent, separately from your chat sessions. A delegation can also pick a model for one run.

### Chat and control

- Streamed replies with Markdown and highlighted code, collapsible thinking and tool calls, and live elapsed time while the agent works.
- Attach, paste or drop images. Each session keeps its unsent draft.
- Send more instructions while the agent works, stop a turn, and allow or reject permission requests. Approval cards show the command or diff the agent wants to run or apply.
- Change the mode, model, reasoning effort and speed. For Devin the model picker lists single models and Fusion (main plus sidekick) pairs separately.

### Review

- A +/− diff summary in the chat header opens the Changes screen.
- The Changes screen has **Files**, **History**, **Branches**, **Worktrees**, **PRs** and **Runs** tabs. Stage, unstage and discard, commit and amend, switch and create branches, fetch, pull and push, resolve merge, rebase and cherry-pick conflicts, compare and merge worktrees, and list, view, create and link GitHub PRs through `gh`. Destructive actions ask first, and force pushes use `--force-with-lease`.
- **Runs** executes tests or other commands on the VM and streams their output. The gateway detects a test command for npm, pnpm, yarn, Bun, Cargo, Go, pytest and Makefile projects, and you can enter your own.

### Notifications

- In-app banners and a notification center for approvals, finished and failed runs, scheduled tasks, subagent results, Git conflicts, a lost gateway and sessions that have waited too long.
- Web Push to browsers and Home Screen PWAs over HTTPS (through `tailscale serve`), with per-event switches and lock-screen-safe text. Native FCM and APNs push need extra setup, described in [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md).

### Terminal and reconnect

- A PTY on the VM running a shell or the interactive `devin` TUI, for anything the app does not cover, such as signing in to a harness or setting up MCP servers.
- Sessions keep running while the phone is away. Reopening the app replays what you missed, and pending approvals wait for you.

### Interface

- Layouts for phones and tablets. On wide screens the session list stays in a collapsible sidebar next to the open session.
- A translucent Liquid Glass style with code-editor themes (uniharn, Absolutely, Ayu, Catppuccin, Dracula, Everforest, GitHub, Gruvbox and Linear) that also color the terminal and syntax highlighting. Search themes, follow the system light or dark setting, and pick any accent color. The app respects Reduce Transparency, Reduce Motion and Increase Contrast. See [docs/themes.md](docs/themes.md).
- Hardware keyboard shortcuts.

  | Shortcut | Action |
  | --- | --- |
  | Cmd/Ctrl+N | New session |
  | Cmd/Ctrl+K | Search sessions |
  | Cmd/Ctrl+, | Settings |
  | Cmd/Ctrl+\ | Toggle the sidebar |
  | Esc | Stop a running turn |

### Out of scope

- File editing, a file browser and other IDE features. The agents make the changes.
- Several users or VMs per gateway. All paired devices have the same rights.
- TLS on the gateway. Traffic is plain WebSocket inside the tailnet, as described under [Security](#security).
- A model API of its own. Every request goes through a harness CLI on the VM.

## Requirements

On the VM you need:

- Linux with at least one harness installed and signed in, such as [Devin CLI](https://docs.devin.ai/cli), Codex CLI with [`codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp), Claude Code with [`claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp), [OpenCode](https://opencode.ai), Kiro CLI, Grok CLI, [Mistral Vibe CLI](https://docs.mistral.ai/vibe) or another ACP agent.
- Node.js 22.17 or later with npm to build the web UI. The gateway alone runs on Node.js 20. It depends on the native module `node-pty`, and when npm finds no prebuilt binary for your platform it compiles one with Python 3, `make` and a C++ compiler.
- Git for the Changes screen and worktrees, and a signed-in GitHub CLI (`gh`) for the PRs tab.
- [Tailscale](https://tailscale.com/download), signed in to the same tailnet as your phone or tablet.

On the phone or tablet you need Tailscale on the same tailnet, plus one of these.

- An Android device with a 64-bit ARM (arm64) processor
- An iPhone or iPad you can sideload apps onto
- Any recent browser

## Getting started

### Set up the gateway

1. Install Tailscale on the VM and on your phone, and sign in to the same tailnet on both.
2. Install the harnesses you want on the VM and sign in to each, for example with `devin auth login`, `codex login` or `claude /login`. [gateway/README.md](gateway/README.md#harnesses) lists the install command for each harness.
3. Clone the repository and run the installer. It builds the web UI and the gateway, installs the `uniharn` command into `~/.local/bin`, installs the Codex and Claude Code ACP adapters when those CLIs are present, and finishes with `uniharn doctor`.

   ```bash
   git clone https://github.com/igomq/uniharn.git
   cd uniharn
   scripts/install-gateway.sh            # add --systemd to also install and start a user service
   ```

4. Start the gateway and pair your phone.

   ```bash
   uniharn
   ```

   In a terminal, `uniharn` shows the gateway URL, the number of paired devices and a pairing panel. Press Enter to show or hide a one-time pairing QR code (valid for 5 minutes), `t` to show or hide the master token and `q` to stop. While no device is paired the QR code appears right away. If the gateway already runs as a service, `uniharn` opens the same panel for it instead of starting a second gateway. `uniharn pair` prints a single QR code and pairing code, and `--no-console` runs the gateway without the panel.

By default the gateway listens on port 8787 on `127.0.0.1` and on the VM's Tailscale IPv4 address. It binds to other interfaces only when you pass `--host`. On first start it generates a master token and stores it in `~/.local/share/uniharn/token` with mode 0600.

The gateway looks up its Tailscale address once at startup with `tailscale ip -4`. If Tailscale is not up yet, it listens on `127.0.0.1` only, so restart it after Tailscale connects or pass the address with `--host`.

[gateway/README.md](gateway/README.md) documents every option, including `--roots`, which sets the folders the app can open as projects.

### Keep the gateway running

Sessions and scheduled tasks only run while the gateway runs, so run it as a service, or at least inside `tmux`. `scripts/install-gateway.sh --systemd` (or `uniharn service install`) writes and starts `~/.config/systemd/user/uniharn-gateway.service`.

```bash
loginctl enable-linger "$USER"   # keep user services running after you log out
journalctl --user -u uniharn-gateway.service -f
uniharn pair                     # or just "uniharn" for the pairing panel
```

When it looks for harness CLIs and ACP adapters, the gateway adds your login shell's `PATH` and the usual install folders (`~/.local/bin`, `~/.local/opt/node/bin`, `~/.npm-global/bin`, nvm, Bun, Volta and `/usr/local/bin`). A service, `tmux` or a console without your shell profile therefore still finds them. Set `UNIHARN_LOGIN_SHELL_PATH=0` to skip reading the login shell.

## Install the app

Download the latest build from the [Releases page](https://github.com/igomq/uniharn/releases/latest).

- **Android.** Install the arm64 APK. The first time, Android asks you to allow installs from your browser or file manager.
- **iOS and iPadOS.** The IPA is unsigned. Sign and install it with [AltStore](https://altstore.io), [SideStore](https://sidestore.io), [Sideloadly](https://sideloadly.io) or your own certificate. Apps signed with a free Apple ID expire after seven days and must be refreshed.
- **Browser.** Open `http://<tailscale-ip>:8787` in Safari or Chrome on a device in your tailnet. The gateway serves the same interface, and on iOS you can add it to the Home Screen.

## Pairing

1. On the VM, run `uniharn` and press Enter, or run `uniharn pair`. Either prints a one-time code and a QR code for `http://<gateway>/#pair=<CODE>`, valid for 5 minutes by default (`--ttl 30..900` seconds).
2. In the app, scan the QR code, paste the link or type the code. Opening the link in a browser served by the gateway pairs automatically.

Each device gets its own token. **Settings › Devices** lists paired devices and can rename or revoke them, rotate this device's token and pair another device. A revoked device is disconnected immediately. `uniharn devices list|revoke|revoke-all` does the same from the VM.

You can also connect with the gateway address and the master token under **Use an access token instead**. Forgetting the gateway in Settings removes its token and the cached sessions from the device.

## Development

### Repository layout

```
app/                  SvelteKit UI and Tauri v2 shell
  src/lib/            connection, timeline, scheduler, usage and UI state
  src/lib/components/ screens and shared components
  src/routes/         the single page that hosts the app
  src-tauri/          Tauri config, Rust entry point, iOS Info.plist, Android MainActivity.kt
  static/             icons, web manifest and service worker
  test/               unit tests for the app's pure modules
gateway/              VM-side Node service
  src/                WebSocket server, harness adapters, sessions, scheduler, Git, tasks, terminals
  test/               unit and end-to-end tests
docs/                 harness, notification and theme guides
.github/workflows/    CI and mobile builds
```

### App

```bash
cd app
npm ci
npm run dev      # Vite dev server on http://localhost:5173
npm run check    # svelte-check type checking
npm test         # unit tests
npm run build    # static build in app/build
```

From the dev server, enter the address of a running gateway on the connect screen.

Native builds need the Android SDK and NDK, or Xcode on macOS. The `src-tauri/gen` folder is not committed, so generate the platform project once before the first run.

```bash
cd app
npx tauri android init   # or: npx tauri ios init
npx tauri android dev    # or: npx tauri ios dev
```

[app/README.md](app/README.md) describes what the CI build changes in the generated Android project.

### Gateway

```bash
cd gateway
npm ci
npm run dev        # run src/index.ts with tsx
npm run typecheck  # tsc --noEmit
npm test           # unit and end-to-end tests
npm run build      # compile to gateway/dist
```

The [CI workflow](.github/workflows/ci.yml) runs type checks, tests and builds for both packages on every pull request and on pushes to `master`.

## Releasing

1. Update the version in `app/src-tauri/tauri.conf.json`, `app/package.json`, `gateway/package.json` and the `VERSION` constant in `gateway/src/index.ts`, and add a `## [X.Y.Z] - YYYY-MM-DD` section to [CHANGELOG.md](CHANGELOG.md).
2. Push a tag named `vX.Y.Z`.

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The [Mobile builds](.github/workflows/mobile.yml) workflow builds `uniharn-X.Y.Z-arm64.apk` and `uniharn-X.Y.Z-unsigned.ipa` and attaches them to a GitHub Release for the tag. The release notes come from the matching CHANGELOG.md section, followed by short install instructions. Running the workflow by hand from the Actions tab produces the same builds as workflow artifacts without a release.

By default each build signs the APK with a throwaway key, so Android refuses to install a new APK over the previous one. Add these repository secrets to sign with a stable key so that updates install in place.

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ANDROID_KEY_ALIAS` | The alias of the signing key |
| `ANDROID_KEY_PASSWORD` | The password of the signing key |

## Verification status

- The full session flow (create, prompt, tool run, approve and reject, diff, stop and follow up, reload, gateway restart) was run against a signed-in Devin CLI 3000.14 with the web UI in a phone-sized browser on the gateway host.
- OpenCode 1.19.6 ran prompts and a worktree subagent that called the `uniharn` MCP server. Claude Code 2.1.330 (Claude Agent ACP 0.23.1) and Codex 0.171.0 (`@agentclientprotocol/codex-acp`, ChatGPT sign-in) ran real sessions with streaming, model changes and cleanup, and Claude also covered permission approval and cancel. Grok CLI 1.0.92 answered ACP initialize while signed out, and its sign-in and prompts were not tested. Kiro CLI was not tested. [docs/HARNESSES.md](docs/HARNESSES.md) has the details.
- Pairing, device revocation, notifications, themes and the Git screens were run in a phone-sized Chromium against a local gateway.
- The Profiles, Teams, Tasks and Usage screens were run in Chromium at phone (390×844) and tablet (1024×768) sizes against a local gateway with a mock Devin CLI. The run covered creating and editing a profile with every field, starting a session from a profile, creating a two-role team and opening its start sheet, opening Tasks from the chat toolbar, a two-step task that paused for confirmation and then finished, a held task that depended on it and ran after release, deleting a task, and entering, validating and resetting manual usage values. Starting a team against real harnesses was not part of that run.
- Not yet verified: the Tailscale path from a real phone, and installing and running the APK and IPA that CI builds.

## Security

The gateway has no TLS. Traffic between the phone and the VM is plain HTTP and WebSocket and relies on the tailnet, which WireGuard encrypts, for confidentiality. Keep the default bind (localhost and the Tailscale IP) and never expose the gateway on a public interface.

A master or device token gives full control of every harness and a shell on the VM as the user that runs the gateway. Treat it like an SSH key, and revoke devices you no longer use. Profile environment allowlists pass only the named variables from the gateway to a harness, and the gateway refuses names such as `NODE_OPTIONS` or `LD_PRELOAD` that could change how a process loads code.

Harness credentials stay on the VM. [SECURITY.md](SECURITY.md) describes the threat model and how to report a vulnerability privately.

## Migrating from Devin Mobile

Version 0.3.0 renamed Devin Mobile (0.2.x) to uniharn. Existing installs carry over as follows.

- **Environment variables.** Each `UNIHARN_*` variable (`UNIHARN_HOST`, `UNIHARN_PORT`, `UNIHARN_TOKEN`, `UNIHARN_ROOTS`, `UNIHARN_STATIC`, `UNIHARN_DATA_DIR`) falls back to its legacy `DEVIN_MOBILE_*` name.
- **Token and data folder.** On first start, the gateway copies `~/.local/share/devin-mobile/token` to `~/.local/share/uniharn/token` (mode 0600) when the new token does not exist yet.
- **Commands.** `uniharn gateway` and `uniharn-gateway` are joined by the legacy alias `devin-mobile-gateway`.
- **Web UI storage.** Existing `devin-mobile.*` `localStorage` keys (connection, theme, accent, sidebar and drafts) move to `uniharn.*` automatically.
- **Native app.** The app identifier changed from `me.gomq.devinmobile` to `me.gomq.uniharn`, so the new APK or IPA installs next to the old app. Remove the old app and pair once more.

## Contributing

Bug reports, fixes and improvements are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, conventions and pull request process, and everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

uniharn is released under the [MIT License](LICENSE). Copyright (c) 2026 GomQ.

Devin, Codex, Claude, Kiro, Grok, Mistral Vibe and the other product names in this document are trademarks of their respective owners and are used only to identify the tools uniharn connects to.

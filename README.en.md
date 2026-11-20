[简体中文](README.md)

# dsh-acp-resume

A **resumable ACP subagent backend** for DeepSeek Harness (DSH): an independent sibling of the official `@deepseek-ai/dsh-subagent-acp`. It keeps the official one-shot delegation behavior intact and adds a **persistent session pool**: the agent process is kept alive, the remote session id is saved to disk, and after the process dies the session is reconnected through `session/load`. This lets the model collaborate with the same external ACP agent over many turns. It uses standard ACP methods, with first-class private-protocol adaptations for kiro-cli and agy / Antigravity, plus Codex as a third first-class backend over its private app-server protocol; other ACP agents use the generic compatibility path. Point Config `command` at another ACP agent, and set `agentEngine: none` to stop appending `--agent-engine` (kiro's engine flag) for agents that do not accept it.

Install with `dsh plugin --profile <name> add dsh-acp-resume` (requires DSH `>=0.2.2-rc.3` and Node >= 24).

Note: the design documents linked below (DESIGN.md, DECISIONS.md, IMPLEMENTATION-PLAN.md, PANEL-DESIGN.md) are written in Chinese.

Status: 0.3.5. Connection primitives, the session pool, five tools, the persistent chats panel, and wiring are implemented. Three first-class backends (kiro / agy / Codex, multi-backend) are supported, along with an optional ACP Dispatcher mode (dispatch only, see "ACP Dispatcher mode" below); `pnpm test` passes all 500 tests.

**Known limitations and next steps**: the full real-machine kiro-cli smoke script (create a session → two turns → kill the process → reconnect and recall the context → idle release → reconnect again) has not been fully run yet, and that behavior is covered by mock-server tests. agy protocol probing, multi-turn use, and `session/load` after SIGKILL have been verified. The Codex backend has only been verified against a mock; a real-machine probe is pending. Generic Other ACP backends still require verification against their own capabilities. Progress is tracked in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).

## Motivation

The official ACP backend starts a new process for every delegation, runs a single turn, and destroys the process when it ends. The remote session is stored on the other side (kiro's `session/load` was verified to work), but it is never reused. This package adds that layer:

- The external agent's session id is persisted in `$DSH_HOME/storages/acp-resume/registry.json`. Each session's turn history (messages and answer text, in plain text) is stored separately in `turns/<chatId>.jsonl` in the same directory, keeping the latest 200 entries for the panel's detail page, and is deleted together with the session;
- The session process is kept alive while idle (released after a timeout; the session record stays);
- The next conversation reconnects automatically: respawn → `initialize` → `session/load(original session id + original cwd)` → continue. A protocol-level load rejection falls back to a new session. If the same chat has three consecutive `error` turns in the current pool instance, its next send also skips load and starts a new session, with the leading phrase `remote session failed repeatedly, started fresh`; the count is memory-only and starts over after an application restart. Any other failure errors out for that attempt and leaves the session record untouched (D6).

## Architecture (fully isolated from, and coexisting with, the official package)

```
                    ┌ one-shot provider (registered as acp-resume, same behavior as the official subagent-acp)
This plugin ────────┤
                    └ persistent session pool + model tools (registered on ctx.tools, not via ctx.subagents)
```

The official package and the existing kiro path are left completely untouched. The design rationale and all decisions are in [DESIGN.md](DESIGN.md) and [DECISIONS.md](DECISIONS.md).

## Model tools (delivered in stage two)

| Tool | Purpose |
|---|---|
| `acp_chat_start` | Create a persistent session and return its handle, chatId |
| `acp_chat_send` | Send a message to a session; after the process dies, reconnects automatically and restores the context. When the host has a jobs service, it returns a background job id immediately and streams the answer into that job. Do not hard-`wait` on it (a wait on a running one is rejected); a notification in the conversation wakes the model when it finishes, then read it with `job_output` without `wait`, and stop it with `job_kill` (D22). Without a jobs service it waits and returns the final answer (D17) |
| `acp_chat_list` | List active and persisted chats created by the current DSH session. Legacy and other-session chats are not discoverable here, but remain operable when their chatId is known |
| `acp_chat_close` | Release the session process (the record stays and can be reconnected; `purge` also deletes the record) |
| `acp_chat_steer` | Add an instruction to a turn **in flight**: the queued message takes effect at the next tool/message boundary without interrupting the current step; to stop immediately use `job_kill` / `acp_chat_close`. Errors when there is no turn in flight (use send instead); when the agent does not implement the private extension `_session/steer`, it reports "the current agent does not support steering" (D19) |
| **Persistent chats panel** (right sidebar, D15/D18) | A per-session view of status / turn count / summary, the sent message and elapsed time of a running turn, with release and delete; click a card to open that session's detail tab (metadata + running turn + each settled turn's question and answer, outcome, reconnect events). See [PANEL-DESIGN.md](PANEL-DESIGN.md) |

## Configuration

There are two ways to mount the plugin, pick one (see "Install and upgrade" below): when the bundle is enabled, write a **top-level** override with the same id in the profile's `cordis.patch.yml`; when the bundle is not enabled, wire it by hand with `- insert:`. The example below is the manual wiring, with every field:

```yaml
- insert:
    - id: subagent-acp-resume
      name: 'dsh-acp-resume'
      config:
        command: /path/to/agent-cli  # required: the child agent executable
        args: [acp]                  # default []
        agentEngine: v3              # default v3; one of v1 / v2 / v3 / none. Appends --agent-engine <value> when spawning the child; if args already contains that flag, args wins and nothing is appended; none = never append, for agents that do not accept the flag (D19)
        model: glm-5                 # appends --model <id>; only agents accepting this CLI flag support it (kiro v2 engine); kiro v3 and agy reject it, use modelSelect: session
        effort: high                 # appends --effort <level>; only agents accepting this CLI flag support it (kiro v2 engine); do not set for kiro v3 or agy
        modelSelect: flag            # default flag (model goes out as --model); session = no flag, switch to model via session/set_model after the session opens (falls back to set_config_option); use this for kiro v3 and agy
        providerName: acp-resume     # default acp-resume; does not conflict with the official acp
        permission: allow            # default bundle policy: automatically selects an allow option; reject or ask are also supported (see below)
        env: {}                      # variables layered on top of the sanitized parent environment (e.g. the child agent's own key)
        enableChatTools: true        # default true; when false only the one-shot provider is registered
        toolPrefix: acp_chat_        # default acp_chat_; the prefix of the five tool names
        allowChatJobWait: false      # default false; when false, job_output wait:true and wait_agent are rejected while an acp-chat job runs (D22), true lifts the block
        workflow: false              # default false, enable explicitly; workspace roles and workflows (D27): send/close accept role instead of chatId and set up a role's chat from .agents/acp-team.yml on first reference; false keeps the pre-D27 tool definitions
        idleTimeoutMs: 600000        # default 600000; how long idle before the process is released
        disposeEofGraceMs: 6000      # default 6000; how long to wait for the child to wrap up by itself after stdin is closed
        disposeGraceMs: 3000         # default 3000; grace for observing failure/escalation signals, and also the upper bound close waits for an in-flight turn to settle
        registryPath: ''             # default empty string = $DSH_HOME/storages/acp-resume/registry.json; a custom value must be an absolute path
        backends:                    # optional named backends; see “Backend support levels” below for recipes
```

`agentEngine` applies to both the one-shot provider and the persistent sessions. The default `v3` appends `--agent-engine v3` to the child process; this is kiro-cli's engine selection flag. When you use another ACP agent that does not accept the flag (most will exit on an unknown argument), set `agentEngine` to `none` and it is no longer appended. `none` only affects the appending: a `--agent-engine` that you write yourself in `args` is passed to the child process as is. When reconnecting an old session, the fingerprint check ignores this flag, so switching engines does not make an old session get rejected; if the new engine cannot read the old session, it degrades to a new session under the usual rule.

**The `permission` policies.** `allow` selects the first `allow_once` or `allow_always` option automatically. `reject` (the schema fallback default) declines every request. `ask` forwards each request to the host's user-confirmation interface and waits for one choice; if that service, its answerer, or a valid answer is unavailable, it denies the request. The bundled `cordis.patch.yml` sets `permission` to `allow` for kiro-cli. With manual `- insert:` wiring, leaving the field out uses the conservative `reject` default.

### Starter recipes

These recipes are **top-level overrides** for a profile whose bundle is already enabled. Do not add another `- insert:` block.

**Use the default kiro-cli.** No override is needed when `kiro-cli` is installed and available on `PATH`; the bundled configuration already uses `command: kiro-cli` and `args: [acp]`.

**Use a specific kiro-cli executable.** When `kiro-cli` is installed outside `PATH`, override its absolute path:

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/kiro-cli
    args: [acp]
```

**Use another ACP agent and ask before each permission.** Override its executable and arguments, disable kiro's engine flag when that agent does not accept it, and forward permission requests to the host user-confirmation interface:

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/other-acp-agent
    args: [acp]
    agentEngine: 'none'
    permission: ask
```

> **Compatibility:** `model` and `effort` work by appending the `--model` / `--effort` CLI flags and are **only effective for agents that accept those flags** (verified for the kiro v2 engine). Some agents, including agy and kiro v3, reject them. Do not set either field directly on those backends: the rejected flag is appended and startup fails. Like agy, kiro v3 needs `modelSelect: session` to use the session-level method; setting model/effort directly appends CLI flags, which v3 rejects. For agy / kiro v3 set `modelSelect: session` (default `flag`): no `--model` is appended, and after `session/new` / `session/load` the plugin calls `session/set_model` with `model`; if the agent answers `-32601` (method not found) or `-32603` (what kiro v3 actually returns), it falls back to `session/set_config_option {sessionId, configId: "model", value}`. kiro v3 is adapted through set_config_option (kiro v3 rejects `--model` / `--effort`; the parameter shape is probe-verified). If both fail, the plugin only warns and does not block the connection.

`model` / `effort` also apply to both paths and are **spawn-level** choices (they act on the session the child process starts). When either is unset, its flag is not appended, which keeps kiro's `auto` (the server picks the model per task dynamically, and `effort` is not under your control); when set, the model/level is pinned. **Effective semantics**: they only apply to the next process that starts. A session process that is already running is not affected, and a session you are continuing has to wait until it is released when idle and reconnected by the next `acp_chat_send` (a new process) before the new model is applied. Like `--agent-engine`, the fingerprint check also ignores `--model` / `--effort` (reason in D19): `auto` already switches models per task within a session, so pinning a different model does not make it "a different agent", and old sessions stay continuable.

`allowChatJobWait` (D22): one conversation turn often runs for ten-odd minutes, and a model hard-waiting with `job_output`'s `wait: true` hits the host's 600-second ceiling, during which the user's new messages queue up. By default, a wait on a **running** acp-chat job is rejected before the tool is dispatched, and the model is told to wait for the completion notification. While an acp-chat job (including `acp_workflow`) is running, `wait_agent` is rejected too. Jobs that have already settled and jobs of other kinds (such as bash) are not affected. Set `true` to turn this block off.

`backends` is an optional named table that lets different chats bind to different ACP agents; top-level command/args settings remain the default backend. With multiple backends, `acp_chat_start` accepts an optional `backend` parameter. Names and descriptions are neutral, never recommendations or priority labels.

### Backend support levels

#### First-class support (private-protocol adaptations)

| Backend | Private extension support | Special configuration |
|---|---|---|
| **kiro-cli** (default backend) | Mid-turn `_session/steer`; `--agent-engine v3`; cross-process `session/load`; on v3, model/effort go through session-level `session/set_config_option`, not CLI flags | `agentEngine: v3` is the default. **v3 (default)**: pick the model with `modelSelect: session` + `model` (switched via `session/set_config_option`, probe-verified); effort is also a session-level config option (`configId: "effortLevel"`), not a CLI flag. ⚠️ Do not set `model` / `effort` on a v3 backend without `modelSelect: session`: the `--model` / `--effort` flags v3 does not support get appended and startup fails; do not set the `effort` field on v3 at all. **v2 (legacy)**: supports the `--model` / `--effort` CLI flags, but downgrading to v2 is not recommended. Clean up remote sessions with `kiro-cli chat --list-sessions` / `--delete-session` |
| **agy / Antigravity** | The normalization layer automatically converts flat updates to the nested shape; per-session `session/set_model`; cross-process `session/load` (verified after SIGKILL) | **Must** use `agentEngine: 'none'`. Pick the model with `modelSelect: session` + `model` (switched via `session/set_model`). ⚠ Do not set `model` without `modelSelect: session`: the `--model` flag agy rejects gets appended and startup fails. Never set `effort`; effort is embedded in the model id, such as `gemini-4-carbon-high` for the Carbon model at high effort. `permission: ask` is recommended because permission requests can include questions for the user. The default model is `gemini-4-carbon-medium`; its 18 available models include the Gemini 4 Carbon/Argon/Hydrogen families, Claude Sonnet/Opus 4.6, and GPT-OSS 120B. |
| **Codex** (`protocol: codex`, named backends only) | Speaks `codex app-server`'s private JSON-RPC protocol, not ACP: native `turn/steer` (adds input without interrupting running commands); `thread/resume` across processes; per-item `item/*/requestApproval` approvals (`permission: ask` asks the user each time: allow / reject this step / cancel the whole turn) | **Must** set `model` (Codex's own default is unavailable on some accounts). Optional `sandbox` (`read-only` default / `workspace-write` / `danger-full-access`), `approvalPolicy` (`never` default / `untrusted` / `on-request` / `on-failure`), `effort` (reasoning level sent on every `turn/start`; full range `low` / `medium` / `high` / `xhigh` / `max` / `ultra`, where `ultra` is supported by only some models, see "Where to look up models" below). `args` defaults to `[app-server]`; no `--agent-engine` / `--model` / `--effort` is appended. `reject` answers decline (that step is refused, the turn continues); `ask` cancels the whole turn when no confirmation service is available or the answer is invalid. Verified against a mock only; a real-machine probe is pending, and the private protocol carries no stability promise, so retest after upgrading Codex. |

#### Where to look up models

| Backend | Where to look | Effort |
|---|---|---|
| kiro | Models are dynamic (`auto`): when `model` / `effort` are unset, the server picks per task | Left to the server when unset |
| agy | `models.availableModels` in the `initialize` response | Embedded in the model id (e.g. `gemini-4-carbon-high`) |
| Codex | `model/list` from `codex app-server` (the 0.170.0 measured list is below) | Sent on every `turn/start` |

Codex 0.170.0 measured `model/list`: default `gpt-6.2-sol`; also `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-reserve`, `codex-auto-review`. Every model supports `low` / `medium` / `high` / `xhigh` / `max`; `ultra` is supported only by `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, and `gpt-5.6-terra`. The available list varies with account and Codex version; your own `model/list` is authoritative.

#### Generic ACP backends (Other)

- Any CLI implementing standard ACP, such as opencode or gemini-cli.
- **Must** use `agentEngine: 'none'`.
- model/effort support depends on whether the agent accepts the matching CLI flags and is not guaranteed.
- `acp_chat_steer` reports the standard `-32601` fallback when unsupported.
- `session/load` depends on the agent declaring `loadSession` capability.
- The normalization layer attempts to accept non-standard update shapes.

### Backend recipes

```yaml
# Tier 1: first-class support — kiro (default backend; no override needed unless you pin a model)
# kiro v3 + pinned model (recommended)
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: kiro-cli
    args: [acp]
    modelSelect: session
    model: claude-opus-5.5     # switched via set_config_option, not a CLI flag
    # Note: do not set model without modelSelect: session (v3 rejects the flag); do not set the effort field on v3
```

```yaml
# Tier 1: first-class support — agy
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /Users/<you>/.local/bin/agy
    args: [acp]
    agentEngine: 'none'
    permission: ask
    # Optional: pin a model; set it together with modelSelect: session (switched via session/set_model). model alone appends the --model flag agy rejects
    # modelSelect: session
    # model: gemini-4-carbon-high   # effort is embedded in the model id; do not set the effort field
```

```yaml
# Tier 1: first-class support — Codex (private protocol, named backend only)
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    backends:
      codex:
        protocol: codex
        command: codex
        args: [app-server]          # optional; app-server is the default
        model: gpt-6.2-astra        # required: a model id your account lists in `model/list`
        sandbox: workspace-write    # read-only (default) | workspace-write | danger-full-access
        approvalPolicy: on-request  # never (default) | untrusted | on-request | on-failure
        effort: xhigh               # optional: low | medium | high | xhigh | max | ultra (ultra on some models only)
        permission: ask             # ask the user per approval; reject refuses the step; allow approves all
        description: 'Codex'
```

```yaml
# Tier 2: generic ACP — other vendors
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    backends:
      other:
        command: /path/to/other-acp-agent
        args: [acp]
        agentEngine: 'none'
        description: 'Other ACP agent'
```

The three duration fields must be positive and no greater than Node's timer limit, and a relative `registryPath` makes the plugin error at startup.

## Install and upgrade

**Main path: install from npm.** Requires DSH `>=0.2.2-rc.3` (the package's `engines.dsh` sets only a minimum version and no installation ceiling for later DSH release lines) and Node >= 24:

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

> **Note:** If installation reports `ERR_PNPM_TARBALL_EXTRACT` or a checksum error, dsh's default `minimumReleaseAge` supply-chain protection has filtered out the newly published version. A first npm release can also include the invalid placeholder version `0.0.0-stage`. Pin the version explicitly: `dsh plugin --profile <name> add dsh-acp-resume@<version>`. dsh writes that version to the profile's `minimumReleaseAgeExclude`, so installation succeeds immediately. The unpinned command works again after the release has aged for a while.

`<name>` is the profile name (the default profile directory of the DSH App is `~/.dsh/profiles/desktop/`). After installing, the package appears in that profile's `dsh.profile.bundles`, and takes effect after DSH restarts. To upgrade, use `dsh plugin --profile <name> add dsh-acp-resume@<version>`; to uninstall, use `dsh plugin --profile <name> remove dsh-acp-resume`.

**Install from Discover (experimental).** On the **Plugins** page, find and enable **Custom plugin indexes** directly under **Experimental plugins**. A **Discover** tab then appears. Open it, choose **Add index source**, and enter `https://tureen.github.io/dsh-acp-resume/index.json`. When the index loads, choose Install on the `dsh-acp-resume` card, confirm the version and source, then restart DSH.

**Alternative: a local tgz.** After `pnpm build` in this repository, run `pnpm pack --pack-destination <stable directory>` (`prepack` clears `lib/` and recompiles first, so no stale output is packed), then `dsh plugin --profile <name> add <path to the tgz>`.

- Keep the tgz in a stable location, such as `~/.dsh/local-plugins/`, not `/tmp`. The profile's `package.json` references the tgz by a `file:` path, and once the system clears `/tmp`, any plugin addition or removal in the profile (each triggers a pnpm install) fails because the file cannot be found.
- Upgrading requires changing the version number. Re-packing with the same version does not take effect: pnpm identifies a package by the hash in the lockfile and reuses the old cache when the version and path are unchanged.

> ⚠️ **Do not install from the GitHub URL.** This repository contains no build output (`lib/` is gitignored) and has no `prepare` script, so installing from a GitHub URL (such as `github:Tureen/dsh-acp-resume`) fails to load because `lib/index.js` is missing.
>
> - Install by npm package name with `dsh plugin --profile <name> add dsh-acp-resume`, or from the Discover market.
> - If you must install offline, download the tgz with `npm pack dsh-acp-resume`, then install it locally with `dsh plugin --profile <name> add <tgz path>`. This is not recommended: a plugin installed that way has no update button.

Supporting Git install would need a self-contained `prepare`, and users would also have to enable `allowBuilds` for this package in the profile's `pnpm-workspace.yaml` (which means allowing package code to run at install time); the cost is described in the "Installing from GitHub" section of the official `docs/user/develop/basic/publish.md`. Please use npm or a tgz.

- **Choose either the bundle or a profile insert, do not mount both.** When the profile's `dsh.profile.bundles` lists `dsh-acp-resume` (the switch on the Plugins page is on), this package's bundled `cordis.patch.yml` has already inserted the plugin; inserting it again from the profile registers two providers with the same name and fails with `DUPLICATE_PROVIDER`. When the bundle is enabled, change the configuration with a top-level override with the same id:

  ```yaml
  - id: subagent-acp-resume
    name: 'dsh-acp-resume'
    config:
      command: /absolute/path/to/kiro-cli
  ```

## ACP Dispatcher mode

### What it is

One session is a **multi-worker workbench**: the user describes a larger job in one conversation window, while the main agent acts as a foreman that splits work, assigns responsibilities, tracks progress, collects results, and synthesizes the answer. ACP sessions are the workers, each doing its own job in parallel. kiro, agy, and codex can work on the same workbench at once; the foreman routes by task characteristics, with zero switching and no lost context.

```text
+---------------------------------------------+
|  You (one conversation)                     |
|  "Complete this big project"                |
|                                             |
|  Dispatcher (foreman)                       |
|  |-- Worker 1 (kiro):   implement module    |
|  |-- Worker 2 (agy):    research API design |
|  |-- Worker 3 (codex):  write unit tests    |
|  |                                          |
|  |   ...workers run in parallel...          |
|  |                                          |
|  +-- collect all results                    |
|  +-- synthesize final answer                |
|                                             |
|  You (same window, zero switching)          |
+---------------------------------------------+
```

This is an **optional** session mode (an agent preset, see D26). When you do not pick it, the `acp_chat_*` tools stay available in the standard and creative modes.

### When it helps

- **Parallel tasks**: split one request into 3-5 independent sub-tasks and give each to its own ACP worker, running at the same time. On the workbench, you describe the request once and the foreman starts three workers at once; you do not need to track who is doing what.
- **Cross-checking**: send the same question to different backends (for example kiro and agy) and compare the answers. On the workbench, the foreman assigns the same responsibility to workers with different specialties and summarizes the differences.
- **Long-running work**: hand all time-consuming analysis, coding, and research to ACP; the main agent only tracks progress and summarizes. On the workbench, workers keep moving while the user stays in the same window for the synthesized result.
- **A lean main context**: the main agent runs nothing and reads no files, so its tokens go to dispatch decisions. On the workbench, task detail remains in each worker session while the foreman keeps the global progress.

### When not to use it

- A single simple question: answering directly is faster than dispatching.
- Work that needs exact control over file edits: use the standard mode and edit yourself.
- No ACP backend available: without kiro-cli / agy / codex installed, there is nobody to dispatch to.

### Tool surface compared

| Tool | Dispatcher | Standard |
|---|---|---|
| `acp_chat_*` | ✅ | ✅ |
| web_search / fetch | ✅ | ✅ |
| session_search / goal | ✅ (global) | ✅ |
| present | ✅ | ✅ |
| Task management (jobs / todo / ask_user) | ✅ | ✅ |
| bash / fs / fs-search | ❌ | ✅ |
| subagent | ❌ | ✅ |

### How to switch

Pick **ACP Dispatcher** in the mode menu of a new session. After enabling the bundle, restart DSH for it to appear; if you don't pick it, nothing changes.

### Design principle

Capability is decoupled from mode: the plugin provides the capability (`acp_chat_*` works in every mode), and the preset provides a choice of combination (the Dispatcher is an optional "dispatch only" constraint).

**Note**: the plugin inside the preset has no config and uses plugin defaults. To customize the command or backends, see the known risks in D26.

## Backend quota (D28)

When a Codex backend is configured, the plugin also registers a read-only tool, `acp_backend_usage {backend?, refresh?}`, which returns each backend's quota: plan, the used percent of the tightest limit window (it may exceed 100), the window length, and the reset time. The header of the "ACP chats" side panel also shows one line per Codex backend, such as `codex · prolite · 17% left` (the percent remaining); hover for the window and reset time.

- Only two read-only Codex `app-server` methods are called (`account/read`, `account/rateLimits/read`); reading costs no quota. A live Codex chat's connection is borrowed when there is one; otherwise a temporary `codex app-server` is started and closed after the read.
- Results are cached for 5 minutes (failures for 1 minute). An expired entry is returned at once while it refreshes in the background; `refresh: true` forces a new read.
- kiro and other ACP backends are not supported yet; they report `unsupported` and the panel hides them.

## Workspace roles (D27)

Off by default: set `workflow: true` in the plugin config to enable the roles and workflows in this section.

Put `.agents/acp-team.yml` in the workspace root (see [docs/acp-team.example.yml](docs/acp-team.example.yml)) with role blueprints: a name, an optional backend, a working directory, and a seeding message. The model can then call `acp_chat_send` (and `acp_chat_close`, `acp_chat_steer`) with `role: reviewer` instead of a chatId. On the first reference in a session, the plugin creates the chat from the blueprint, sends the seeding message, records the chat in the session's roster, and then sends the message; later references reuse that chat. `acp_chat_list` marks these chats with `role <name>`.

- Rosters are per DSH session: a new session gets its own chat for the same role.
- Editing a blueprint does not rebuild existing roles. Call `acp_chat_close` with `role` to unbind one; its next reference uses the new blueprint.
- The file is looked up from the session's working directory upward, at most 3 levels (that directory, its parent, its grandparent). A missing file is silent; an invalid one logs a warning and counts as no configuration.

### Workflow templates (`acp_workflow`)

Define flows under `templates` in the same file; the model runs one with `acp_workflow(template, params)`. Steps run in order. A `parallel` step sends its prompt to every listed role at once. A `merge` step either hands all results back to the model (`return_to_model`, last step only) or has one role merge them (`role`). In prompts, `{param}` is a call param and `{stepId}` is an earlier step's results; a prompt that names no earlier step gets the previous step's results appended. A failing role is recorded as `{"error": …}` while the others carry on; the run stops only when every role in a step failed. The result is JSON: `{ template, status, steps: [...] }`. When the model calls it directly, the conversation shows the official workflow progress card (roles grouped by step, with their start, end, and outcome). With the background job service it returns a jobId at once, like `acp_chat_send`, and wakes the model when done.

```yaml
templates:
  - name: dual_review
    params: [target, dimensions]
    steps:
      - id: independent
        parallel: [reviewer, { role: security-reviewer, prompt: "Review {target} for security issues." }]
        prompt: "Review {target}. Focus on: {dimensions}."
      - id: merge
        merge: { mode: role, role: editor, prompt: "Merge these reviews of {target}." }
```

The "ACP chats" side panel has a workflow block (D29). Running workflows show a spinner, `template · current step`, and a live timer; the last 5 finished runs show their outcome (green completed, red failed, orange cancelled or interrupted) and how long ago. Click a row to expand its steps and members; click a member to open its chat detail. Records live in `workflows/<session id>.jsonl` next to the registry and hold only step and member summaries, no role answers and no call params; a run cut short by a host restart shows as interrupted.

Call: `acp_workflow({ template: "dual_review", params: { target: "src/pool.ts", dimensions: "concurrency and leaks" } })`. See [docs/acp-team.example.yml](docs/acp-team.example.yml) for a full example.

## Host prerequisites for background job mode

The background mode of `acp_chat_send` needs the host to have both `@deepseek-ai/dsh-jobs-local` (provides `ctx.jobs`) and `@deepseek-ai/dsh-tool-jobs` (mounts the job controller and provides `job_output` / `job_list` / `job_kill` and completion notifications). With only the former, send fails with a "no controller" tool error; with neither, send falls back to waiting synchronously.

## Pre-checks before a real-machine smoke test

- Capture one real `initialize` response and confirm that `agentCapabilities.loadSession` is `true`. This capability is checked before reconnecting; when it is not declared, every reconnect degrades to a new session and continuing a chat stops working (D16).
- kiro's load is sensitive to cwd: confirm that the registry replays the original cwd (see "Risks and countermeasures" in DESIGN.md).

## Development

```sh
pnpm install && pnpm build     # build lib/
pnpm test                      # vitest; 324 green = official protocol surface 68 + connection 28 + pool 61 + tools 15 + jobs 12 + panel 17 + client 71 + steer 5 + engine 16 + turn-log 18 + job-wait-gate 13
```

- Baseline: checked against npm `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3` `src/run.ts` and official checkout pin `ff6db9df9f37db545e8b124b9043269f17256a34`. Except for D11's narrow `permission: ask` and ENOENT guidance changes, `src/run.ts` matches `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3`. DSH peers are pinned to `~0.2.2-rc.5` (the official rc.5 `run.ts` is identical to rc.3), and the Cordis peer remains `~4.1.0`;
- Conditionally run cases: the 24 real-child-process cases need `spawn.ts` from the official checkout (not included in the npm distribution). When the official checkout (its path given by the environment variable `DSH_OFFICIAL_CHECKOUT`; when unset, the default location in the tests is used) is present, everything is green and the exit code is 0; when it is absent, these 24 cases are skipped automatically (see DECISIONS D8);
- Two implementations side by side: except for D11's narrow `permission: ask` and ENOENT guidance changes, run.ts follows the official baseline and is not refactored; connection.ts is the sibling implementation dedicated to the pool;
- Official source checkout used for reference: pin `ff6db9df9f37db545e8b124b9043269f17256a34` (master's 0.2.2-rc.3 state, read-only comparison).

## License

MIT

# Resumable ACP subagent

`dsh-acp-resume` lets DeepSeek Harness (DSH) keep a multi-turn conversation with an external ACP agent. It preserves the official one-shot delegation path while saving the remote session id locally. When the process exits or is released after idle time, the next send continues the session through `session/load`.

## Workspace roles and workflows

This feature is off by default; set `workflow: true` in the plugin config. Write `.agents/acp-team.yml` in the workspace root to define role blueprints (name, backend, working directory, seeding message) and workflow templates. The model can then dispatch work by role name: pass `role` to `acp_chat_send`, and the first reference in a session creates the role's chat and sends its seeding message; later references reuse it. `acp_workflow` runs a template across several roles, such as a dual review or two-track research: roles in the same step run in parallel, later steps see earlier results, and the model or a chosen role merges them. See [docs/acp-team.example.yml](acp-team.example.yml) for an example.

## Install

- **npm:** Run `dsh plugin --profile <name> add dsh-acp-resume`. If a newly published version is filtered by `minimumReleaseAge`, pin it: `dsh plugin --profile <name> add dsh-acp-resume@<version>`.
- **Discover:** On the **Plugins** page, enable **Custom plugin indexes** under **Experimental plugins**. Open **Discover**, choose **Add index source**, enter `https://tureen.github.io/dsh-acp-resume/index.json`, then confirm installation from the `dsh-acp-resume` card.

> ⚠️ **Do not install from the GitHub URL.** This repository contains no build output (`lib/` is gitignored) and has no `prepare` script, so installing from a GitHub URL (such as `github:Tureen/dsh-acp-resume`) fails to load because `lib/index.js` is missing.
>
> - Install by npm package name with `dsh plugin --profile <name> add dsh-acp-resume`, or from the Discover market.
> - If you must install offline, download the tgz with `npm pack dsh-acp-resume`, then install it locally with `dsh plugin --profile <name> add <tgz path>`. This is not recommended: a plugin installed that way has no update button.

Restart DSH after installation. Backend discovery is on by default. Open **Right sidebar → ACP chats** and expand **Backend status** to see CLI versions and readiness. After a CLI update, sign-in, or default-model change, use **Recheck backends** on the same row without restarting. This does not delete chats, sign you out, or change settings. Without an explicit selection or pinned default, new chats keep using the configured Kiro whenever DSH can find it. Version warnings, handshake failures, and sign-in failures do not cause a switch. Only when DSH confirms that the configured Kiro executable is missing does it select a ready Codex or, failing that, Antigravity (`agy`), without requiring YAML. Set `discoverBackends: false` to turn off additional discovery. See the [version ranges](backend-compatibility.md) and [README](../README.en.md).

## Chat tools and panel

The model can use five tools:

- `acp_chat_start`: Create a persistent chat and return its `chatId`.
- `acp_chat_send`: Send a message. It returns a job id immediately when the host supports background jobs, otherwise it waits for the answer.
- `acp_chat_list`: List active and released chats created by the current DSH session.
- `acp_chat_close`: Release the process; use `purge` to also delete the local record.
- `acp_chat_steer`: Add a follow-up instruction to a turn that is still running.

The Persistent chats panel in the right sidebar shows each chat's state, turn count, and details, and can release or delete it. Select a card to review every question, answer, and reconnect event.

## Key configuration

- `command`: The external ACP agent executable. A custom top-level backend retains the legacy `default` route.
- `defaultBackend`: Pin the default for new chats; the plugin does not switch away from an unavailable pinned backend. Passing `backend` explicitly takes precedence.
- `allowUnverifiedBackends: true`: Permit explicitly selecting an auto-discovered CLI outside the version range without including it in automatic routing. Version checks are advisory for configured backends. Existing chats can send and reconnect without a readiness check.
- `permission`: `allow` approves automatically, `reject` denies automatically, and `ask` forwards every request to the host user-confirmation interface. The bundle defaults to `allow`; `ask` denies when no confirmation service or valid answer is available.
- `agentEngine: none`: Set this when the agent does not accept kiro's `--agent-engine` argument, so the plugin does not append it.
- `model` / `effort`: By default (`modelSelect: flag`) these work through the `--model` / `--effort` CLI flags and only for agents that accept them (kiro v2 engine). agy and kiro v3 reject them, so setting them directly fails startup. For those backends set `modelSelect: session`; both then go through session-level methods and no flags are appended. On kiro v3, `effort` must then be `low` / `medium` / `high` / `xhigh` / `max`; any other value fails at load.

### Backend support levels

- **First-class: kiro-cli.** The default backend supports `_session/steer`, `--agent-engine v3`, and cross-process `session/load`. On v3 (default) pick the model with `modelSelect: session` + `model` and the reasoning effort with `+ effort` (both via `session/set_config_option`; a level the chosen model does not offer only logs a warning). Without `modelSelect: session`, setting model/effort appends CLI flags v3 rejects and startup fails. Only v2 (legacy) supports the `--model` / `--effort` flags.
- **First-class: agy / Antigravity.** Supports update normalization, `session/set_model`, and cross-process `session/load`. Auto-discovery uses the CLI's model settings and denies ACP permission requests. For an explicit backend, set `agentEngine: 'none'`; use `modelSelect: session` + `model` to override the model, omit `effort` (it is encoded in the model ID), and use `permission: ask` to review requests.
- **First-class: Codex.** Uses `codex app-server` for native steer, cross-process `thread/resume`, and per-item approvals (`permission: ask` asks the user each time). For a manually named backend, set `protocol: codex`; an explicit `model` overrides the model selected by the CLI. You can also set `sandbox`, `approvalPolicy`, and `effort`. Codex models come from the app-server’s `model/list`.
- **Generic ACP (Other).** For standard ACP CLIs such as opencode and gemini-cli; it must use `agentEngine: 'none'`. steer, loadSession, and model/effort availability depend on that agent's capabilities and CLI flag support.

See [Choose a backend](../README.en.md#choose-a-backend) for automatic setup and override examples.

### Starter recipes

These are top-level overrides in the profile's `cordis.patch.yml` while the bundle is enabled. Do not add another `- insert:` block.

**Default kiro-cli.** No override is needed. Install `kiro-cli` and ensure it is on `PATH`; the bundled configuration already uses `command: kiro-cli` and `args: [acp]`.

**Specific kiro-cli path.**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/kiro-cli
    args: [acp]
```

**Another ACP agent and ask for every permission.**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/other-acp-agent
    args: [acp]
    agentEngine: 'none'
    permission: ask
```

**Codex (named backend).**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    backends:
      codex:
        protocol: codex
        command: codex
        model: gpt-6.2-astra
        effort: xhigh               # effort optional: low | medium | high | xhigh | max | ultra (ultra on some models only); see the README for the full model list
        sandbox: workspace-write
        approvalPolicy: on-request
        permission: ask
```

See the [README](../README.en.md#let-the-model-choose-between-backends) for defaults and manual wiring.

## ACP Dispatcher mode

An optional session mode, "ACP Dispatcher": one session is a multi-worker workbench. The user stays in one conversation window while the main agent acts as a foreman, splitting work across parallel ACP worker sessions, collecting results, and writing the final answer; it has no bash or file tools.

- **Good for**: parallel sub-tasks; cross-checking one question across backends; long-running work; keeping the main agent's context lean.
- **Switching**: pick **ACP Dispatcher** in the mode menu of a new session. If you don't, nothing changes, and `acp_chat_*` stays available in the standard mode.

See the [README](../README.en.md#acp-dispatcher-mode) for the full comparison and when not to use it.

## Known limitations

- Automatic fallbacks depend on the [published version ranges](backend-compatibility.md) and readiness checks. Version checks are advisory for configured backends. Verify generic ACP backends against their own protocol capabilities.
- `acp_chat_steer` uses kiro's private `_session/steer` extension, and Codex's native `turn/steer`. Other agents report a clear error when they do not implement it.
- Persistent chats need the remote agent to support `session/load`. When a session is lost or repeatedly fails, the plugin starts a fresh chat and tells the model to restate the needed context.

## Links

- [GitHub repository](https://github.com/Tureen/dsh-acp-resume)
- [npm package](https://www.npmjs.com/package/dsh-acp-resume)
- [Plugin index](https://tureen.github.io/dsh-acp-resume/index.json)

# dsh-acp-resume

[简体中文](README.md)

## Why this plugin exists

### Resume · Keep a subagent’s working context

The official ACP backend in DeepSeek Harness (DSH) starts a fresh session for each assignment, so even a follow-up on a reviewer’s second finding requires you to explain the context again. Resume keeps the same subagent session, so you can say “dig into the second finding” and the reviewer can pick up with the code, evidence, and reasoning it already has. The plugin runs alongside the official backend and uses a persistent pool to reuse processes and save remote session IDs, so the next message can attempt to resume the session after a process exits or times out while idle.

### ACP Dispatcher · Coordinate several subagents from one conversation

The plugin makes ACP tools available in every mode, and ACP Dispatcher is an optional preset for delegation. With the default settings, the main agent breaks down work, assigns it, and collects results in one conversation, while individual ACP sessions carry out the work because the main agent has no shell or file tools. You can have kiro write code while Codex reasons through edge cases, ask two engines to independently verify a conclusion, or delegate a long-running task and follow its progress in the same window.

### ACP Workflow · Turn repeatable collaboration into a template

If every review calls for two independent reviewers and an editor to combine their findings, define those roles and the workflow template in your workspace’s `.agents/acp-team.yml`. Roles are available by default; with `workflow` enabled, a single `acp_workflow` call runs the steps in the declared order, dispatches the designated roles in parallel, and merges their results as specified. Reuse the template for each review and the engine follows the same sequence without relying on the model to remember and dispatch every step.

## Installation

You need DSH `>=0.2.2-rc.3`, Node.js 24 or later, and at least one usable backend. Automatic setup expects a CLI in the [published version ranges](docs/backend-compatibility.md). Kiro is optional. You can use Codex or agy on its own.

Replace `<name>` with your DSH profile name and install the package from npm. Restart DSH after installation.

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

To upgrade, append `@<version>` to the package name. You can also pin a version this way if `minimumReleaseAge` filters out a new release. In the desktop app, you can install through Discover. For offline installation, use a local tgz file. [Marketplace installation instructions](docs/detail.en.md#install)

> ⚠️ **Do not install from a GitHub URL.** The repository omits compiled files and has no `prepare` script to build them at install time. DSH will fail to load the plugin because `lib/index.js` is missing.

The bundle includes the **ACP Resume Docs** skill (`acp-resume-docs`). In standard mode the model can look it up automatically when you ask how to configure the plugin or troubleshoot dispatch. In Dispatcher, enable `readOnlyFs` to load skills and read their reference pages.

## Choose a backend

<a id="configuration"></a><a id="backend-support-levels"></a>

| Backend | Capabilities |
| --- | --- |
| **kiro-cli** (default) | The bundle runs `kiro-cli acp` with the v3 engine and supports both session recovery across processes and mid-turn instructions. Set `modelSelect: session` with `effort` to choose the reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). |
| **Antigravity** (agy) | Connects automatically through `agy acp` and supports session recovery and per-session model and reasoning effort selection. Available effort levels depend on the model. |
| **Codex** | Uses the private `codex app-server` protocol for session recovery, mid-turn instructions, and per-action approvals, and can be discovered automatically or configured as a named backend. |

With `discoverBackends` on by default, the plugin checks CLIs on DSH’s `PATH` and at configured paths against the [published version ranges](docs/backend-compatibility.md), then verifies eligible built-in backends. Checks do not create a session or send a prompt; the CLI itself may access the network. Open **Right sidebar → ACP chats** and expand **Backend status** to see versions, readiness, and failure reasons. After a CLI update, sign-in, or default-model change, use **Recheck backends** on the same row without expanding it or restarting DSH. This does not delete chats, sign you out, or change settings.

### Use a single backend

Make sure DSH can find a supported CLI, and sign in through the CLI as needed. Without an explicit selection or pinned default, DSH uses the configured Kiro whenever it can find the executable. A version warning, failed check, or sign-in requirement does not cause a switch. **Only when DSH confirms that the configured Kiro executable is missing** does it pick the first ready backend in order: Codex, then Antigravity (`agy`). No extra YAML is required.

Auto-discovered Antigravity runs `agy acp`, uses its CLI model settings, and denies permission requests. Startup only performs a handshake; if opening a chat requests authentication, sign in through `agy`, then recheck. To override Antigravity’s path, model, or permissions, configure a named backend:

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    command: kiro-cli
    args: [acp]
    permission: allow
    backends:
      agy:
        command: agy
        args: [acp]
        agentEngine: none
        permission: ask
        modelSelect: session
        model: gemini-4-neon
        effort: high
```

Restart DSH if you change the configuration. To pin a model on kiro v3 or agy, set both `modelSelect: session` and `model`. In this mode, persistent kiro v3 chats apply `effort` when the session opens or reconnects, without appending the `--effort` CLI flag. The configuration accepts `low`, `medium`, `high`, `xhigh`, or `max`. Other values cause a configuration error at load time. Support varies by model, and a configured level the model does not offer produces a warning. agy 1.5.13 uses `thought_level` and accepts `low`, `medium`, `high`, or `xhigh`. On each new or resumed chat, the example selects the model, then sets and checks `high` once. A level the model does not offer produces a warning. For Codex, the plugin verifies your existing model setting, or a single default explicitly advertised by Codex if you have no model set. It never guesses a model.

### Let the model choose between backends

To keep kiro as the default and offer Codex as an alternative, use the following configuration in the same file. The top-level `command` and `args` define the legacy backend named `default`; `defaultBackend` selects the backend for new chats. Each key under `backends` is a name the model can select. Replace `model` with an ID available to your account in the Codex `model/list` response.

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    command: kiro-cli
    args: [acp]
    defaultBackend: default # Use codex for a Codex-only setup
    backends:
      codex:
        protocol: codex
        command: codex
        model: gpt-6.2-astra
        effort: high
        sandbox: read-only
        approvalPolicy: on-request
        permission: ask
```

`acp_backend_status` reads the cached check results without starting a CLI. New chats select a backend in this order:

1. A `backend` explicitly passed to `acp_chat_start` takes precedence.
2. Otherwise, use the configured `defaultBackend`. If unavailable, return an error instead of switching backends.
3. Otherwise, use the configured top-level `default`. With discovery enabled, fall back only if DSH confirms that the configured `kiro-cli` executable cannot be found, including when a path is specified. Pick a ready Codex or, failing that, a ready `agy`, both within the published version ranges. "Cannot be found" is what the DSH host's executable lookup reports: the host also reports a file without execute permission, a directory with that name, and an unreadable PATH directory as not found, so those cases fall back too (a Kiro without execute permission could not start anyway); lookup timeouts and other errors do not count. DSH launched from the macOS Dock often does not see the shell's `PATH` (for example, without `~/.local/bin`), so an installed Kiro may be reported missing; when that causes a fallback, the `acp_chat_start` receipt says so. If Kiro is found, keep its configured arguments and permissions; report connection failures without switching. If Kiro is missing and neither fallback qualifies, try the original command so the user still gets the command-not-found guidance. Custom wrapper commands and configurations with discovery disabled retain the legacy `default` route.

An explicitly configured backend, including a custom command or wrapper, can still be tried when its version is unknown or out of range. The plugin warns but does not guarantee compatibility. Kiro V3 support includes 3.6.x. The 3.7 line awaits verification. If the panel shows V3 3.6.x as out of range, update this plugin and recheck. For an **auto-discovered** CLI outside the range, set `allowUnverifiedBackends: true` and choose it with `backend` or pin it with `defaultBackend`; it will not become an automatic fallback. Check results and one-off start failures do not remove tools or block sends and reconnects to existing chat IDs, which retain their original backend.

Set `discoverBackends: false` to turn off additional PATH discovery and automatic setup without disabling configured backends. Auto-discovered backends do not inherit other backends’ explicit credentials or permission settings. Codex uses a `read-only` sandbox, `never` approval policy and rejects ACP permission requests; `agy` also rejects ACP permission requests by default. Configure a named backend to override the path, model, environment, or permissions.

For Codex, `effort` sets the reasoning level per turn. The `sandbox` options are `read-only` (default), `workspace-write`, and `danger-full-access`. Codex uses `approvalPolicy` to decide when to request approval. Each backend’s `permission` controls the response: `allow` approves automatically, `reject` declines, and `ask` prompts the user. The bundle sets `allow` for the default backend. A named backend defaults to `reject` if the field is omitted.

## Quick start

Open a DSH session with a working directory. Send the first message, wait for the reply, then send the second.

1. “Ask an ACP subagent to read this project's README and identify the step most likely to trip up a new user.”
2. “Ask the same reviewer to write clearer instructions for that step.”

For the first request, the model opens a chat with `acp_chat_start` and passes the resulting `chatId` to `acp_chat_send`. The follow-up uses the same `chatId`. Open **ACP chats** in the right sidebar and select the chat to see both questions and their answers.

### Follow a task in the sidebar

- **Track progress.** The list shows subagent chats created in the current DSH session. A spinner and elapsed time mark a turn in progress. A green dot means the latest turn completed normally, red signals a turn or reconnection error, and amber means the agent started a fresh session. A solid gray dot marks an idle process and a hollow gray dot marks a released one. Open a chat to read its questions, answers, and reconnection history.
- **Release or delete a chat.** Releasing the process keeps the chat record so the next message can reconnect. If a turn is running, the panel asks for confirmation because releasing the process stops that turn. Deleting the chat removes both its local record and its turn log.
- **Check Codex usage.** When quota data is available, the panel shows the percentage remaining in each Codex backend’s most constrained rate-limit window. Hover to see the window length and reset time. Successful reads are cached for five minutes.
- **When features are off.** With `workflow: false`, opening the workflow section reads its history once without polling. With `enableChatTools: false`, the chat list and detail tabs show “Persistent chats are disabled.”

## Advanced usage

### ACP Dispatcher mode

Enable the bundle, restart DSH, and select **ACP Dispatcher** from the **mode menu in a new session**. By default the main agent has ACP tools for delegation, web tools for quick lookups, and jobs tools for tracking work. It has no shell or file tools, so it delegates commands and file operations to workers through `acp_chat_send`. When a job finishes, the main agent receives a notification and retrieves the result with `job_output`. Use this mode to run independent tasks in parallel, cross-check a review with two engines, or follow a long-running task from one conversation. ACP tools are also available in standard mode (D26).

**Choose the main agent’s tools.** Edit `~/.dsh/profiles/<name>/cordis.patch.yml`, using the same `<name>` you passed to `--profile <name>` at installation. The two tool configuration examples below are alternatives for the same override. Place it at the **top level**, alongside `- id: subagent-acp-resume`. Start `- id:` in the first column, indent `name:` and `config:` by two spaces, `dispatcherTools:` by four, and each switch by six.

To let the main agent verify files and load skill instructions, enable read-only file access:

```yaml
- id: acp-dispatcher-settings
  name: dsh-acp-resume/dispatcher-preset
  config:
    dispatcherTools:
      readOnlyFs: true
```

To also turn off the task list, put both switches under the same `dispatcherTools` key. Omitted fields use their defaults, so you can leave out the other switches:

```yaml
- id: acp-dispatcher-settings
  name: dsh-acp-resume/dispatcher-preset
  config:
    dispatcherTools:
      readOnlyFs: true
      todo: false
```

| `dispatcherTools` field | Default | Capability |
|---|---|---|
| `readOnlyFs` | `false` | Read and search files, discover skills and load their instructions. Image reads, writes, edits, and patches stay disabled. |
| `web` | `true` | Lightweight web lookups, including fetch. |
| `present` | `true` | Present deliverables. |
| `todo` | `true` | Maintain a task list. |
| `askUser` | `true` | Ask for clarification with a tool. The agent can still ask in conversation when disabled. |
| `compaction` | `true` | Enable context compaction, the compact command, and tool-result pruning together. |

The old `dispatcherTools.skill` field from 0.5.1 is deprecated. Set `readOnlyFs: true` for both file verification and skill access.

After editing the Dispatcher configuration in the profile, restart DSH so it reads the new configuration. Select ACP Dispatcher in a new session to bind an agent to the updated tool set and its matching description and persona. If only the declaration is reloaded within a running host, agents already bound in that process keep their previous tool set and the ACP pool keeps running.

These six switches preserve the Dispatcher’s role: the main agent delegates execution to workers through ACP. They exclude bash, file writes and edits, and DSH’s built-in subagent delegation tools. Enabling those execution paths would leave only the prompt to distinguish Dispatcher from standard mode. A profile that needs them can use the complete custom declaration described below.

**Customize dispatch rules.** This example is a top-level entry in the profile’s `cordis.patch.yml`. If you already have a tool override, put `dispatcherPrompt` beside `dispatcherTools` under the same entry’s `config`.

```yaml
- id: acp-dispatcher-settings
  name: dsh-acp-resume/dispatcher-preset
  config:
    dispatcherPrompt:
      extraRules: |
        Assign one owner per deliverable.
        Ask for the evidence before closing the task.
      overrideRules: false
```

The default keeps the built-in persona, with any nonempty `extraRules` appended after its synthesis checklist. With `overrideRules: true`, nonempty rules are required and replace backend dispatch procedures, target directory selection, shared-directory write boundaries, and result synthesis while preserving the dispatcher identity, tool-specific guidance, and tool-based menu description.

**Migrating an old `preset-acp-dispatcher` override.** Users who never overrode that row can keep their configuration. Remove any override targeting the old row. If it only enabled read-only file tools, replace it with the first example. For an unmatched row rc.5 logs `patch: entry "preset-acp-dispatcher" not found`, skips the override, and continues loading the profile. Ignoring the warning drops the customization. If you previously disabled the old row, set `disabled: true` on `acp-dispatcher-settings`.

To customize the entire persona (including identity and tool guidance) or add other plugins, disable the new declaration row and use a top-level `- insert:` to add your own complete `@deepseek-ai/dsh-agent-preset` declaration in the same profile edit. You can move your old row and its entire `config` into that list. Keep `config.id: acp-dispatcher` so existing sessions retain their preset identity and only one declaration registers it. Restart DSH after migrating and select ACP Dispatcher in a new session.

### ACP Workflow · Run a workspace template

Role dispatch is on by default (`roles: true`). Once you define roles in the workspace’s `.agents/acp-team.yml`, pass a `role` to `acp_chat_send` to assign work by name. The `workflow` switch defaults to `false` and controls only the `acp_workflow` template tool. Combining `roles: false` with `workflow: true` causes a configuration error at load time.

To run the template below, set `workflow: true` in the plugin’s top-level `config`, restart DSH, and save the example as `.agents/acp-team.yml` at the workspace root. The reviewers work independently on the default backend, and the final step returns both reviews to the main model. To assign a role to your configured Codex backend, add `backend: codex` to its blueprint. [More templates, including one with an editor role](docs/acp-team.example.yml)

```yaml
roles:
  - { name: reviewerA, cwd: ., summary: "Correctness reviewer", seeding: "Review for correctness." }
  - { name: reviewerB, cwd: ., summary: "Maintainability reviewer", seeding: "Review for maintainability." }
templates:
  - name: dual_review
    params: [target]
    steps:
      - { id: review, parallel: [reviewerA, reviewerB], prompt: "Review {target}." }
      - { id: collect, merge: { mode: return_to_model } }
```

**Run the review.** Ask “Run `dual_review` on `src/pool.ts`” in the main conversation. The model calls `acp_workflow({ template: "dual_review", params: { target: "src/pool.ts" } })`. On first use of a role in this session, the plugin creates its chat from the blueprint, sends the `seeding` instructions, registers the chat in the roster, and sends the review assignment. A progress card in the conversation shows each step and participant’s status. The sidebar’s **Workflows** section shows the current step and the five most recent finished runs.

| Object | Scope | What it records |
| --- | --- | --- |
| Workflow templates (`templates`) | Workspace, shared by sessions in that workspace | How roles work together, including step order, parallel participants, and how results are merged. |
| Role blueprints (`roles`) | Workspace, shared by sessions in that workspace | Who each role is, including its `backend`, working directory (`cwd`), and initial instructions (`seeding`). |
| Roster instance | DSH parent session, one roster per session | The plugin uses the `ownerSessionId` to track which `chatId` belongs to each role in that session. |

A blueprint’s optional `summary` describes the role’s responsibility in one sentence. When a role’s chat is first created with `seeding`, the worker receives its role name, its teammates and their responsibilities, then its own instructions. With no `seeding`, it goes straight to the first assignment. The main model can call `acp_team_list` to see each role’s summary and whether it is unprovisioned, idle, or running in this session.

For example, when sessions 1 and 2 run `dual_review` in the same workspace, they read the same template and role blueprints. Reviewer A (`reviewerA`) maps to a different chat in each roster. A follow-up from session 1 using `acp_chat_send` with `role: reviewerA` continues session 1’s review. After editing a blueprint, use `acp_chat_close` with the role name in the current session to clear its binding. The next assignment creates a chat from the updated blueprint (D27).

## Reference

### Model tools

| Tool | When to use it |
| --- | --- |
| `acp_backend_status` | Read version support, readiness, the new-chat default, and suggested actions without launching a CLI. |
| `acp_backend_usage` | Registered when a backend is explicitly configured with `protocol: codex`. Read the plan, percentage used, and reset time. Set `refresh: true` to force a fresh read. |
| `acp_chat_start` | Open a persistent chat and get its `chatId`. Specify `backend` to select among configured backends. |
| `acp_chat_send` | Start the next turn, reconnecting as needed. A chat runs one turn at a time. Sending again while it is busy returns an error. |
| `acp_chat_list` | Find subagent chats created in the current DSH session, including chats whose processes have been released. |
| `acp_chat_steer` | Add instructions to a turn in progress. The tool reports when the backend does not support steering. |
| `acp_chat_close` | Release the process for later reconnection, or use `purge` to delete local records. To manage kiro's remote records, list them with `kiro-cli chat --list-sessions` and remove them with `--delete-session`. |
| `acp_team_list` | Read-only view of the workspace roles, their summaries, and their state in this session. Not registered with `roles: false`. |
| `acp_workflow` | Run a multi-role workflow by template name and parameters when `workflow` is enabled. |

**Background jobs.** With both `dsh-jobs-local` and `dsh-tool-jobs` installed on the host, sending a message or starting a workflow immediately returns a `jobId`. The model reads the result with `job_output` after the completion notification arrives. It can stop a running job with `job_kill`. By default, the plugin blocks attempts to wait synchronously on running ACP jobs. Without a jobs service, the call returns its result synchronously. Installing only the job registry leaves the controller missing and causes an error (D17, D22).

**Session recovery.** By default, the pool releases a process after 10 minutes of inactivity. If the remote session is known to be lost or the backend does not advertise session loading, the plugin starts a fresh session and prompts for any context the agent needs. The same fallback applies on the next send after three consecutive turn errors in the same chat and pool instance. A load failure with an unknown cause returns an error and preserves the existing binding. The registry defaults to `$DSH_HOME/storages/acp-resume/registry.json`. Alongside it, `turns/<chatId>.jsonl` stores the latest 200 turn records in plain text. [Recovery and logging decisions (D6, D18)](DECISIONS.md)

**Development and verification.** Run `pnpm install`, `pnpm build`, then `pnpm test`. Without a checkout of the official source, 24 tests that use real subprocesses are skipped under D8. Tests with kiro-cli have confirmed that a chat retains its context after process termination. The full smoke test with kiro-cli is still pending. The Codex adapter passes its mock regression suite, with live integration testing still pending. [Architecture](DESIGN.md) · [Verification status](IMPLEMENTATION-PLAN.md) · [MIT license](LICENSE)

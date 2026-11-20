# dsh-acp-resume

[简体中文](README.md)

## Why this plugin exists

### Resume · Keep a subagent’s working context

The official ACP backend in DeepSeek Harness (DSH) starts a fresh session for each assignment, so even a follow-up on a reviewer’s second finding requires you to explain the context again. Resume keeps the same subagent session, so you can say “dig into the second finding” and the reviewer can pick up with the code, evidence, and reasoning it already has. The plugin runs alongside the official backend and uses a persistent pool to reuse processes and save remote session IDs, so the next message can attempt to resume the session after a process exits or times out while idle.

### ACP Dispatcher · Coordinate several subagents from one conversation

The plugin makes ACP tools available in every mode, and ACP Dispatcher is an optional preset for delegation. In that mode, the main agent breaks down work, assigns it, and collects results in one conversation, while individual ACP sessions carry out the work because the main agent has no shell or file tools. You can have kiro write code while Codex reasons through edge cases, ask two engines to independently verify a conclusion, or delegate a long-running task and follow its progress in the same window.

### ACP Workflow · Turn repeatable collaboration into a template

If every review calls for two independent reviewers and an editor to combine their findings, define those roles and the workflow template in your workspace’s `.agents/acp-team.yml`. With workflows enabled, a single `acp_workflow` call runs the steps in the declared order, dispatches the designated roles in parallel, and merges their results as specified. Reuse the template for each review and the engine follows the same sequence without relying on the model to remember and dispatch every step.

## Installation

You need DSH `>=0.2.2-rc.3` and Node.js 24 or later. To use the default backend, install `kiro-cli` and make sure DSH can find it on its `PATH`.

Replace `<name>` with your DSH profile name and install the package from npm. Restart DSH after installation.

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

To upgrade, append `@<version>` to the package name. You can also pin a version this way if `minimumReleaseAge` filters out a new release. In the desktop app, you can install through Discover. For offline installation, use a local tgz file. [Marketplace installation instructions (Chinese)](docs/detail.zh.md#安装)

> ⚠️ **Do not install from a GitHub URL.** The repository omits compiled files and has no `prepare` script to build them at install time. DSH will fail to load the plugin because `lib/index.js` is missing.

## Quick start

Open a DSH session with a working directory. Send the first message, wait for the reply, then send the second.

1. “Ask an ACP subagent to read this project's README and identify the step most likely to trip up a new user.”
2. “Ask the same reviewer to write clearer instructions for that step.”

For the first request, the model opens a chat with `acp_chat_start` and passes the resulting `chatId` to `acp_chat_send`. The follow-up uses the same `chatId`. Open **ACP chats** in the right sidebar and select the chat to see both questions and their answers.

### Follow a task in the sidebar

- **Track progress.** The list shows subagent chats created in the current DSH session. A spinner and elapsed time mark a turn in progress. A green dot means the latest turn completed normally, red signals a turn or reconnection error, and amber means the agent started a fresh session. A solid gray dot marks an idle process and a hollow gray dot marks a released one. Open a chat to read its questions, answers, and reconnection history.
- **Release or delete a chat.** Releasing the process keeps the chat record so the next message can reconnect. If a turn is running, the panel asks for confirmation because releasing the process stops that turn. Deleting the chat removes both its local record and its turn log.
- **Check Codex usage.** The top of the panel shows how much quota each configured Codex backend has left in its most constrained rate-limit window. Hover to see the window length and reset time. The model can also use the read-only `acp_backend_usage` tool to check the plan, percentage used, and reset time. Successful reads are cached for five minutes. Set `refresh: true` to fetch fresh data (D28).

## Advanced usage

### Configuration

The bundle runs `kiro-cli acp` by default. To pin a model, add a backend, or enable workflows, add a **top-level override with the same plugin ID** to your profile's `cordis.patch.yml`. The example below keeps kiro as the default and adds a backend you can select with `backend: codex` when starting a chat. Replace the example model with an ID returned by `model/list` for your account.

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    workflow: true
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

The top-level `command`, `args`, and model settings apply to the default backend. Each named entry under `backends` can have its own model and permission settings. An extra `insert` with the bundle enabled causes a `DUPLICATE_PROVIDER` error. If you disable the bundle, register the plugin manually using the format in the [bundled configuration](cordis.patch.yml).

#### Backend support levels

| Backend | Session recovery and mid-turn instructions | Model and reasoning effort |
| --- | --- | --- |
| **kiro-cli** (v3 by default) | Resumes with `session/load` and accepts instructions during a turn. | The server chooses the model by default. To pin one on v3, set both `modelSelect: session` and `model`, and omit `effort`. v2 accepts the `--model` and `--effort` flags. |
| **Antigravity** (`agy acp`) | Resumes with `session/load`. Recovery after process termination has been verified. | Set `agentEngine: none`. To select a model, set both `modelSelect: session` and `model`. The model ID includes the effort level, so omit `effort`. |
| **Codex** (named backend only) | Uses the private `app-server` protocol, with `thread/resume` for recovery and native `turn/steer` for mid-turn instructions. | Set `model` explicitly. You can set a per-turn `effort` level supported by that model. The `sandbox` default is `read-only`. Other options are `workspace-write` and `danger-full-access`. |

To use another standard ACP CLI, configure its `command` and `args`. Set `agentEngine: none` if the CLI does not accept kiro's `--agent-engine` flag. Resuming a chat in a new process requires the backend's `loadSession` capability. Mid-turn instructions also require backend support.

**Permissions.** With `permission: allow`, the plugin automatically selects an allow option. `reject` declines the request, and `ask` prompts the DSH user for each decision. The bundled kiro configuration uses `allow`. A manually configured backend defaults to `reject` when the field is omitted. For Codex, `approvalPolicy` controls when the backend asks for approval and `permission` controls the response. If `ask` cannot obtain a valid answer, an ACP request is denied and a Codex turn is canceled in full.

### Delegate by role and save repeatable tasks as templates

Enable `workflow: true` and place an `.agents/acp-team.yml` file at the workspace root. Under `roles`, define each role's name, backend, working directory, and the instructions it receives when its chat is first created. Under `templates`, describe how the roles work together. [Copy the example workspace configuration](docs/acp-team.example.yml)

To try the two-reviewer template, ask “Run `dual_review` on `src/pool.ts`, focusing on concurrency and resource cleanup.” The model calls `acp_workflow`, two reviewers read the file in parallel, and an editor combines their findings. A template can also return the results to the main model. The **Workflows** section of the panel shows the current step and the five most recent finished runs. Expand a step to open a participant's chat.

To follow up with a reviewer, use `acp_chat_send` with `role: reviewer`. On first use, the plugin creates a chat from the role definition, sends its initial instructions, and adds it to the roster. Later requests reuse that chat. Each DSH session has its own roster. After editing a role definition, use `acp_chat_close` with the role name to clear the binding. The next assignment uses the updated definition (D27).

### ACP Dispatcher mode

Choose **ACP Dispatcher** from the mode menu when starting a new session to put the main model in charge of delegation. With this optional preset, the model breaks work into tasks, assigns them to subagents, tracks progress, and summarizes the results. It retains task management and lightweight web lookup tools. Subagents run commands and work with files. Standard mode also supports the chat tools and any workflows you enable (D26).

## Reference

### Model tools

| Tool | When to use it |
| --- | --- |
| `acp_chat_start` | Open a persistent chat and get its `chatId`. Specify `backend` to select among configured backends. |
| `acp_chat_send` | Start the next turn, reconnecting as needed. A chat runs one turn at a time. Sending again while it is busy returns an error. |
| `acp_chat_list` | Find subagent chats created in the current DSH session, including chats whose processes have been released. |
| `acp_chat_steer` | Add instructions to a turn in progress. The tool reports when the backend does not support steering. |
| `acp_chat_close` | Release the process for later reconnection, or use `purge` to delete local records. To manage kiro's remote records, list them with `kiro-cli chat --list-sessions` and remove them with `--delete-session`. |
| `acp_workflow` | Run a multi-role workflow by template name and parameters when `workflow` is enabled. |

**Background jobs.** With both `dsh-jobs-local` and `dsh-tool-jobs` installed on the host, sending a message or starting a workflow immediately returns a `jobId`. The model reads the result with `job_output` after the completion notification arrives. It can stop a running job with `job_kill`. By default, the plugin blocks attempts to wait synchronously on running ACP jobs. Without a jobs service, the call returns its result synchronously. Installing only the job registry leaves the controller missing and causes an error (D17, D22).

**Session recovery.** By default, the pool releases a process after 10 minutes of inactivity. If the remote session is known to be lost or the backend does not advertise session loading, the plugin starts a fresh session and prompts for any context the agent needs. The same fallback applies on the next send after three consecutive turn errors in the same chat and pool instance. A load failure with an unknown cause returns an error and preserves the existing binding. The registry defaults to `$DSH_HOME/storages/acp-resume/registry.json`. Alongside it, `turns/<chatId>.jsonl` stores the latest 200 turn records in plain text. [Recovery and logging decisions (D6, D18)](DECISIONS.md)

**Development and verification.** Run `pnpm install`, `pnpm build`, then `pnpm test`. Without a checkout of the official source, 24 tests that use real subprocesses are skipped under D8. Tests with kiro-cli have confirmed that a chat retains its context after process termination. The full smoke test with kiro-cli is still pending. The Codex adapter passes its mock regression suite, with live integration testing still pending. [Architecture](DESIGN.md) · [Verification status](IMPLEMENTATION-PLAN.md) · [MIT license](LICENSE)

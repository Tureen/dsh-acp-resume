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

<a id="configuration"></a><a id="backend-support-levels"></a>

### Resume · Choose a backend for each chat

Add a top-level override with the same plugin ID to your profile’s `cordis.patch.yml`. This keeps `kiro-cli acp` as the default and adds Codex and Antigravity (agy). A second `insert` with the bundle enabled causes a `DUPLICATE_PROVIDER` error. Use model IDs available to your account.

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    workflow: true
    backends:
      codex: {
        protocol: codex, command: codex,
        model: gpt-6.2-astra, effort: high,
        sandbox: read-only, approvalPolicy: on-request, permission: ask
      }
      agy: {
        command: agy, args: [acp], agentEngine: none,
        modelSelect: session, model: gemini-4-carbon-high, permission: ask
      }
```

**Start a chat.** Restart DSH. When the model calls `acp_chat_start`, it supplies an absolute working directory in `cwd` and selects an engine with `backend: codex` or `backend: agy`. Omitting the backend selects kiro. The sidebar shows a backend badge on each chat. Subsequent sends use the same `chatId`.

**Models and permissions.** kiro v3 selects a model automatically. To pin one, set both `modelSelect: session` and `model` and omit `effort`. agy also selects its model per session, with reasoning effort encoded in the model ID. Codex requires a `model` from `model/list`, accepts a per-turn `effort`, and supports three `sandbox` settings: `read-only` (default), `workspace-write`, and `danger-full-access`. Each backend’s `permission` can allow requests automatically (`allow`), decline them (`reject`), or prompt each time (`ask`). The bundled kiro configuration uses `allow`. A manually configured backend defaults to `reject`. For Codex, `approvalPolicy` determines when to request approval.

### ACP Dispatcher mode

Enable the bundle, restart DSH, and select **ACP Dispatcher** from the **mode menu in a new session**. The main agent has ACP tools for delegation, web tools for quick lookups, and jobs tools for tracking work. It has no shell or file tools, so it delegates commands and file operations to workers through `acp_chat_send`. When a job finishes, the main agent receives a notification and retrieves the result with `job_output`. Use this mode to run independent tasks in parallel, cross-check a review with two engines, or follow a long-running task from one conversation. ACP tools are also available in standard mode (D26).

### ACP Workflow · Run a workspace template

Enable `workflow: true` in the plugin configuration above and save the following as `.agents/acp-team.yml` at the workspace root. Each reviewer has a different brief, and the final step returns both reviews to the main model. [More templates, including one with an editor role](docs/acp-team.example.yml)

```yaml
roles:
  - { name: reviewerA, backend: codex, cwd: ., seeding: "Review for correctness." }
  - { name: reviewerB, backend: agy, cwd: ., seeding: "Review for maintainability." }
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

For example, when sessions 1 and 2 run `dual_review` in the same workspace, they read the same template and role blueprints. Reviewer A (`reviewerA`) maps to a different chat in each roster. A follow-up from session 1 using `acp_chat_send` with `role: reviewerA` continues session 1’s review. After editing a blueprint, use `acp_chat_close` with the role name in the current session to clear its binding. The next assignment creates a chat from the updated blueprint (D27).

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

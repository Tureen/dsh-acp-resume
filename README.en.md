[简体中文](README.md)

# dsh-acp-resume

A **resumable ACP subagent backend** for DeepSeek Harness (DSH): an independent sibling of the official `@deepseek-ai/dsh-subagent-acp`. It keeps the official one-shot delegation behavior intact and adds a **persistent session pool**: the agent process is kept alive, the remote session id is saved to disk, and after the process dies the session is reconnected through `session/load`. This lets the model collaborate with the same external ACP agent over many turns. It uses standard ACP methods but has **only been tested with kiro-cli** so far; mid-turn steering (`_session/steer`) is a kiro-specific extension, and the steering tool reports a clear error when the agent does not support it. Point Config `command` at another ACP agent, and set `agentEngine: none` to stop appending `--agent-engine` (kiro's engine flag) for agents that do not accept it.

Install with `dsh plugin --profile <name> add dsh-acp-resume` (requires DSH `>=0.2.2-rc.1` and Node >= 24).

Note: the design documents linked below (DESIGN.md, DECISIONS.md, IMPLEMENTATION-PLAN.md, PANEL-DESIGN.md) are written in Chinese.

Status: published on npm (0.1.17). Connection primitives, the session pool, five tools, the persistent chats panel, and wiring are implemented and have been through one six-dimension review fix round (D16).

**Known limitations and next steps**: the full real-machine kiro-cli smoke script (create a session → two turns → kill the process → reconnect and recall the context → idle release → reconnect again) has not been fully run yet, and that behavior is currently covered by tests against the mock server; only kiro-cli has been tested, other ACP agents have not. Progress is tracked in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).

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
| `acp_chat_list` | List active and persisted sessions |
| `acp_chat_close` | Release the session process (the record stays and can be reconnected; `purge` also deletes the record) |
| `acp_chat_steer` | Add an instruction to a turn **in flight**: the queued message takes effect at the next tool/message boundary without interrupting the current step; to stop immediately use `job_kill` / `acp_chat_close`. Errors when there is no turn in flight (use send instead); when the agent does not implement the private extension `_session/steer`, it reports "the current agent does not support steering" (D19) |
| **Persistent chats panel** (right sidebar, D15/D18) | A per-session view: status / turn count / summary, with release and delete; click a card to open that session's detail tab (metadata + each turn's question and answer, outcome, reconnect events). See [PANEL-DESIGN.md](PANEL-DESIGN.md) |

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
        model: glm-5                 # default unset = server auto routing (picks a model per task). When set, pins the model by appending --model <id>; if args already contains --model, args wins
        effort: high                 # default unset = the model's own default level. When set, appends --effort <level> (low/medium/high/xhigh/max, depends on the model); if args already contains --effort, args wins
        providerName: acp-resume     # default acp-resume; does not conflict with the official acp
        permission: allow            # the schema fallback default is reject; same semantics as the official package: allow / reject (see "The two defaults of permission" below)
        env: {}                      # variables layered on top of the sanitized parent environment (e.g. the child agent's own key)
        enableChatTools: true        # default true; when false only the one-shot provider is registered
        toolPrefix: acp_chat_        # default acp_chat_; the prefix of the five tool names
        allowChatJobWait: false      # default false; when false, job_output wait:true on a running acp-chat job is rejected (D22), true lifts the block
        idleTimeoutMs: 600000        # default 600000; how long idle before the process is released
        disposeEofGraceMs: 6000      # default 6000; how long to wait for the child to wrap up by itself after stdin is closed
        disposeGraceMs: 3000         # default 3000; grace for observing failure/escalation signals, and also the upper bound close waits for an in-flight turn to settle
        registryPath: ''             # default empty string = $DSH_HOME/storages/acp-resume/registry.json; a custom value must be an absolute path
```

`agentEngine` applies to both the one-shot provider and the persistent sessions. The default `v3` appends `--agent-engine v3` to the child process; this is kiro-cli's engine selection flag. When you use another ACP agent that does not accept the flag (most will exit on an unknown argument), set `agentEngine` to `none` and it is no longer appended. `none` only affects the appending: a `--agent-engine` that you write yourself in `args` is passed to the child process as is. When reconnecting an old session, the fingerprint check ignores this flag, so switching engines does not make an old session get rejected; if the new engine cannot read the old session, it degrades to a new session under the usual rule.

**The two defaults of `permission`.** When the bundle is enabled, the bundled `cordis.patch.yml` sets `permission` to `allow` (permission requests from the agent are approved unattended, as an out-of-the-box default together with `command: kiro-cli`). When you skip the patch, wire it by hand with `- insert:` as in the example above, and leave `permission` out, the Config schema's fallback default is `reject`. The two differ on purpose: the patch default is tuned for kiro-cli to work out of the box, while the schema fallback takes the more conservative side. When you use another agent or want to tighten this, write `permission: reject` explicitly in a top-level override with the same id in your profile.

`model` / `effort` also apply to both paths and are **spawn-level** choices (they act on the session the child process starts). When either is unset, its flag is not appended, which keeps kiro's `auto` (the server picks the model per task dynamically, and `effort` is not under your control); when set, the model/level is pinned. **Effective semantics**: they only apply to the next process that starts. A session process that is already running is not affected, and a session you are continuing has to wait until it is released when idle and reconnected by the next `acp_chat_send` (a new process) before the new model is applied. Like `--agent-engine`, the fingerprint check also ignores `--model` / `--effort` (reason in D19): `auto` already switches models per task within a session, so pinning a different model does not make it "a different agent", and old sessions stay continuable.

`allowChatJobWait` (D22): one conversation turn often runs for ten-odd minutes, and a model hard-waiting with `job_output`'s `wait: true` hits the host's 600-second ceiling, during which the user's new messages queue up. By default, a wait on a **running** acp-chat job is rejected before the tool is dispatched, and the model is told to wait for the completion notification; jobs that have already settled and jobs of other kinds (such as bash) are not affected. Set `true` to turn this block off.

The three duration fields must be positive and no greater than Node's timer limit, and a relative `registryPath` makes the plugin error at startup.

## Install and upgrade

**Main path: install from npm.** Requires DSH `>=0.2.2-rc.1` (the package's `engines.dsh` sets only a minimum version and no installation ceiling for later DSH release lines) and Node >= 24:

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

> **Note:** If installation reports `ERR_PNPM_TARBALL_EXTRACT` or a checksum error, dsh's default `minimumReleaseAge` supply-chain protection has filtered out the newly published version. A first npm release can also include the invalid placeholder version `0.0.0-stage`. Pin the version explicitly: `dsh plugin --profile <name> add dsh-acp-resume@<version>`. dsh writes that version to the profile's `minimumReleaseAgeExclude`, so installation succeeds immediately. The unpinned command works again after the release has aged for a while.

`<name>` is the profile name (the default profile directory of the DSH App is `~/.dsh/profiles/desktop/`). After installing, the package appears in that profile's `dsh.profile.bundles`, and takes effect after DSH restarts. To upgrade, use `dsh plugin --profile <name> add dsh-acp-resume@<version>`; to uninstall, use `dsh plugin --profile <name> remove dsh-acp-resume`.

**Install from Discover (experimental).** Enable the **Custom plugin markets** experimental switch on the Plugins page. Then open **Discover**, select **Add index source**, and enter `https://tureen.github.io/dsh-acp-resume/index.json`. When the index loads, install from the `dsh-acp-resume` card and restart DSH.

**Alternative: a local tgz.** After `pnpm build` in this repository, run `pnpm pack --pack-destination <stable directory>` (`prepack` clears `lib/` and recompiles first, so no stale output is packed), then `dsh plugin --profile <name> add <path to the tgz>`.

- Keep the tgz in a stable location, such as `~/.dsh/local-plugins/`, not `/tmp`. The profile's `package.json` references the tgz by a `file:` path, and once the system clears `/tmp`, any plugin addition or removal in the profile (each triggers a pnpm install) fails because the file cannot be found.
- Upgrading requires changing the version number. Re-packing with the same version does not take effect: pnpm identifies a package by the hash in the lockfile and reuses the old cache when the version and path are unchanged.

**Git install is not supported.** This package has no `prepare` script and `lib/` is not checked in, so installing with `github:` gets only the sources and loading fails. Supporting it would need a self-contained `prepare`, and users would also have to enable `allowBuilds` for this package in the profile's `pnpm-workspace.yaml` (which means allowing package code to run at install time); the cost is described in the "Installing from GitHub" section of the official `docs/user/develop/basic/publish.md`. Please use npm or a tgz.

- **Choose either the bundle or a profile insert, do not mount both.** When the profile's `dsh.profile.bundles` lists `dsh-acp-resume` (the switch on the Plugins page is on), this package's bundled `cordis.patch.yml` has already inserted the plugin; inserting it again from the profile registers two providers with the same name and fails with `DUPLICATE_PROVIDER`. When the bundle is enabled, change the configuration with a top-level override with the same id:

  ```yaml
  - id: subagent-acp-resume
    name: 'dsh-acp-resume'
    config:
      command: /absolute/path/to/kiro-cli
  ```

## Host prerequisites for background job mode

The background mode of `acp_chat_send` needs the host to have both `@deepseek-ai/dsh-jobs-local` (provides `ctx.jobs`) and `@deepseek-ai/dsh-tool-jobs` (mounts the job controller and provides `job_output` / `job_list` / `job_kill` and completion notifications). With only the former, send fails with a "no controller" tool error; with neither, send falls back to waiting synchronously.

## Pre-checks before a real-machine smoke test

- Capture one real `initialize` response and confirm that `agentCapabilities.loadSession` is `true`. This capability is checked before reconnecting; when it is not declared, every reconnect degrades to a new session and continuing a chat stops working (D16).
- kiro's load is sensitive to cwd: confirm that the registry replays the original cwd (see "Risks and countermeasures" in DESIGN.md).

## Development

```sh
pnpm install && pnpm build     # build lib/
pnpm test                      # vitest; 314 green = official protocol surface 67 + connection 24 + pool 60 + tools 13 + jobs 12 + panel 16 + client 70 + steer 5 + engine 16 + turn-log 18 + job-wait-gate 13
```

- Baseline: checked against `dsh-v0.2.2-rc.1`; `src/run.ts` matches `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.1`. DSH peers are pinned to `~0.2.2-rc.1`, and the Cordis peer to `~4.1.0`;
- Conditionally run cases: the 24 real-child-process cases need `spawn.ts` from the official checkout (not included in the npm distribution). When the official checkout (its path given by the environment variable `DSH_OFFICIAL_CHECKOUT`; when unset, the default location in the tests is used) is present, everything is green and the exit code is 0; when it is absent, these 24 cases are skipped automatically (see DECISIONS D8);
- Two implementations side by side: run.ts stays the official original and is not refactored (D11); connection.ts is the sibling implementation dedicated to the pool;
- Official source checkout used for reference: tag `dsh-v0.2.2-rc.1` (read-only comparison).

## License

MIT

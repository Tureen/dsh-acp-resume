# Resumable ACP subagent

`dsh-acp-resume` lets DeepSeek Harness (DSH) keep a multi-turn conversation with an external ACP agent. It preserves the official one-shot delegation path while saving the remote session id locally. When the process exits or is released after idle time, the next send continues the session through `session/load`.

## Install

- **npm:** Run `dsh plugin --profile <name> add dsh-acp-resume`. If a newly published version is filtered by `minimumReleaseAge`, pin it: `dsh plugin --profile <name> add dsh-acp-resume@<version>`.
- **Discover:** On the **Plugins** page, enable **Custom plugin indexes** under **Experimental plugins**. Open **Discover**, choose **Add index source**, enter `https://tureen.github.io/dsh-acp-resume/index.json`, then confirm installation from the `dsh-acp-resume` card.

Restart DSH after installation. See the [README](../README.en.md) for npm, local tgz, and upgrade instructions.

## Chat tools and panel

The model can use five tools:

- `acp_chat_start`: Create a persistent chat and return its `chatId`.
- `acp_chat_send`: Send a message. It returns a job id immediately when the host supports background jobs, otherwise it waits for the answer.
- `acp_chat_list`: List active and released chats.
- `acp_chat_close`: Release the process; use `purge` to also delete the local record.
- `acp_chat_steer`: Add a follow-up instruction to a turn that is still running.

The Persistent chats panel in the right sidebar shows each chat's state, turn count, and details, and can release or delete it. Select a card to review every question, answer, and reconnect event.

## Key configuration

- `command`: The external ACP agent executable. The default example uses `kiro-cli`.
- `permission`: `allow` approves automatically, `reject` denies automatically, and `ask` forwards every request to the host user-confirmation interface. The bundle defaults to `allow`; `ask` denies when no confirmation service or valid answer is available.
- `agentEngine: none`: Set this when the agent does not accept kiro's `--agent-engine` argument, so the plugin does not append it.

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

See the [README](../README.en.md#configuration) for all configuration fields, defaults, and manual wiring.

## Known limitations

- Only `kiro-cli` has been tested so far. Verify other ACP agents independently.
- `acp_chat_steer` uses kiro's private `_session/steer` extension. Other agents report a clear error when they do not implement it.
- Persistent chats need the remote agent to support `session/load`. When a session is lost or repeatedly fails, the plugin starts a fresh chat and tells the model to restate the needed context.

## Links

- [GitHub repository](https://github.com/Tureen/dsh-acp-resume)
- [npm package](https://www.npmjs.com/package/dsh-acp-resume)
- [Plugin index](https://tureen.github.io/dsh-acp-resume/index.json)

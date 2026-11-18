# 可续聊 ACP 子代理

`dsh-acp-resume` 让 DeepSeek Harness (DSH) 与外部 ACP agent 保持同一条多轮会话。它保留官方一次性委派能力，同时将远端会话号保存在本地：进程退出或空闲释放后，下一次发送会通过 `session/load` 继续原会话。

## 安装

- **npm：**运行 `dsh plugin --profile <name> add dsh-acp-resume`。若刚发布的版本被 `minimumReleaseAge` 过滤，请钉住版本：`dsh plugin --profile <name> add dsh-acp-resume@<版本>`。
- **Discover：**在 **插件** 页的 **实验性插件** 中启用 **自定义插件索引**。打开 **发现**，选择 **添加索引源**，填入 `https://tureen.github.io/dsh-acp-resume/index.json`，再从 `dsh-acp-resume` 卡片确认安装。

安装后重启 DSH。详细的 npm、本地 tgz 与升级说明见 [README](../README.md)。

## 会话工具与面板

模型可使用五个工具：

- `acp_chat_start`：建立持久会话并返回 `chatId`。
- `acp_chat_send`：发送消息。宿主支持后台任务时会立即返回 job id；否则同步等待回答。
- `acp_chat_list`：仅列出当前 DSH 会话创建的活跃和已释放会话。
- `acp_chat_close`：释放进程；使用 `purge` 同时删除本地记录。
- `acp_chat_steer`：向正在执行的一轮插入后续指令。

右侧栏的“持久会话”面板可查看会话状态、轮次和详情，并可释放或删除会话。点击卡片可查看每一轮的问题、回答和重连事件。

## 关键配置

- `command`：外部 ACP agent 的可执行文件。默认示例使用 `kiro-cli`。
- `permission`：`allow` 自动允许、`reject` 自动拒绝、`ask` 将每次请求交给宿主用户确认。bundle 默认 `allow`；无确认服务或有效回答时 `ask` 会拒绝。
- `agentEngine: none`：所用 agent 不接受 kiro 的 `--agent-engine` 参数时设置，避免追加该参数。
- `model` / `effort`：通过 `--model` / `--effort` CLI 旗标生效，仅对接受这些旗标的 agent 有效；agy 会拒绝它们，请勿设置。

### 后端支持等级

- **一等支持：kiro-cli。** 默认后端，支持 `_session/steer`、`--agent-engine v3`、跨进程 `session/load` 与 model/effort CLI 旗标。
- **一等支持：agy / Antigravity。** 支持 update 归一化、`session/set_model` 和跨进程 `session/load`；必须设 `agentEngine: 'none'`，不要设 model/effort，建议 `permission: ask`。
- **一等支持：Codex。** 走 `codex app-server` 私有协议（`protocol: codex`，只能作命名后端）：原生 steer、`thread/resume` 跨进程恢复、分项审批（`permission: ask` 逐次问用户）。必须设 `model`，可设 `sandbox`、`approvalPolicy`、`effort`（`low` / `medium` / `high` / `xhigh` / `max` / `ultra`，`ultra` 仅部分模型）。模型清单来自 `codex app-server` 的 `model/list`；agy 的在 `initialize` 响应的 `models.availableModels`，effort 内嵌在模型 ID；kiro 模型动态（auto）。目前仅经 mock 验证，真机探针待做。
- **通用 ACP（Other）。** 适用于 opencode、gemini-cli 等标准 ACP CLI；必须设 `agentEngine: 'none'`。steer、loadSession、model/effort 是否可用取决于该 agent 的能力和 CLI 旗标支持。

完整的支持等级、agy 配方和模型列表见 [README 的后端支持等级](../README.md#后端支持等级)。

### 新手配方

以下是 bundle 已启用时写进 profile `cordis.patch.yml` 的顶层同 id 覆盖，不要再加第二个 `- insert:`。

**默认 kiro-cli。** 无需覆盖：安装 `kiro-cli` 并确保它在 `PATH` 中即可使用自带的 `command: kiro-cli` 和 `args: [acp]`。

**指定路径的 kiro-cli。**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/kiro-cli
    args: [acp]
```

**换用其他 ACP agent，并逐次询问权限。**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/other-acp-agent
    args: [acp]
    agentEngine: 'none'
    permission: ask
```

**Codex（命名后端）。**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    backends:
      codex:
        protocol: codex
        command: codex
        model: gpt-6.2-astra
        effort: xhigh               # effort 可选:low | medium | high | xhigh | max | ultra(ultra 仅部分模型);完整模型清单见 README
        sandbox: workspace-write
        approvalPolicy: on-request
        permission: ask
```

完整配置、默认值和手动接线方式见 [README](../README.md#配置)。

## ACP Dispatcher 模式

自带可选 preset「ACP Dispatcher」:主 Agent 只派工(拆任务、派给 ACP 后端、收结果),没有 bash / 文件 / 网络工具。在会话模式菜单里选择;不选则一切照旧。

## 已知限制

- kiro-cli、agy / Antigravity 与 Codex 属一等支持（Codex 尚未做真机验证）；Other 通用 ACP 后端仍需按其能力自行验证。
- `acp_chat_steer` 在 kiro 上使用专属的 `_session/steer` 扩展，在 Codex 上使用原生 `turn/steer`。其他 agent 未实现时会明确报错。
- 持久会话依赖远端 agent 支持 `session/load`。会话丢失或连续失败时，插件会新开会话并提示重新提供必要上下文。

## 链接

- [GitHub 仓库](https://github.com/Tureen/dsh-acp-resume)
- [npm 包](https://www.npmjs.com/package/dsh-acp-resume)
- [插件索引](https://tureen.github.io/dsh-acp-resume/index.json)

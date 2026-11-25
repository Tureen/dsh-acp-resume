# 可续聊 ACP 子代理

`dsh-acp-resume` 让 DeepSeek Harness (DSH) 与外部 ACP agent 保持同一条多轮会话。它保留官方一次性委派能力，同时将远端会话号保存在本地：进程退出或空闲释放后，下一次发送会通过 `session/load` 继续原会话。

## 工作区角色与工作流

该功能默认关闭，需在插件配置里设 `workflow: true`。在工作区根目录写 `.agents/acp-team.yml`,定义角色蓝图(名称、后端、工作目录、播种消息)和流程模板。模型可以按角色名派发任务：调用 `acp_chat_send` 时传 `role`,本会话首次引用某个角色会自动建会话并发送播种消息，之后直接复用。`acp_workflow` 按模板编排多个角色，如双审核、双路调研：同一步的角色并行执行，后一步能拿到前一步的结果，最后由模型或指定角色合并。示例见 [docs/acp-team.example.yml](acp-team.example.yml)。

## 安装

- **npm：**运行 `dsh plugin --profile <name> add dsh-acp-resume`。若刚发布的版本被 `minimumReleaseAge` 过滤，请钉住版本：`dsh plugin --profile <name> add dsh-acp-resume@<版本>`。
- **Discover：**在 **插件** 页的 **实验性插件** 中启用 **自定义插件索引**。打开 **发现**，选择 **添加索引源**，填入 `https://tureen.github.io/dsh-acp-resume/index.json`，再从 `dsh-acp-resume` 卡片确认安装。

> ⚠️ **不要从 GitHub 地址安装。** 本仓库不含构建产物(`lib/` 已 gitignore),也没有 `prepare` 脚本,从 GitHub 地址(如 `github:Tureen/dsh-acp-resume`)安装会因缺少 `lib/index.js` 而加载失败。
>
> - 正确方式:用 npm 包名 `dsh plugin --profile <name> add dsh-acp-resume`,或从 Discover 市场安装。
> - 确需离线安装时，可用 `npm pack dsh-acp-resume` 下载 tgz 后 `dsh plugin --profile <name> add <tgz 路径>` 本地安装;不推荐，这样装的插件没有更新按钮。

安装后重启 DSH。默认开启后端发现；在右侧栏 **ACP 会话** 展开 **后端状态**，可查看各 CLI 的版本和就绪情况。升级、登录或更换默认模型后，可直接点同一行的 **重新检测后端**；不需要重启，也不会删除会话、退出登录或修改配置。未显式选择后端或固定默认项时，能找到配置的 Kiro 就仍用 Kiro；版本、握手或登录问题不会改派。只有 DSH 确认找不到该 Kiro 可执行文件，才依次选择就绪的 Codex、Antigravity（`agy`），这两个后端均可零配置接入。可用 `discoverBackends: false` 关闭额外发现。见[支持的 CLI 版本](backend-compatibility.md)和 [README](../README.md)。

## 会话工具与面板

模型可使用五个工具：

- `acp_chat_start`：建立持久会话并返回 `chatId`。
- `acp_chat_send`：发送消息。宿主支持后台任务时会立即返回 job id；否则同步等待回答。
- `acp_chat_list`：仅列出当前 DSH 会话创建的活跃和已释放会话。
- `acp_chat_close`：释放进程；使用 `purge` 同时删除本地记录。
- `acp_chat_steer`：向正在执行的一轮插入后续指令。

右侧栏的“持久会话”面板可查看会话状态、轮次和详情，并可释放或删除会话。点击卡片可查看每一轮的问题、回答和重连事件。

## 关键配置

- `command`：外部 ACP agent 的可执行文件。自定义顶层后端保留原来的 `default` 路由。
- `defaultBackend`：固定新会话的默认后端；不可用时不会自动切换。显式传入的 `backend` 优先。
- `allowUnverifiedBackends: true`：允许显式尝试自动发现的范围外 CLI，但不会把它加入自动选择。已配置后端的版本检查只告警；已有会话发送和重连不受检测状态影响。
- `permission`：`allow` 自动允许、`reject` 自动拒绝、`ask` 将每次请求交给宿主用户确认。bundle 默认 `allow`；无确认服务或有效回答时 `ask` 会拒绝。
- `agentEngine: none`：所用 agent 不接受 kiro 的 `--agent-engine` 参数时设置，避免追加该参数。
- `model` / `effort`：默认（`modelSelect: flag`）通过 `--model` / `--effort` CLI 旗标生效，仅对接受这些旗标的 agent 有效（kiro v2 引擎）；agy 与 kiro v3 会拒绝它们，直接设置会启动失败。这两类后端请设 `modelSelect: session`，两项都改走会话级方法、不再追加旗标；kiro v3 的 `effort` 此时限 `low` / `medium` / `high` / `xhigh` / `max`，其他值加载即报错。

### 后端支持等级

- **一等支持：kiro-cli。** 默认后端，支持 `_session/steer`、`--agent-engine v3`、跨进程 `session/load`。v3（默认）用 `modelSelect: session` + `model` 选模型、+ `effort` 选思考强度（都经 `session/set_config_option`；所选模型不支持该强度时只记告警）；不设 `modelSelect: session` 时直接设 model/effort 会追加 v3 拒绝的 CLI 旗标，导致启动失败。v2（遗留）才支持 `--model` / `--effort` 旗标。
- **一等支持：agy / Antigravity。** 支持 update 归一化、`session/set_model` 和跨进程 `session/load`；可自动接入（使用 CLI 的模型设置，拒绝权限请求）；显式配置时应设 `agentEngine: 'none'`；选模型用 `modelSelect: session` + `model`（经 `session/set_model`），不设 `modelSelect: session` 时不要设 `model`，任何情况都不要设 `effort`（已内嵌在模型 ID）；建议 `permission: ask`。
- **一等支持：Codex。** 走 `codex app-server` 私有协议（可自动接入；手动配置时用 `protocol: codex` 声明命名后端）：原生 steer、`thread/resume` 跨进程恢复、分项审批（`permission: ask` 逐次问用户）。可覆盖 `model`，也可使用 Codex 的默认模型；可设 `sandbox`、`approvalPolicy`、`effort`（`low` / `medium` / `high` / `xhigh` / `max` / `ultra`，`ultra` 仅部分模型）。Codex 模型清单来自 `codex app-server` 的 `model/list`。
- **通用 ACP（Other）。** 适用于 opencode、gemini-cli 等标准 ACP CLI；必须设 `agentEngine: 'none'`。steer、loadSession、model/effort 是否可用取决于该 agent 的能力和 CLI 旗标支持。

自动接入和手动覆盖示例见 [README 的后端选择说明](../README.md#选择后端)。

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

默认值和手动接线方式见 [README](../README.md#让模型在多个后端中选择)。

## ACP Dispatcher 模式

自带可选会话模式「ACP Dispatcher」：一个会话就是一个多工人工作台。用户留在同一对话窗口，主 Agent 像工头一样拆任务、派给可并行的 ACP 工人会话、收结果并合成答复，默认没有 bash 或文件工具，可按需开启只读文件核对。

- **好用场景**:多任务并行;同一问题派给不同后端交叉验证;长任务托管;让主 Agent 上下文保持精简。
- **切换**:新会话的模式菜单里选 **ACP Dispatcher**;不选则一切照旧,标准模式下 `acp_chat_*` 照常可用。

详细对比与不适用场景见 [README](../README.md#acp-dispatcher-模式)。

## 已知限制

- 自动回退的候选受[发布的版本范围](backend-compatibility.md)和就绪状态限制；已配置后端的版本检测只作诊断。通用 ACP 后端仍需按其协议能力自行验证。
- `acp_chat_steer` 在 kiro 上使用专属的 `_session/steer` 扩展，在 Codex 上使用原生 `turn/steer`。其他 agent 未实现时会明确报错。
- 持久会话依赖远端 agent 支持 `session/load`。会话丢失或连续失败时，插件会新开会话并提示重新提供必要上下文。

## 链接

- [GitHub 仓库](https://github.com/Tureen/dsh-acp-resume)
- [npm 包](https://www.npmjs.com/package/dsh-acp-resume)
- [插件索引](https://tureen.github.io/dsh-acp-resume/index.json)

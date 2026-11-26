# 可续聊 ACP 子代理

`dsh-acp-resume` 让 DeepSeek Harness (DSH) 与外部 ACP agent 保持同一条多轮会话。它保留官方一次性委派能力，同时将远端会话号保存在本地：进程退出或空闲释放后，下一次发送会通过 `session/load` 继续原会话。

## 工作区角色与工作流

按角色派工默认开启（`roles: true`）。在工作区的 `.agents/acp-team.yml` 中定义角色和可选的 `summary`，模型就能用 `acp_team_list` 查看分工和状态，再用 `acp_chat_send` 的 `role` 派工。首次创建配置了 `seeding` 的角色会话时，Worker 会先读到自己的角色名和队友分工。

`workflow` 默认是 `false`。按模板执行多角色任务时，开启 `workflow: true` 即可使用 `acp_workflow`；与 `roles: false` 同时配置会在加载时报错。[角色与模板示例](acp-team.example.yml)

## 安装

- **npm：**运行 `dsh plugin --profile <name> add dsh-acp-resume`。若刚发布的版本被 `minimumReleaseAge` 过滤，请钉住版本：`dsh plugin --profile <name> add dsh-acp-resume@<版本>`。
- **Discover：**在 **插件** 页的 **实验性插件** 中启用 **自定义插件索引**。打开 **发现**，选择 **添加索引源**，填入 `https://tureen.github.io/dsh-acp-resume/index.json`，再从 `dsh-acp-resume` 卡片确认安装。

> ⚠️ **不要从 GitHub 地址安装。** 本仓库不含构建产物(`lib/` 已 gitignore),也没有 `prepare` 脚本,从 GitHub 地址(如 `github:Tureen/dsh-acp-resume`)安装会因缺少 `lib/index.js` 而加载失败。
>
> - 正确方式:用 npm 包名 `dsh plugin --profile <name> add dsh-acp-resume`,或从 Discover 市场安装。
> - 确需离线安装时，可用 `npm pack dsh-acp-resume` 下载 tgz 后 `dsh plugin --profile <name> add <tgz 路径>` 本地安装;不推荐，这样装的插件没有更新按钮。

安装后重启 DSH。默认开启后端发现；在右侧栏 **ACP 会话** 展开 **后端状态**，可查看各 CLI 的版本和就绪情况。升级、登录或更换默认模型后，可直接点同一行的 **重新检测后端**；不需要重启，也不会删除会话、退出登录或修改配置。未显式选择后端或固定默认项时，能找到配置的 Kiro 就仍用 Kiro；版本、握手或登录问题不会改派。只有 DSH 确认找不到该 Kiro 可执行文件，才依次选择就绪的 Codex、Antigravity（`agy`），这两个后端均可零配置接入。可用 `discoverBackends: false` 关闭额外发现。见[支持的 CLI 版本](backend-compatibility.md)和 [README](../README.md)。

## 会话工具与面板

五个持久会话工具分别用于：

- `acp_chat_start`：建立持久会话并返回 `chatId`。
- `acp_chat_send`：发送消息。宿主支持后台任务时会立即返回 job id；否则同步等待回答。
- `acp_chat_list`：仅列出当前 DSH 会话创建的活跃和已释放会话。
- `acp_chat_close`：释放进程；使用 `purge` 同时删除本地记录。
- `acp_chat_steer`：向正在执行的一轮插入后续指令。

模型可用 `acp_backend_status` 查看后端就绪状态。显式配置了 `protocol: codex` 的后端时，还可用 `acp_backend_usage` 查询额度。

右侧栏的「ACP 会话」面板可查看轮次和重连记录，也可释放或删除会话。关闭工作流时，打开工作流区块只读一次历史，随后停止轮询；关闭持久会话时，列表和详情页显示「持久会话已关闭」。

## 关键配置

- `command`：外部 ACP agent 的可执行文件。自定义顶层后端保留原来的 `default` 路由。
- `defaultBackend`：固定新会话的默认后端；不可用时不会自动切换。显式传入的 `backend` 优先。
- `allowUnverifiedBackends: true`：允许显式尝试自动发现的范围外 CLI，但不会把它加入自动选择。已配置后端的版本检查只告警；已有会话发送和重连不受检测状态影响。
- `permission`：`allow` 自动允许、`reject` 自动拒绝、`ask` 将每次请求交给宿主用户确认。bundle 默认 `allow`；无确认服务或有效回答时 `ask` 会拒绝。
- `agentEngine: none`：所用 agent 不接受 kiro 的 `--agent-engine` 参数时设置，避免追加该参数。
- `model` / `effort`：kiro v2 可通过 CLI 旗标设置。kiro v3 的持久会话使用 `modelSelect: session`，在建会话或重连时设置强度，不追加 `--effort`。可填 `low`、`medium`、`high`、`xhigh`、`max`，具体档位随模型而异。agy 在同一模式下接受前四档，经 `thought_level` 设置；例如 `effort: high`。

### 后端支持等级

- **一等支持：kiro-cli。** 默认后端，支持 `_session/steer`、`--agent-engine v3`、跨进程 `session/load`。v3（默认）用 `modelSelect: session` + `model` 选模型、+ `effort` 选思考强度（都经 `session/set_config_option`；所选模型不支持该强度时只记告警）；不设 `modelSelect: session` 时直接设 model/effort 会追加 v3 拒绝的 CLI 旗标，导致启动失败。v2（遗留）才支持 `--model` / `--effort` 旗标。
- **一等支持：agy / Antigravity。** 支持 update 归一化、`session/set_model` 和跨进程 `session/load`；可自动接入（使用 CLI 的模型设置，拒绝权限请求）；显式配置时应设 `agentEngine: 'none'`；选模型用 `modelSelect: session` + `model`（经 `session/set_model`），不设 `modelSelect: session` 时不要设 `model`，会话模式可设 `effort: high`，新建和重连后各确认一次；建议 `permission: ask`。
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
    command: kiro-cli
    args: [acp]
    permission: allow
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

在 `acp-dispatcher-settings` 行设置 `dispatcherTools`。只读文件核对（含技能读取）默认关，web、交付物展示、任务清单、澄清提问和压缩组默认开。标准模式可直接查随包的 acp-resume-docs；Dispatcher 开启 `readOnlyFs` 后也可加载文档及参考页。升级前覆盖过 `preset-acp-dispatcher` 的用户需迁移旧行。[配置示例与迁移指引](../README.md#acp-dispatcher-模式)

## 已知限制

- 自动回退的候选受[发布的版本范围](backend-compatibility.md)和就绪状态限制；已配置后端的版本检测只作诊断。通用 ACP 后端仍需按其协议能力自行验证。
- `acp_chat_steer` 在 kiro 上使用专属的 `_session/steer` 扩展，在 Codex 上使用原生 `turn/steer`。其他 agent 未实现时会明确报错。
- 持久会话依赖远端 agent 支持 `session/load`。会话丢失或连续失败时，插件会新开会话并提示重新提供必要上下文。

## 链接

- [GitHub 仓库](https://github.com/Tureen/dsh-acp-resume)
- [npm 包](https://www.npmjs.com/package/dsh-acp-resume)
- [插件索引](https://tureen.github.io/dsh-acp-resume/index.json)

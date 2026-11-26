# dsh-acp-resume

[English](README.en.md)

## 为什么需要这个插件

### Resume · 让同一个子代理记得上轮工作

DeepSeek Harness（DSH）官方的 ACP 后端采用一次性委派，每次都从新会话开始，追问上轮审核的第二条发现也得重新交代背景。Resume 保留同一个子代理会话，你只需说“再查一下第二条”，它就能沿用读过的代码、找到的证据和之前的判断。插件可与官方后端并用，持久会话池会复用进程并保存远端会话号，进程退出或空闲释放后，下次发送仍会尝试恢复原会话。

### ACP Dispatcher · 在一个对话窗口调度多个子代理

插件让所有模式都能使用 ACP 工具，ACP Dispatcher 则是可选的纯派工预设。在这个模式的默认配置下，主 Agent 没有 bash 和文件操作工具，它在一个对话窗口里拆任务、分派给各个 ACP 会话执行，再收回结果。你可以让 kiro 写代码，同时让 Codex 推演边界条件，也可以让两个引擎独立核查同一结论，或把长任务交给子代理，在原窗口跟进。

### ACP Workflow · 把反复使用的协作步骤写成模板

如果每次审核都需要两人独立检查、再由一人汇总，可以在工作区的 `.agents/acp-team.yml` 里写好角色蓝图和流程模板。角色默认可用，开启 `workflow` 后，模型只需调用一次 `acp_workflow`，执行器就按模板先让两个审核角色并行检查，再把结果交给汇总角色。下次审核可复用同一模板，步骤顺序、并行分工和合并方式都由配置确定，模型无需临场记住并派发每一步。

## 安装

需要 DSH `>=0.2.2-rc.3`、Node.js 24 或更高版本，以及至少一个可用的后端。自动接入请使用[兼容范围内的 CLI](docs/backend-compatibility.md)。Kiro 不是必装依赖；也可以只用 Codex 或 agy。

从 npm 安装到你的 DSH profile，将 `<name>` 换成实际名称，安装后重启 DSH：

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

升级时在包名后追加 `@<版本>`。如果刚发布的版本被 `minimumReleaseAge` 过滤，也可以这样指定版本安装。桌面 App 可从 Discover 安装，离线环境可从本地 tgz 安装。[市场详情与安装步骤](docs/detail.zh.md#安装)

> ⚠️ **不要从 GitHub 地址安装。** 仓库不含构建产物，也没有安装时编译的 `prepare` 脚本，直接安装会因缺少 `lib/index.js` 加载失败。

插件随包提供 **ACP Resume Docs** 使用文档（`acp-resume-docs`）。在标准模式询问插件配置或派工报错时，模型可自动查阅这份 skill；在 Dispatcher 中开启 `readOnlyFs` 即可加载并阅读其参考页。

## 选择后端

<a id="配置"></a><a id="后端支持等级"></a>

| 后端 | 支持能力 |
| --- | --- |
| **kiro-cli**（默认） | 自带配置使用 `kiro-cli acp` 和 v3 引擎，支持跨进程恢复会话和在当前轮插话；可用 `modelSelect: session` + `effort` 指定思考强度（`low`、`medium`、`high`、`xhigh`、`max`）。 |
| **Antigravity**（agy） | 自动通过 `agy acp` 接入，支持恢复会话和按会话选择模型、思考强度（具体档位取决于模型）。 |
| **Codex** | 通过私有 `codex app-server` 协议恢复会话、插话并逐项审批；支持自动接入，也可显式配置命名后端。 |

插件默认开启 `discoverBackends`：启动时用 DSH 的 `PATH` 和显式配置路径检测 CLI，按[发布兼容表](docs/backend-compatibility.md)判断版本，并验证符合条件的内置后端。检测不会创建会话或发送提示词；CLI 自身可能联网。在 **右侧栏 → ACP 会话** 展开 **后端状态**，可查看版本、就绪情况和失败原因。升级 CLI、登录或更换默认模型后，可以直接点击同一行的 **重新检测后端**，无需展开或重启 DSH；不会删除会话、退出登录或修改配置。

### 只用一个后端

确保 DSH 能找到受支持的 CLI，并按需在 CLI 中登录。未显式选择后端或固定默认项时，DSH 找得到配置的 Kiro 就按原配置使用它；版本告警、探测失败或需要登录都不会触发改派。**只有 DSH 确认找不到配置的 Kiro 可执行文件时**，才依次尝试选择就绪的 Codex、Antigravity（`agy`），无需另写 YAML。

自动接入的 Antigravity 使用 `agy acp` 和 CLI 的模型设置，不自动批准权限请求。启动时只握手，不创建会话；若首次建会话返回需要认证，请在 `agy` 中登录，再重新检测。要手动覆盖 Antigravity 的路径、模型或权限，可以定义命名后端：

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

如修改配置，请重启 DSH。要固定模型，kiro v3 和 agy 都需同时设置 `modelSelect: session` 和 `model`。kiro v3 的持久会话还可在此模式下设置 `effort`：建会话和重连时应用，不追加 `--effort` 启动旗标。可填 `low`、`medium`、`high`、`xhigh`、`max`，其他值会在加载时报配置错误。具体档位随模型而异，模型不支持所选档位时只记告警。agy 1.5.13 通过 `thought_level` 设置强度，可填 `low`、`medium`、`high`、`xhigh`。上例会在新建和重连时先选模型，再设置并核对一次 `high`；模型不提供该档时只告警。插件会自动使用 Codex 已有的用户级模型设置，或在未设置时验证 Codex 唯一明确公布的默认模型。没有可用默认时会明确提示，不会猜一个模型。

### 让模型在多个后端中选择

要用 kiro 作为默认后端、Codex 作为备选，在同一处使用下面这份配置。顶层 `command` 和 `args` 定义名为 `default` 的传统后端，`defaultBackend` 选择新会话的默认项。把 `model` 换成你账号在 Codex `model/list` 中可用的 ID。

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    command: kiro-cli
    args: [acp]
    defaultBackend: default # 只用 Codex 时改为 codex
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

`acp_backend_status` 只读查询检测结果，不启动 CLI。新会话按以下顺序选后端：

1. 调用 `acp_chat_start` 显式传入 `backend`，优先使用该后端。
2. 否则使用配置中的 `defaultBackend`；该后端不可用时会报错，不会悄悄换后端。
3. 否则，使用顶层配置的 `default`。开启发现时，只有 DSH 明确找不到顶层配置的 `kiro-cli`（包括指定路径），才依次选择版本在范围内且已就绪的 Codex、`agy`。「找不到」以 DSH 宿主的可执行文件查找结果为准：宿主会把「文件没有执行权限」「同名的是目录」「PATH 中的目录不可读」也报告为找不到，所以这几种情况同样会改派（无执行权限的 Kiro 本来也起不来）；查找超时等其他错误不算找不到。从 macOS Dock 启动的 DSH 常常读不到 shell 里的 `PATH`（例如不含 `~/.local/bin`），装了 Kiro 也可能被判为找不到；改派时 `acp_chat_start` 的回执会写明。找得到 Kiro 就按原来的参数与权限尝试连接；连接失败会报错，不改派。找不到 Kiro 且没有合格的候选时，仍尝试原命令，返回找不到命令的指引。关闭发现或使用自定义包装命令时，保留原来的 `default` 路由。

显式配置的后端（包括自定义命令和包装脚本）即使版本未知或超出范围，也会告警并按原配置尝试连接，不保证兼容。Kiro V3 的 3.6.x 已纳入验证范围，3.7.x 仍待验证；若面板把 3.6.x 提示为范围外，先升级本插件并重新检测。对**自动发现**的范围外 CLI，可设 `allowUnverifiedBackends: true`，再通过 `backend` 手动选择，或用 `defaultBackend` 固定它；该开关不会把它加入自动回退顺序。检查结果和单次启动失败不会撤掉工具或阻断旧 `chatId` 的发送与重连；旧会话始终按原绑定续聊。

设置 `discoverBackends: false` 可关闭额外的 PATH 探测和自动接入，不影响显式配置的后端。自动接入的后端不继承其他后端的显式凭据或权限；Codex 使用 `read-only` 沙箱、`never` 审批策略并拒绝 ACP 权限请求，`agy` 也默认拒绝 ACP 权限请求。如需覆盖路径、模型、环境或权限，请配置命名后端。

Codex 的 `effort` 设置每轮推理强度，`sandbox` 可选 `read-only`（默认）、`workspace-write` 或 `danger-full-access`。`approvalPolicy` 决定 Codex 何时请求审批，各后端的 `permission` 决定如何答复，可选 `allow` 自动允许、`reject` 拒绝或 `ask` 逐次询问。自带配置为默认后端设置了 `allow`，命名后端省略此字段时使用 `reject`。

## 快速上手

在有工作目录的 DSH 会话里，依次发两条消息。等第一轮回答后再发第二条：

1. “请用 ACP 子代理阅读当前项目的 README，指出新用户最容易卡住的一步。”
2. “请让刚才那个子代理针对这一步写一段更清楚的说明。”

第一条消息会让模型用 `acp_chat_start` 建立会话，拿到 `chatId` 后用 `acp_chat_send` 派任务。第二条消息复用同一个 `chatId`。打开右侧栏的 **ACP 会话**，点进对应条目，就能看到同一会话里的两轮问答。

### 在面板里跟进任务

- **核对模型与思考强度。** 展开「后端状态」可看 Codex 无会话检测报告的默认值，或 Kiro、agy 最近一个活跃会话报告的值和时间。与插件配置不同时并列显示两者，缺少报告的字段显示「未报告」。
- **看进度。** 列表显示当前 DSH 会话创建的子代理会话。旋转圆环表示运行中，旁边显示已用时长。绿点表示最近一轮正常完成，红点表示出错或重连失败，橙点提示已换用新会话。灰色实点表示空闲，灰色空心点表示进程已释放。点开条目可读每轮问答和重连记录。
- **释放或删除。** 释放会保留记录，下次发送时自动重连。若子代理正忙，面板会先请你确认，因为释放会中止当前轮。删除会同时清除本地会话记录和轮次日志。
- **看 Codex 额度。** 面板顶部显示各 Codex 后端可读取的最紧限额窗口的剩余百分比，悬停可看窗口长度和重置时间。成功结果缓存 5 分钟。
- **关闭功能后。** `workflow: false` 时，打开工作流区块只读一次历史，随后停止轮询；`enableChatTools: false` 时，列表和详情页显示「持久会话已关闭」。

## 进阶使用

### ACP Dispatcher 模式

启用 bundle 并重启 DSH，在**新会话的模式菜单**选择 **ACP Dispatcher**。默认配置下，主 Agent 可用 ACP 工具派工、用 web 轻量查证、用 jobs 跟踪任务；它没有 bash 或文件工具，命令执行和文件操作都通过 `acp_chat_send` 派给子代理。任务完成后，主 Agent 收到通知，用 `job_output` 取回结果。适合在一个窗口并行分工、让两个引擎交叉审核，或跟进耗时任务；标准模式同样能用 ACP 工具（D26）。

**选择主 Agent 可用的工具。** 编辑 `~/.dsh/profiles/<name>/cordis.patch.yml`，其中 `<name>` 与安装时的 `--profile <name>` 相同。下面两个工具配置示例是同一条覆盖的两种写法，选用其中一种即可。它位于文件**顶层**，与 `- id: subagent-acp-resume` 并列：`- id:` 顶格，`name:` 和 `config:` 缩进两格，`dispatcherTools:` 缩进四格，各开关缩进六格。

在默认组合上开启只读文件，让主 Agent 核对文件并加载 skill：

```yaml
- id: acp-dispatcher-settings
  name: dsh-acp-resume/dispatcher-preset
  config:
    dispatcherTools:
      readOnlyFs: true
```

如果还要关闭任务清单，把这两项写在同一个 `dispatcherTools` 下。未写的字段使用默认值，无需列全六项：

```yaml
- id: acp-dispatcher-settings
  name: dsh-acp-resume/dispatcher-preset
  config:
    dispatcherTools:
      readOnlyFs: true
      todo: false
```

| `dispatcherTools` 字段 | 默认值 | 控制的能力 |
|---|---|---|
| `readOnlyFs` | `false` | 读取、搜索文件，并发现和加载 skill。保持图片读取、写入、编辑、补丁关闭。 |
| `web` | `true` | 轻量联网查证（含 fetch）。 |
| `present` | `true` | 展示交付物。 |
| `todo` | `true` | 维护任务清单。 |
| `askUser` | `true` | 用工具向用户澄清问题。关闭后仍可在对话中提问。 |
| `compaction` | `true` | 整组启用上下文压缩、手动压缩命令与工具结果裁剪。 |

0.5.1 的 `dispatcherTools.skill` 已弃用。需要文件核对与技能读取时使用 `readOnlyFs: true`。

在 profile 里改完 Dispatcher 配置后，需要重启 DSH 以重新读取配置。在新会话中选择 ACP Dispatcher，新绑定的 Agent 会使用新工具组合及对应的模式说明和 persona。如果仅在运行中的宿主内重载声明，当前进程中已绑定的 Agent 保留原组合，ACP 会话池也继续运行。

这六项开关保留了纯派工的边界：主 Agent 通过 ACP 把执行工作交给 Worker。bash、文件写入与编辑、DSH 内置子代理委派工具都不在开关范围内；开放这些执行入口后，与标准模式的区别就只剩提示词约定。需要这些工具的配置可采用下文的完整自定义声明。

**自定义调度规则。** 下面仍是 profile 的 `cordis.patch.yml` 顶层条目。如果已配置工具开关，将 `dispatcherPrompt` 写在同一条目的 `config` 下，与 `dispatcherTools` 并列。

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

默认保留自带 persona；填写 `extraRules` 会将整段文字追加在结果汇总规则之后。设为 `overrideRules: true` 时必须提供非空文字，它替换后端派工流程、目标目录确认、共享目录写入边界和结果汇总规则，保留调度者身份和按工具开关生成的指引；模式菜单说明仍只随工具开关变化。

**从旧的 `preset-acp-dispatcher` 行迁移。** 原先没有覆盖这行的用户无需改配置。用过旧行覆盖的用户，请删除旧覆盖；如果只是增加了只读文件工具，换成第一个示例即可。rc.5 遇到找不到的旧行会记录 `patch: entry "preset-acp-dispatcher" not found` 并跳过这条覆盖，profile 继续加载。忽略这条警告会使旧定制失效。原先禁用旧行的用户改为对 `acp-dispatcher-settings` 设置 `disabled: true`。

如需完全自定义 persona（包括身份和工具指引）或添加额外插件，在同一次 profile 修改中对新行设置 `disabled: true`，再用顶层 `- insert:` 插入自己完整的 `@deepseek-ai/dsh-agent-preset` 声明。可将原行连同完整 `config` 移入 insert 列表，保留 `config.id: acp-dispatcher`。这样只有一个有效声明者，已有会话引用的 preset id 仍可解析。完成迁移后重启 DSH，在新会话选择 ACP Dispatcher。

### ACP Workflow · 按工作区模板派工

按角色派工默认开启（`roles: true`）。在工作区根目录的 `.agents/acp-team.yml` 定义角色后，`acp_chat_send` 即可用 `role` 指名派工。`workflow` 默认是 `false`，只控制模板工具 `acp_workflow`；`roles: false` 与 `workflow: true` 同时配置会在加载时报错。

要运行下面的模板，请在插件的顶层 `config` 中设置 `workflow: true`，重启 DSH，并将示例保存为工作区的 `.agents/acp-team.yml`。两位审核员用默认后端独立审查，最后把结果交给主模型。要让某个角色改用已配置的 Codex，可在蓝图中添加 `backend: codex`。[更多模板，包括由编辑角色汇总的示例](docs/acp-team.example.yml)

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

**运行。** 在主对话里说“用 `dual_review` 审核 `src/pool.ts`”，模型会调用 `acp_workflow({ template: "dual_review", params: { target: "src/pool.ts" } })`。本会话首次用到某角色时，插件按蓝图建 chat、先发 `seeding` 交代职责，再登记到花名册并派发审核任务。对话中的进度卡片显示各步骤和成员状态，侧栏**工作流**区块可查看当前步骤及最近五次结束的运行。

| 对象 | 作用域 | 记录什么 |
| --- | --- | --- |
| 流程模板 `templates` | 工作区，同一工作区的会话共享 | 角色怎么协作，包括步骤顺序、并行成员和合并方式。 |
| 角色蓝图 `roles` | 工作区，同一工作区的会话共享 | 角色是谁，包括后端 `backend`、工作目录 `cwd` 和首次派工前发送的 `seeding`。 |
| 花名册实例（roster） | DSH 主会话，每个会话独立 | 插件按 `ownerSessionId` 记录本会话的角色名与 `chatId` 的绑定。 |

蓝图中的 `summary` 是可选的一句话分工说明。角色首次建会话且配置了 `seeding` 时，Worker 先收到自己的角色名、队友及其分工，再收到自己的职责指令；省略 `seeding` 就直接接收首个任务。主模型可用 `acp_team_list` 查看各角色的分工，以及在当前会话中是未建、空闲还是运行中。

例如，同一工作区的主会话 1 和 2 都运行 `dual_review`，读取同一份模板和角色蓝图。审核员 A（`reviewerA`）在两份花名册中绑定的是两个不同的 chat；在会话 1 用 `acp_chat_send` 指定 `role: reviewerA` 追问，只会续上会话 1 的审核。修改蓝图后，可在当前会话用 `acp_chat_close` 按角色解除绑定，下次派工时按新蓝图创建（D27）。

## 参考

### 模型工具

| 工具 | 何时使用 |
| --- | --- |
| `acp_backend_status` | 只读查询支持范围、就绪状态、新会话默认项和建议，不启动外部进程。 |
| `acp_backend_usage` | 显式配置了 `protocol: codex` 的后端时注册。只读查询套餐、已用比例和重置时间，可用 `refresh: true` 强制刷新。 |
| `acp_chat_start` | 建立持久会话，返回 `chatId`。配置多个后端后可指定 `backend`。 |
| `acp_chat_send` | 开始下一轮，自动按需重连。同一会话一次只执行一轮，忙时再次发送会报错。 |
| `acp_chat_list` | 找回当前 DSH 会话创建的子代理，包括已释放的会话。 |
| `acp_chat_steer` | 给正在执行的一轮补充指令。后端不支持插话时会返回提示。 |
| `acp_chat_close` | 释放进程以便稍后重连，或用 `purge` 删除本地记录。kiro 远端记录可用 `kiro-cli chat --list-sessions` 查看，用 `--delete-session` 清理。 |
| `acp_team_list` | 只读查看工作区角色的 summary 与本会话中的状态。`roles: false` 时不注册。 |
| `acp_workflow` | 开启 `workflow` 后，按模板名和参数执行多角色工作流。 |

**后台任务。** 宿主同时装有 `dsh-jobs-local` 和 `dsh-tool-jobs` 时，发送和工作流会立即返回 `jobId`。模型收到完成通知后用 `job_output` 读取结果，运行中可用 `job_kill` 停止。默认拦截对运行中 ACP 任务的阻塞等待。没有 jobs 服务时同步返回结果，仅有任务注册表而缺少控制器时会报错（D17、D22）。

**会话恢复。** 插件默认在空闲 10 分钟后释放进程。远端会话明确丢失、后端未声明加载能力，或同一池实例中该会话连续三轮出错后再次发送时，会新开会话并提示补充上下文。原因不明的加载失败会保留原绑定并报错。注册表默认位于 `$DSH_HOME/storages/acp-resume/registry.json`，旁边的 `turns/<chatId>.jsonl` 以明文保存最近 200 条轮次记录。[恢复与日志决策（D6、D18）](DECISIONS.md)

**开发与验证。** 运行 `pnpm install`、`pnpm build`、`pnpm test`。缺少官方源码 checkout 时，24 个真实子进程用例会按 D8 跳过。kiro 已验证进程终止后恢复上下文，完整真机冒烟流程仍待走完。Codex 适配已通过 mock 回归，真机联调仍待验证。[架构设计](DESIGN.md) · [验收进度](IMPLEMENTATION-PLAN.md) · [MIT 许可证](LICENSE)

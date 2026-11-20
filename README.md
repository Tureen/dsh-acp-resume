# dsh-acp-resume

[English](README.en.md)

## 为什么需要这个插件

### Resume · 让同一个子代理记得上轮工作

DeepSeek Harness（DSH）官方的 ACP 后端采用一次性委派，每次都从新会话开始，追问上轮审核的第二条发现也得重新交代背景。Resume 保留同一个子代理会话，你只需说“再查一下第二条”，它就能沿用读过的代码、找到的证据和之前的判断。插件可与官方后端并用，持久会话池会复用进程并保存远端会话号，进程退出或空闲释放后，下次发送仍会尝试恢复原会话。

### ACP Dispatcher · 在一个对话窗口调度多个子代理

插件让所有模式都能使用 ACP 工具，ACP Dispatcher 则是可选的纯派工预设。在这个模式下，主 Agent 没有 bash 和文件操作工具，它在一个对话窗口里拆任务、分派给各个 ACP 会话执行，再收回结果。你可以让 kiro 写代码，同时让 Codex 推演边界条件，也可以让两个引擎独立核查同一结论，或把长任务交给子代理，在原窗口跟进。

### ACP Workflow · 把反复使用的协作步骤写成模板

如果每次审核都需要两人独立检查、再由一人汇总，可以在工作区的 `.agents/acp-team.yml` 里写好角色蓝图和流程模板。启用工作流后，模型只需调用一次 `acp_workflow`，执行器就按模板先让两个审核角色并行检查，再把结果交给汇总角色。下次审核可复用同一模板，步骤顺序、并行分工和合并方式都由配置确定，模型无需临场记住并派发每一步。

## 安装

需要 DSH `>=0.2.2-rc.3`、Node.js 24 或更高版本。使用默认后端时，请先安装 `kiro-cli`，确保 DSH 能在 `PATH` 中找到它。

从 npm 安装到你的 DSH profile，将 `<name>` 换成实际名称，安装后重启 DSH：

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

升级时在包名后追加 `@<版本>`。如果刚发布的版本被 `minimumReleaseAge` 过滤，也可以这样指定版本安装。桌面 App 可从 Discover 安装，离线环境可从本地 tgz 安装。[市场详情与安装步骤](docs/detail.zh.md#安装)

> ⚠️ **不要从 GitHub 地址安装。** 仓库不含构建产物，也没有安装时编译的 `prepare` 脚本，直接安装会因缺少 `lib/index.js` 加载失败。

## 快速上手

在有工作目录的 DSH 会话里，依次发两条消息。等第一轮回答后再发第二条：

1. “请用 ACP 子代理阅读当前项目的 README，指出新用户最容易卡住的一步。”
2. “请让刚才那个子代理针对这一步写一段更清楚的说明。”

第一条消息会让模型用 `acp_chat_start` 建立会话，拿到 `chatId` 后用 `acp_chat_send` 派任务。第二条消息复用同一个 `chatId`。打开右侧栏的 **ACP 会话**，点进对应条目，就能看到同一会话里的两轮问答。

### 在面板里跟进任务

- **看进度。** 列表显示当前 DSH 会话创建的子代理会话。旋转圆环表示运行中，旁边显示已用时长。绿点表示最近一轮正常完成，红点表示出错或重连失败，橙点提示已换用新会话。灰色实点表示空闲，灰色空心点表示进程已释放。点开条目可读每轮问答和重连记录。
- **释放或删除。** 释放会保留记录，下次发送时自动重连。若子代理正忙，面板会先请你确认，因为释放会中止当前轮。删除会同时清除本地会话记录和轮次日志。
- **看 Codex 额度。** 配置 Codex 后，面板顶部会显示各 Codex 后端在最紧限额窗口中的剩余百分比，悬停可看窗口和重置时间。模型也可用只读工具 `acp_backend_usage` 查询套餐、已用比例和重置时间。成功结果缓存 5 分钟，`refresh: true` 可强制刷新（D28）。

## 进阶使用

### 配置

安装后，bundle 已配置默认命令 `kiro-cli acp`。需要固定模型、增加后端或启用工作流时，在该 profile 的 `cordis.patch.yml` 写**顶层同 id 覆盖**。下面的示例保留默认 kiro，另加一个可在建会话时通过 `backend: codex` 选择的后端。将模型名换成你账号的 `model/list` 返回值。

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

顶层 `command`、`args` 和模型设置用于默认后端，`backends` 下的命名后端可各自选用模型和权限。bundle 已启用时再次 `insert` 会触发 `DUPLICATE_PROVIDER`。关闭 bundle 后才需要手动挂载，格式见[自带配置](cordis.patch.yml)。

#### 后端支持等级

| 后端 | 会话恢复与插话 | 如何选模型和推理强度 |
| --- | --- | --- |
| **kiro-cli**（默认 v3） | 通过 `session/load` 恢复，支持在当前轮插话 | 默认由服务端选模型。v3 指定模型时同时设置 `modelSelect: session` 和 `model`，省略 `effort`。v2 支持 `--model`、`--effort` 命令行参数。 |
| **Antigravity**（`agy acp`） | 通过 `session/load` 恢复，已实测进程被终止后续聊 | 设置 `agentEngine: none`。指定模型用 `modelSelect: session` 和 `model`。推理强度包含在模型 ID 中，省略 `effort`。 |
| **Codex**（仅命名后端） | 通过私有 `app-server` 协议接入，用 `thread/resume` 恢复，支持原生 `turn/steer` 插话 | 必填 `model`，可按模型设置每轮的 `effort`。`sandbox` 默认为 `read-only`，也可选 `workspace-write`、`danger-full-access`。 |

其他标准 ACP CLI 可通过 `command` 和 `args` 接入；若不接受 kiro 的 `--agent-engine` 参数，设置 `agentEngine: none`。能否跨进程续聊取决于后端的 `loadSession` 能力，插话也需要后端支持。

**权限。** `permission: allow` 自动选择允许项，`reject` 拒绝请求，`ask` 将请求交给宿主用户逐次确认。自带的 kiro 配置使用 `allow`，手动配置后端时省略该字段则默认为 `reject`。Codex 的 `approvalPolicy` 控制何时发起审批，`permission` 决定如何答复；`ask` 无法取得有效确认时，ACP 请求会被拒绝，Codex 会取消整轮。

### 按角色派工，把重复任务写成模板

开启 `workflow: true` 后，在工作区根目录放一份 `.agents/acp-team.yml`。其中 `roles` 定义角色名、后端、工作目录和首次创建时发送的职责说明，`templates` 定义这些角色如何协作。[可直接复制的工作区示例](docs/acp-team.example.yml)

以示例中的双人审核为例，你可以说：“用 `dual_review` 审核 `src/pool.ts`，重点看并发和资源释放。”模型调用 `acp_workflow` 后，两个审核角色会并行阅读目标文件，随后由编辑角色汇总。模板也可以把结果交回主模型。面板的**工作流**区块显示当前步骤和最近五次结束的运行，展开步骤可进入成员会话。

临时追问某位审核者时，用 `acp_chat_send` 指定 `role: reviewer` 即可。首次派工会按蓝图自动建会话、发送职责说明并登记到花名册，以后复用该角色的会话。每个 DSH 会话都有自己的花名册。修改蓝图后，可用 `acp_chat_close` 按角色解除绑定，下次派工会采用新蓝图（D27）。

### ACP Dispatcher 模式

如果希望主模型专注派工，在**新会话的模式菜单**选择 **ACP Dispatcher**。这个可选 preset 让主模型拆分任务、分派给子代理、跟踪进度并汇总结果。主模型保留任务管理和轻量联网查询，命令执行和文件操作交给子代理。标准模式也可以使用会话工具和已启用的工作流（D26）。

## 参考

### 模型工具

| 工具 | 何时使用 |
| --- | --- |
| `acp_chat_start` | 建立持久会话，返回 `chatId`。配置多个后端后可指定 `backend`。 |
| `acp_chat_send` | 开始下一轮，自动按需重连。同一会话一次只执行一轮，忙时再次发送会报错。 |
| `acp_chat_list` | 找回当前 DSH 会话创建的子代理，包括已释放的会话。 |
| `acp_chat_steer` | 给正在执行的一轮补充指令。后端不支持插话时会返回提示。 |
| `acp_chat_close` | 释放进程以便稍后重连，或用 `purge` 删除本地记录。kiro 远端记录可用 `kiro-cli chat --list-sessions` 查看，用 `--delete-session` 清理。 |
| `acp_workflow` | 开启 `workflow` 后，按模板名和参数执行多角色工作流。 |

**后台任务。** 宿主同时装有 `dsh-jobs-local` 和 `dsh-tool-jobs` 时，发送和工作流会立即返回 `jobId`。模型收到完成通知后用 `job_output` 读取结果，运行中可用 `job_kill` 停止。默认拦截对运行中 ACP 任务的阻塞等待。没有 jobs 服务时同步返回结果，仅有任务注册表而缺少控制器时会报错（D17、D22）。

**会话恢复。** 插件默认在空闲 10 分钟后释放进程。远端会话明确丢失、后端未声明加载能力，或同一池实例中该会话连续三轮出错后再次发送时，会新开会话并提示补充上下文。原因不明的加载失败会保留原绑定并报错。注册表默认位于 `$DSH_HOME/storages/acp-resume/registry.json`，旁边的 `turns/<chatId>.jsonl` 以明文保存最近 200 条轮次记录。[恢复与日志决策（D6、D18）](DECISIONS.md)

**开发与验证。** 运行 `pnpm install`、`pnpm build`、`pnpm test`。缺少官方源码 checkout 时，24 个真实子进程用例会按 D8 跳过。kiro 已验证进程终止后恢复上下文，完整真机冒烟流程仍待走完。Codex 适配已通过 mock 回归，真机联调仍待验证。[架构设计](DESIGN.md) · [验收进度](IMPLEMENTATION-PLAN.md) · [MIT 许可证](LICENSE)

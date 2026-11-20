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

## 选择后端

<a id="配置"></a><a id="后端支持等级"></a>

| 后端 | 支持能力 |
| --- | --- |
| **kiro-cli**（默认） | 自带配置使用 `kiro-cli acp` 和 v3 引擎，支持跨进程恢复会话和在当前轮插话。 |
| **Antigravity**（agy） | 通过 `agy acp` 接入，支持恢复会话和按会话选择模型，推理强度由模型 ID 决定。 |
| **Codex** | 通过私有 `codex app-server` 协议恢复会话、插话并逐项审批，只能配置为命名后端。 |

### 只用一个后端

使用 kiro 时，确保 DSH 能从 `PATH` 找到 `kiro-cli`，即可直接快速上手。要换成 agy，在 profile 的 `cordis.patch.yml` 中按同一插件 id 覆盖顶层 `command` 和 `args`，并设 `agentEngine: none` 关闭 kiro 专用的启动参数：

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    command: agy
    args: [acp]
    agentEngine: none
```

重启 DSH 后，模型新建会话时就会使用 agy。要固定模型，kiro v3 和 agy 都需同时设置 `modelSelect: session` 和 `model`，并省略 `effort`。只使用 Codex 时也需按下节将其注册为命名后端，建会话时指定 `backend: codex`。

### 让模型在多个后端中选择

要用 kiro 作为默认后端、Codex 作为备选，在同一处使用下面这份配置。顶层字段定义默认后端，`backends` 下的键是模型可选择的名称。把 `model` 换成你账号在 Codex `model/list` 中可用的 ID。

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    command: kiro-cli
    args: [acp]
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

重启 DSH 后，`acp_chat_start` 会列出可选后端。模型传入工作目录的绝对路径 `cwd`，省略 `backend` 即用 kiro，指定 `backend: codex` 即用 Codex。侧栏徽标显示每个会话的后端；之后用同一个 `chatId` 续聊即可。

Codex 的 `effort` 设置每轮推理强度，`sandbox` 可选 `read-only`（默认）、`workspace-write` 或 `danger-full-access`。`approvalPolicy` 决定 Codex 何时请求审批，各后端的 `permission` 决定如何答复，可选 `allow` 自动允许、`reject` 拒绝或 `ask` 逐次询问。自带配置为默认后端设置了 `allow`，命名后端省略此字段时使用 `reject`。

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

### ACP Dispatcher 模式

启用 bundle 并重启 DSH，在**新会话的模式菜单**选择 **ACP Dispatcher**。主 Agent 可用 ACP 工具派工、用 web 轻量查证、用 jobs 跟踪任务；它没有 bash 或文件工具，命令执行和文件操作都通过 `acp_chat_send` 派给子代理。任务完成后，主 Agent 收到通知，用 `job_output` 取回结果。适合在一个窗口并行分工、让两个引擎交叉审核，或跟进耗时任务；标准模式同样能用 ACP 工具（D26）。

### ACP Workflow · 按工作区模板派工

在插件的顶层 `config` 中设置 `workflow: true` 并重启 DSH，再将以下内容保存为工作区根目录下的 `.agents/acp-team.yml`。两位审核员使用默认后端、各自独立审查，最后把结果交给主模型。要让某个角色改用已配置的 Codex，可在它的蓝图中添加 `backend: codex`。[更多模板，包括由编辑角色汇总的示例](docs/acp-team.example.yml)

```yaml
roles:
  - { name: reviewerA, cwd: ., seeding: "Review for correctness." }
  - { name: reviewerB, cwd: ., seeding: "Review for maintainability." }
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

例如，同一工作区的主会话 1 和 2 都运行 `dual_review`，读取同一份模板和角色蓝图。审核员 A（`reviewerA`）在两份花名册中绑定的是两个不同的 chat；在会话 1 用 `acp_chat_send` 指定 `role: reviewerA` 追问，只会续上会话 1 的审核。修改蓝图后，可在当前会话用 `acp_chat_close` 按角色解除绑定，下次派工时按新蓝图创建（D27）。

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

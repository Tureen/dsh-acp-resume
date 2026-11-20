[English](README.en.md)

# dsh-acp-resume

A resumable ACP subagent backend for DeepSeek Harness (DSH): a sibling of the official `@deepseek-ai/dsh-subagent-acp` that keeps an external ACP agent alive across turns and reconnects through `session/load` after the process exits. It uses standard ACP methods with first-class private-protocol adaptations for kiro-cli and agy / Antigravity; other ACP agents use the generic compatibility path. Set `command` to use another ACP agent, and set `agentEngine: none` if it does not accept kiro's `--agent-engine` flag. Install with `dsh plugin --profile <name> add dsh-acp-resume` (requires DSH `>=0.2.2-rc.3`, Node >= 24). The documentation below is in Chinese; a full English version is in [README.en.md](README.en.md).

DeepSeek Harness 的**可续聊 ACP 子代理后端**:官方 `@deepseek-ai/dsh-subagent-acp` 的独立兄弟包。在完整保留官方一次性(one-shot)委派行为的基础上,新增**持久会话池**——进程保活、远端会话号落盘、进程死后经 `session/load` 重连,让模型可以与同一个外部 ACP agent 持续多轮协作。用的是标准 ACP 方法，提供对 kiro-cli 与 agy / Antigravity 的一等私有协议定制，并把 Codex 作为第三个一等后端接入其私有 app-server 协议；其他 ACP agent 走通用兼容路径。通过 Config 的 `command` 可指向其他 ACP agent,`agentEngine: none` 可关闭对 `--agent-engine`(kiro 的引擎旗标)的追加,以适配不认该旗标的 agent。

状态:0.3.0。连接原语、会话池、五个工具、持久会话面板与接线均已实现,支持 kiro / agy / Codex 三个一等后端(多后端),并自带可选的 ACP Dispatcher 模式(纯派工,见下文「ACP Dispatcher 模式」);`pnpm test` 465 例全绿。

**已知限制与后续计划**:完整的真机 kiro-cli 冒烟剧本(建会话 → 两轮 → 杀进程 → 重连记得上文 → 空闲释放 → 再连)尚未全部走完,其间行为由 mock 服务器覆盖；agy 的协议直连、多轮与 SIGKILL 后 `session/load` 已实测；Codex 后端目前只经 mock 验证,真机探针待做。Other 通用 ACP 后端仍需按其能力自行验证。进度见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 动机

官方 ACP 后端每次委派启动新进程、单轮执行、结束即销毁——远端会话虽在对方侧落盘(kiro 实测 `session/load` 可用),但永不复用。本包补上这一层:

- 外部 agent 的会话号持久化在 `$DSH_HOME/storages/acp-resume/registry.json`;每个会话的轮次记录(消息与回答文本,明文)另存于同目录 `turns/<chatId>.jsonl`,最近 200 条,供面板详情页查看,删除会话时一并删除;
- 会话进程空闲保活(超时释放,会话记录保留);
- 下次对话自动重连:重新 spawn → `initialize` → `session/load(原会话号 + 原 cwd)` → 继续;远端在协议层拒绝 load 且能明确认出「会话不存在」(报错含 session not found / no rollout 等,或 agent 未声明 loadSession 能力)时降级为新会话;原因不明的 load 拒绝(内部错误、需认证、限流等)保留原绑定、本次报错。若当前池实例同一 chat 连续 3 轮 `error`,下一次 send 也会跳过 load 新开会话,并以前置短语 `remote session failed repeatedly, started fresh` 明确告知;该计数只在内存中保存,应用重启后重新累计。其余失败本次报错、会话记录不动(D6)。

## 架构(与官方完全隔离并存)

```
                    ┌ one-shot provider(注册名 acp-resume,行为与官方 subagent-acp 一致)
本插件 ─────────────┤
                    └ 持久会话池 + 模型工具(注册到 ctx.tools,不经 ctx.subagents)
```

官方包与现有 kiro 链路零接触;设计依据与全部决策见 [DESIGN.md](DESIGN.md) 与 [DECISIONS.md](DECISIONS.md)。

## 模型工具(阶段二交付)

| 工具 | 用途 |
|---|---|
| `acp_chat_start` | 建立持久会话,返回会话句柄 chatId |
| `acp_chat_send` | 向指定会话发消息;进程死后自动重连恢复上下文。宿主装有 jobs 服务时立即返回后台任务 id,回答流式写入该任务;不要对它 `wait` 硬等(运行中的会被拒绝),完成后会话内通知唤醒,再用不带 `wait` 的 `job_output` 读,`job_kill` 停(D22);无 jobs 服务时等待并返回最终回答(D17) |
| `acp_chat_list` | 仅列出当前 DSH 会话创建的活跃与持久化会话；旧记录和其他会话创建的 chat 不会被发现，但知道 chatId 仍可操作 |
| `acp_chat_close` | 释放会话进程(记录保留,可再连;`purge` 同时删记录) |
| `acp_chat_steer` | 给**在途轮**插话:排队的消息在下一个工具/消息边界生效,不打断当前步;要立即停止用 `job_kill` / `acp_chat_close`。没有在途轮时报错(改用 send);agent 不实现私有扩展 `_session/steer` 时报「当前 agent 不支持插话」(D19) |
| **持久会话面板**(右侧栏,D15/D18) | 按会话聚合的视图:状态/轮数/摘要,进行中轮的已发送消息与持续时长,释放与删除;点卡片打开该会话的详情页签(元信息 + 进行中轮 + 每轮问答、结局、重连事件)——见 [PANEL-DESIGN.md](PANEL-DESIGN.md) |

## 配置

挂载方式二选一(见下节「安装与升级」):启用 bundle 时,在 profile 的 `cordis.patch.yml` 写**顶层**同 id 覆盖;不启用 bundle 时用 `- insert:` 手动接线。下例为手动接线,字段全集:

```yaml
- insert:
    - id: subagent-acp-resume
      name: 'dsh-acp-resume'
      config:
        command: /path/to/agent-cli  # 必填:子 agent 可执行文件
        args: [acp]                  # 默认 []
        agentEngine: v3              # 默认 v3;可选 v1 / v2 / v3 / none。启动子进程时追加 --agent-engine <值>;args 里已写该旗标则以 args 为准、不再追加;none = 完全不追加,供不认该旗标的 agent 使用(D19)
        model: glm-5                 # 追加 --model <id>;仅接受该 CLI 旗标的 agent 有效(kiro v2 引擎);kiro v3 与 agy 不接受,请改用 modelSelect: session
        effort: high                 # 追加 --effort <档>;仅接受该 CLI 旗标的 agent 有效(kiro v2 引擎);kiro v3 与 agy 不接受,不要设置
        modelSelect: flag            # 默认 flag(model 走 --model 旗标);session = 不追加旗标，会话建立后经 session/set_model(失败降级 set_config_option)切到 model,kiro v3 与 agy 用这个
        providerName: acp-resume     # 默认 acp-resume;不与官方 acp 冲突
        permission: allow            # bundle 默认自动选择允许项;也可用 reject 或 ask(见下文)
        env: {}                      # 叠加到清洗后父环境之上的变量(如子 agent 自己的 key)
        enableChatTools: true        # 默认 true;false 时只注册 one-shot provider
        toolPrefix: acp_chat_        # 默认 acp_chat_;五个工具名的前缀
        allowChatJobWait: false      # 默认 false;false 时拒绝对运行中 acp-chat 任务的 job_output wait:true(D22),true 则放开
        workflow: false              # 默认 false,需显式开启;工作区角色与工作流(D27):send/close 可用 role 代替 chatId,首次引用按 .agents/acp-team.yml 自动建会话;false 时工具定义与 D27 前一致
        idleTimeoutMs: 600000        # 默认 600000;空闲多久释放进程
        disposeEofGraceMs: 6000      # 默认 6000;关 stdin 后等子进程自行收尾的时间
        disposeGraceMs: 3000         # 默认 3000;观察失败/升级信号的宽限,也是 close 等在途轮结算的上限
        registryPath: ''             # 默认空串 = $DSH_HOME/storages/acp-resume/registry.json;自定义时必须是绝对路径
        backends:                    # 可选命名后端；完整配方见下方“后端支持等级”
```

`agentEngine` 对一次性 provider 与持久会话两条路径都生效。默认 `v3` 会给子进程追加 `--agent-engine v3`,这是 kiro-cli 的引擎选择旗标;换用其他 ACP agent 时,若它不认该旗标(多数会因未知参数退出),把 `agentEngine` 设为 `none` 即不再追加。`none` 只影响追加:你在 `args` 里自己写的 `--agent-engine` 照常原样传给子进程。重连旧会话时指纹校验忽略该旗标,所以换引擎不会让旧会话被拒;新引擎读不了旧会话时按原规则降级为新会话。

**permission 策略。** `allow` 自动选择第一个 `allow_once` 或 `allow_always` 选项。`reject` 是 schema 兜底默认值，拒绝每一项请求。`ask` 将每次请求转发给宿主的用户确认界面，并等待用户选择；服务、回答者或有效回答不可用时会拒绝请求。自带 `cordis.patch.yml` 为 kiro-cli 设为 `permission: allow`。手动用 `- insert:` 接线时省略该字段则使用保守的 `reject` 默认值。

### 新手配方

以下都是 bundle 已启用时写进 profile 的**顶层同 id 覆盖**。不要再添加第二个 `- insert:`。

**使用默认 kiro-cli。** 无需覆盖：只要已安装 `kiro-cli` 且它在 `PATH` 中，自带配置已使用 `command: kiro-cli` 与 `args: [acp]`。

**使用指定路径的 kiro-cli。** `kiro-cli` 安装在 `PATH` 之外时，覆盖它的绝对路径：

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/kiro-cli
    args: [acp]
```

**换用其他 ACP agent，并逐次询问权限。** 覆盖可执行文件和参数；该 agent 不认 kiro 的引擎旗标时关闭追加，并把权限请求转给宿主用户确认界面：

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/other-acp-agent
    args: [acp]
    agentEngine: 'none'
    permission: ask
```

> **兼容性：** `model` 与 `effort` 通过追加 `--model` / `--effort` CLI 旗标实现，**仅对接受这些旗标的 agent 有效**（kiro v2 引擎已验证）。部分 agent（如 agy）与 kiro v3 不接受这些旗标，请勿为其后端直接设置这两个字段，设了会追加被拒绝的旗标，导致启动失败。kiro v3 与 agy 类似，需要 `modelSelect: session` 走会话级方法；直接设 model/effort 会追加 CLI 旗标，v3 拒绝。agy / kiro v3 请设 `modelSelect: session`(默认 `flag`):此时不追加 `--model`,会话建立后(`session/new` / `session/load` 之后)改调 `session/set_model` 切到 `model`;agent 对 `session/set_model` 回 `-32601`(方法不存在)或 `-32603`(kiro v3 的实际返回)时降级调 `session/set_config_option {sessionId, configId: "model", value}`,kiro v3 经 set_config_option 适配(kiro v3 不认 `--model` / `--effort`,参数形态已探针验证)。两者都失败仅告警不阻断连接。

`model` / `effort` 同样对两条路径生效,是 **spawn 级**选择(作用于该子进程启动的会话)。两者缺省时不拼对应旗标,保持 kiro 的 `auto`(服务器按任务动态选模型,`effort` 不可控);设了就把模型/档位钉死。**生效语义**:只对下次启动的进程生效——已在运行的会话进程不受影响,正在续聊的会话要等它空闲释放、下次 `acp_chat_send` 重连(新进程)时才应用新模型。与 `--agent-engine` 一样,指纹校验也忽略 `--model` / `--effort`(理由见 D19):`auto` 本就在会话内按任务换模型,换个钉死的模型不构成"换了一个 agent",旧会话照旧可续。

`allowChatJobWait`(D22):一轮对话常跑十几分钟,模型用 `job_output` 的 `wait: true` 硬等会顶满宿主 600 秒上限,期间用户新消息排队。默认在工具派发前拒绝对**运行中**的 acp-chat 任务的 wait,并告诉模型等完成通知;任务已结算、其他种类任务(如 bash)不受影响。设 `true` 关闭该拦截。

`backends` 可选命名表可让不同 chat 绑定不同 ACP agent；顶层 command/args 等字段始终代表默认后端。配置多个后端时，`acp_chat_start` 可选 `backend` 参数；名称和 description 应使用中性说明，不应标“推荐”或优先级。

### 后端支持等级

#### 一等支持（私有协议定制）

| 后端 | 私有扩展支持 | 特殊配置 |
|---|---|---|
| **kiro-cli**（默认后端） | `_session/steer` 中途插话；`--agent-engine v3` 旗标；`session/load` 跨进程重连；v3 的模型/effort 走会话级 `session/set_config_option`，不走 CLI 旗标 | `agentEngine: v3`（默认，不设即用）。**v3（默认）**：模型选择用 `modelSelect: session` + `model`（经 `session/set_config_option` 切换，探针已验证）；effort 同属会话级配置项（`configId: "effortLevel"`），不是 CLI 旗标。⚠️ 不要在 v3 后端上直接设 `model` / `effort` 而不设 `modelSelect: session`——会追加 v3 不支持的 `--model` / `--effort` 旗标，导致启动失败；v3 上也不要设 `effort` 字段。**v2（遗留）**：支持 `--model` / `--effort` CLI 旗标，但不推荐降级到 v2。远端清理用 `kiro-cli chat --list-sessions` / `--delete-session` |
| **agy / Antigravity** | 协议归一化层自动把平铺 update 归一为嵌套形态；`session/set_model` 按会话切模型；`session/load` 跨进程重连（已实测 SIGKILL 后恢复） | **必须** `agentEngine: 'none'`。选模型用 `modelSelect: session` + `model`（经 `session/set_model` 切换）；⚠ 不设 `modelSelect: session` 时不要设 `model`（会追加 agy 拒绝的 `--model` 旗标，导致启动失败）；任何情况都不要设 `effort`，effort 已内嵌在模型 ID，例如 `gemini-4-carbon-high` 表示 Carbon 模型的 high 档。建议 `permission: ask`，因为权限请求中可能混入“向用户提问”。默认模型为 `gemini-4-carbon-medium`；可用模型含 Gemini 4 全系（Carbon/Argon/Hydrogen）、Claude Sonnet/Opus 4.6、GPT-OSS 120B 等共 18 个。 |
| **Codex**（`protocol: codex`，仅命名后端） | 走 `codex app-server` 私有 JSON-RPC 协议，不说 ACP：原生 `turn/steer` 插话（不打断正在跑的命令）；`thread/resume` 跨进程恢复；`item/*/requestApproval` 分项审批（`permission: ask` 逐次问用户：允许 / 拒绝该步 / 取消整轮） | **必须**设 `model`（Codex 默认模型在部分账号不可用）；可设 `sandbox`（`read-only` 默认 / `workspace-write` / `danger-full-access`）、`approvalPolicy`（`never` 默认 / `untrusted` / `on-request` / `on-failure`）、`effort`（每轮 `turn/start` 的推理档位，完整档位 `low` / `medium` / `high` / `xhigh` / `max` / `ultra`，其中 `ultra` 仅部分模型支持，见下方「模型从哪查」）。`args` 缺省为 `[app-server]`，不追加 `--agent-engine` / `--model` / `--effort`。`reject` 回 decline（该步被拒、整轮继续），`ask` 无确认服务或回答无效时取消整轮。已用 mock 全绿，真机探针待做；私有协议无稳定性承诺，升级 Codex 后需复测。 |

#### 模型从哪查

| 后端 | 查询来源 | effort |
|---|---|---|
| kiro | 模型动态（`auto`）：不设 `model` / `effort` 时由服务端按任务选 | 不设即由服务端决定 |
| agy | `initialize` 响应的 `models.availableModels` | 内嵌在模型 ID（如 `gemini-4-carbon-high`） |
| Codex | `codex app-server` 的 `model/list`（0.170.0 实测清单见下） | 每轮 `turn/start` 传入 |

Codex 0.170.0 实测 `model/list`：默认 `gpt-6.2-sol`；另有 `gpt-6.2-astra`、`gpt-6.1-terra`、`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-reserve`、`codex-auto-review`。所有模型支持 `low` / `medium` / `high` / `xhigh` / `max`；`ultra` 仅 `gpt-6.1-terra`、`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-5.6-sol`、`gpt-5.6-terra` 支持。可用清单随账号与 Codex 版本变化，以你本机的 `model/list` 为准。

#### 通用 ACP 后端（Other）

- 任何实现标准 ACP 协议的 CLI，例如 opencode、gemini-cli。
- **必须**设 `agentEngine: 'none'`。
- model/effort 是否可用取决于该 agent 是否接受对应 CLI 旗标，不保证兼容。
- `acp_chat_steer` 不支持时按标准 `-32601` 降级报错。
- `session/load` 是否可用取决于 agent 是否声明 `loadSession` 能力。
- 协议归一化层会尝试兼容非规范的 update 形态。

### 后端配方

```yaml
# 等级 1：一等支持 — kiro（默认后端；不钉模型时无需任何覆盖）
# kiro v3 + 模型钉死(推荐)
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: kiro-cli
    args: [acp]
    modelSelect: session
    model: claude-opus-5.5     # 经 set_config_option 切换,非 CLI 旗标
    # 注意:不要直接设 model 而不设 modelSelect: session(v3 会拒旗标);v3 上不要设 effort 字段
```

```yaml
# 等级 1：一等支持 — agy
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /Users/<you>/.local/bin/agy
    args: [acp]
    agentEngine: 'none'
    permission: ask
    # 可选：钉模型，必须与 modelSelect: session 同设(经 session/set_model 切换);单设 model 会追加 agy 拒绝的 --model
    # modelSelect: session
    # model: gemini-4-carbon-high   # effort 内嵌在模型 ID;不要设 effort 字段
```

```yaml
# 等级 1：一等支持 — Codex（私有协议，只能作命名后端）
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    backends:
      codex:
        protocol: codex
        command: codex
        args: [app-server]          # 可省略,缺省即 app-server
        model: gpt-6.2-astra        # 必填:须是 `model/list` 里你账号可用的模型 id
        sandbox: workspace-write    # read-only(默认) | workspace-write | danger-full-access
        approvalPolicy: on-request  # never(默认) | untrusted | on-request | on-failure
        effort: xhigh               # 可选:low | medium | high | xhigh | max | ultra(ultra 仅部分模型)
        permission: ask             # 审批逐次问用户;reject 拒绝该步;allow 全部放行
        description: 'Codex'
```

```yaml
# 等级 2：通用 ACP — 其他厂商
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    backends:
      other:
        command: /path/to/other-acp-agent
        args: [acp]
        agentEngine: 'none'
        description: 'Other ACP agent'
```

三个时长字段须为正数且不超过 Node 定时器上限,`registryPath` 为相对路径时插件启动即报错。

## 安装与升级

**主路径:从 npm 安装。** 需要 DSH `>=0.2.2-rc.3`(包里的 `engines.dsh` 只设最低版本,不为后续 DSH 版本线设置安装上限)和 Node >= 24:

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

> **提示：** 若安装报 `ERR_PNPM_TARBALL_EXTRACT` 或校验和错误，是 dsh 默认的 `minimumReleaseAge` 供应链防护过滤了刚发布的版本；npm 首发包还可能伴随无效的占位版本 `0.0.0-stage`。请显式钉版本：`dsh plugin --profile <name> add dsh-acp-resume@<版本>`，dsh 会将该版本写入 profile 的 `minimumReleaseAgeExclude`，可立即安装。版本发布一段时间后，不钉版本也会恢复正常。

`<name>` 是 profile 名(DSH App 的默认 profile 目录是 `~/.dsh/profiles/desktop/`)。装好后包会出现在该 profile 的 `dsh.profile.bundles` 里,重启 DSH 生效。升级用 `dsh plugin --profile <name> add dsh-acp-resume@<版本>`;卸载用 `dsh plugin --profile <name> remove dsh-acp-resume`。

**从 Discover 安装(实验性)。** 在 **插件** 页的 **实验性插件** 下直接找到并打开 **自定义插件索引**。随后会出现 **发现** 页签；打开它，选择 **添加索引源**，填入 `https://tureen.github.io/dsh-acp-resume/index.json`。索引加载后，在 `dsh-acp-resume` 卡片上选择安装并确认版本与来源，重启 DSH 生效。

**备选:本地 tgz。** 在本仓库 `pnpm build` 后 `pnpm pack --pack-destination <稳定目录>`(`prepack` 会先清空 `lib/` 再编译,保证不打进陈旧产物),再 `dsh plugin --profile <name> add <tgz 路径>`。

- tgz 放稳定位置,如 `~/.dsh/local-plugins/`,不要放 `/tmp`。profile 的 `package.json` 以 `file:` 路径引用 tgz,系统清掉 `/tmp` 后,profile 内任何插件增删(都会触发 pnpm install)都会因找不到该文件而失败。
- 升级必须改版本号。同版本号重新 pack 不生效:pnpm 按锁文件里的哈希认包,版本与路径不变时沿用旧缓存。

> ⚠️ **不要从 GitHub 地址安装。** 本仓库不含构建产物(`lib/` 已 gitignore),也没有 `prepare` 脚本,从 GitHub 地址(如 `github:Tureen/dsh-acp-resume`)安装会因缺少 `lib/index.js` 而加载失败。
>
> - 正确方式:用 npm 包名 `dsh plugin --profile <name> add dsh-acp-resume`,或从 Discover 市场安装。
> - 确需离线安装时，可用 `npm pack dsh-acp-resume` 下载 tgz 后 `dsh plugin --profile <name> add <tgz 路径>` 本地安装;不推荐，这样装的插件没有更新按钮。

要支持 Git 安装得写自包含的 `prepare`,用户还得在 profile 的 `pnpm-workspace.yaml` 里为本包开 `allowBuilds`(等于允许安装时执行包内代码),代价见官方 `docs/user/develop/basic/publish.md` 的 "Installing from GitHub" 一节。请用 npm 或 tgz。

- **bundle 与 profile insert 二选一,勿双挂**。profile 的 `dsh.profile.bundles` 列了 `dsh-acp-resume`(插件页开关打开)时,本包自带的 `cordis.patch.yml` 已经 insert 了插件;profile 再 insert 一次会注册两个同名 provider,报 `DUPLICATE_PROVIDER`。启用 bundle 时改配置用顶层同 id 覆盖:

  ```yaml
  - id: subagent-acp-resume
    name: 'dsh-acp-resume'
    config:
      command: /absolute/path/to/kiro-cli
  ```

## ACP Dispatcher 模式

### 是什么

一个会话就是一个**多工人工作台**：用户只用一个对话窗口描述大事，主 Agent 像工头一样拆任务、分配职责、追踪进度、收结果并合成答复；ACP 会话是各司其职、可并行工作的工人。kiro、agy、codex 三种引擎可同时在同一工作台上，工头按任务特征路由，全程零切换、零上下文丢失。

```text
+---------------------------------------------+
|  You (one conversation)                     |
|  "Complete this big project"                |
|                                             |
|  Dispatcher (foreman)                       |
|  |-- Worker 1 (kiro):   implement module    |
|  |-- Worker 2 (agy):    research API design |
|  |-- Worker 3 (codex):  write unit tests    |
|  |                                          |
|  |   ...workers run in parallel...          |
|  |                                          |
|  +-- collect all results                    |
|  +-- synthesize final answer                |
|                                             |
|  You (same window, zero switching)          |
+---------------------------------------------+
```

这是一个**可选**的会话模式(agent preset,见 D26)。不选时,标准模式与创造模式下 `acp_chat_*` 工具照常可用。

### 什么时候好用

- **多任务并行**:同一需求拆成 3-5 个独立子任务,各派一个 ACP Worker 同时跑。在工作台上这意味着你只描述一次，工头同时派 3 个工人开工，你不用管谁在干什么。
- **交叉验证**:同一问题派给不同后端(如 kiro + agy),对比结果。在工作台上这意味着工头把同一职责分配给不同专长的工人，再汇总差异。
- **长任务托管**:耗时的分析、编码、调研全部交给 ACP,主 Agent 只管进度和汇总。在工作台上这意味着工人持续推进，用户仍留在同一窗口等待合成结果。
- **主 Agent 上下文保持精简**:它不执行、不读文件,省下的 token 留给调度决策。在工作台上这意味着任务细节留在各自工人的会话里，工头保留全局进度。

### 什么时候不用

- 单一简单问题:直接回答比派活快。
- 需要精确控制文件修改:用标准模式自己改。
- ACP 后端不可用:没装 kiro-cli / agy / codex 时,派不出活。

### 工具面对比

| 工具 | Dispatcher | 标准 |
|---|---|---|
| `acp_chat_*` | ✅ | ✅ |
| web_search / fetch | ✅ | ✅ |
| session_search / goal | ✅(全局) | ✅ |
| present | ✅ | ✅ |
| 任务管理(jobs / todo / ask_user) | ✅ | ✅ |
| bash / fs / fs-search | ❌ | ✅ |
| subagent | ❌ | ✅ |

### 怎么切换

新会话的模式菜单里选 **ACP Dispatcher**。启用 bundle 后需重启 DSH 才会出现;不选则一切照旧。

### 设计原则

能力与模式解耦:插件提供能力(`acp_chat_*` 在所有模式可用),preset 提供组合选择(Dispatcher 是"只能派工"的可选约束)。

**注意**:preset 内的插件不带 config,用插件默认值;需要自定义命令或后端时,见 D26 已知风险。

## 工作区角色(D27)

默认关闭：在插件配置里设 `workflow: true` 才启用本节的角色与工作流功能。

在工作区根目录放 `.agents/acp-team.yml`(示例见 [docs/acp-team.example.yml](docs/acp-team.example.yml)),写好角色蓝图:名称、可选后端、工作目录和播种消息。之后模型调 `acp_chat_send`(以及 `acp_chat_close`、`acp_chat_steer`)时可以用 `role: reviewer` 代替 chatId:本会话第一次引用该角色时，插件按蓝图建会话、先发播种消息、登记到本会话的花名册，再发这条消息;之后的引用直接复用这个会话。`acp_chat_list` 会在这些会话前标出 `role <名>`。

- 花名册按 DSH 会话隔离：新会话里同名角色会另建一个会话。
- 改了蓝图不会自动重建已有角色;用 `acp_chat_close` 传 `role` 解除绑定后，下次引用按新蓝图重建。
- 插件从会话工作目录起向上找该文件，最多查 3 层(本目录、父目录、祖父目录)。文件缺失时不提示;格式错误时在日志告警，并当作没有配置。

### 工作流模板(`acp_workflow`)

在同一个文件的 `templates` 里写好流程，模型调 `acp_workflow(template, params)` 按模板执行。步骤按顺序执行:`parallel` 步骤把 prompt 同时发给列出的各个角色;`merge` 步骤要么把全部结果交回模型(`return_to_model`,只能是最后一步),要么交给一个角色合并(`role`)。prompt 里的 `{参数名}` 换成调用参数,`{步骤id}` 换成前面某一步的结果;一个前步都没引用的 prompt,会自动在末尾附上前一步的结果。单个角色失败只把该项记为 `{"error": …}`,其余照常;一步里所有角色都失败才中止。结果是 JSON:`{ template, status, steps: [...] }`。模型直接调用时，对话里会出现官方的工作流进度卡片(按步骤分组显示各角色的启停与结局)。有后台任务服务时，它和 `acp_chat_send` 一样立即返回 jobId,完成后唤醒模型。

```yaml
templates:
  - name: dual_review
    params: [target, dimensions]
    steps:
      - id: independent
        parallel: [reviewer, { role: security-reviewer, prompt: "Review {target} for security issues." }]
        prompt: "Review {target}. Focus on: {dimensions}."
      - id: merge
        merge: { mode: role, role: editor, prompt: "Merge these reviews of {target}." }
```

调用:`acp_workflow({ template: "dual_review", params: { target: "src/pool.ts", dimensions: "并发与资源泄漏" } })`。完整示例见 [docs/acp-team.example.yml](docs/acp-team.example.yml)。

## 后台任务模式的宿主前提

`acp_chat_send` 的后台模式依赖宿主同时装有 `@deepseek-ai/dsh-jobs-local`(提供 `ctx.jobs`)与 `@deepseek-ai/dsh-tool-jobs`(挂 job 控制器、提供 `job_output` / `job_list` / `job_kill` 与完成通知)。只有前者时 send 会以"无控制器"报工具错误;两者都没有时 send 回到同步等待。

## 真机冒烟前置检查

- 抓一次真机 `initialize` 响应,确认 `agentCapabilities.loadSession` 为 `true`。重连前会检查这项能力,未声明时每次重连都会降级为新会话,续聊失效(D16)。
- kiro load 对 cwd 敏感:确认注册表回放的是原 cwd(DESIGN.md 风险与对策)。

## 开发

```sh
pnpm install && pnpm build     # 构建 lib/
pnpm test                      # vitest;324 绿 = 官方协议面 68 + connection 28 + pool 61 + tools 15 + jobs 12 + panel 17 + client 71 + steer 5 + engine 16 + turn-log 18 + job-wait-gate 13
```

- 基线:源码经 npm `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3` 的 `src/run.ts` 与官方 checkout pin `ff6db9df9f37db545e8b124b9043269f17256a34` 对照；除 D11 记录的 `permission: ask` 与 ENOENT 窄例外外，`src/run.ts` 与 `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3` 一致；DSH peer 钉 `~0.2.2-rc.5`(rc.5 的官方 `run.ts` 与 rc.3 逐字相同)，Cordis peer 保持 `~4.1.0`;
- 条件运行的用例:真实子进程类 24 例需要官方 checkout 里的 `spawn.ts`(npm 分发包不含)。官方 checkout(路径由环境变量 `DSH_OFFICIAL_CHECKOUT` 指定,未设置时用测试里的默认位置)在场时全绿、退出码 0;不在时这 24 例自动跳过(见 DECISIONS D8);
- 双实现并存:除 D11 记录的 `permission: ask` 权限决策器与 ENOENT 指引窄例外外，run.ts 保持官方基线、不重构;connection.ts 是池专用姊妹实现;
- 参考用官方源码 checkout:pin `ff6db9df9f37db545e8b124b9043269f17256a34`(master 的 0.2.2-rc.3 状态,只读对照)。

## License

MIT

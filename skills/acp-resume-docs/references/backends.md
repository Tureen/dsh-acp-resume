# 选择与校验后端

先读当前会话注册的后端状态工具（默认 acp_backend_status）。候选清单表示可以选择的名称，ready 才表示通过这次检查。版本、账号与模型可用性以运行宿主为准。范围取当前包的[兼容表](../../../docs/backend-compatibility.md)。

| 后端 | 启动与模型 | 权限、限制与排查 |
|---|---|---|
| Kiro | kiro-cli acp。默认 v3。持久会话用 modelSelect: session，在建会话和重连时应用模型与 effortLevel；v2 可接受 --model 和 --effort。 | v3 拒绝这两个启动旗标，检查用户 args。强度限 low、medium、high、xhigh、max，各模型可能更窄；不支持某档会告警。可恢复，支持协商后的插话。 |
| Codex | protocol: codex 走 codex app-server。显式模型优先，否则标准 CLI 验证用户已有模型；没有用户模型时才选目录中唯一公布的、可用的文本默认模型。effort 随每轮 turn/start 传递。 | 自动项为 read-only / never / reject。账号或自定义包装器未必有可用默认模型。命令和文件审批可逐项确认，某些可选扩展审批不在兼容承诺内。 |
| Antigravity | agy acp。手配通常置 agentEngine: none；要选模型用 modelSelect: session。在此模式下可设 effort: high。1.5.13 使用 thought_level，配置可填 low、medium、high、xhigh；Gemini 4 Neon 有四档，Claude Sonnet 5.5 有前三档，Orchestrator (Neon) 无此项。新建与重连均先选模型，再设一次强度并核对回复，失败只告警。 | 自动项拒绝权限请求；显式可设 ask。握手通过后首次建会话仍可能要求登录。1.5.0 及以上支持中途插话（在途轮并发 prompt 接力，不打断当前步，在下一个工具或消息边界生效）；低于 1.5.0 不支持。实际可用性见 `acp_chat_list` / `acp_team_list` 的 `steer` 字段。 |

## 命名后端的 12 个字段

- **command、args、protocol**：command 必填；args 默认空数组，Codex 空数组实际启动参数为 app-server；protocol 默认 acp，可选 codex。
- **agentEngine、modelSelect**：ACP 默认 v3、flag；可选引擎 v1/v2/v3/none，可选设置途径 flag/session。Codex 协议不拼 ACP 引擎或模型旗标。
- **model、effort**：均默认未设。已知 CLI 的可用模型由账号决定。显式 Codex 模型须与 model/list 的模型名或目录 ID 匹配；自定义 Codex 命令宜明确配置模型。Codex 的强度由它的模型决定，不套用 Kiro 的五档校验。
- **permission、env**：命名项权限默认 reject，可选 ask/allow。env 默认为空对象，显式命名项在全局 env 上叠加，同名取该后端的值。自动发现的后端只继承查找路径覆写。
- **sandbox、approvalPolicy**：仅影响 Codex，schema 均允许省略。连接层分别采用 read-only 和 never。沙箱还可选 workspace-write、danger-full-access。审批策略还可选 untrusted、on-request、on-failure。审批策略决定何时问，permission 决定如何答，批准请求不会扩大既定沙箱。
- **description**：可省的候选后端说明，省略时显示名称及命令短名；不改变状态或路由。

## 新建和续聊

新建优先使用调用指定的 backend，其次 defaultBackend，再到顶层 default。仅当发现开启、未固定后端，且 DSH 确认找不到顶层 Kiro 命令时，才依次尝试范围内且就绪的 Codex、agy。版本告警、登录问题和握手失败均不触发改派。macOS Dock 启动的 PATH 可能与 shell 不同；无执行权限也可能被宿主归为找不到。

已有 chatId 或角色绑定继续原后端。改派说明出现在创建回执和发生首次供给的工作流成员结果里；list 只知道实际后端。升级 CLI、登录或更换默认模型后，在「右侧栏 → ACP 会话 → 重新检测后端」更新状态。无需建测试会话。

### 缺省模型与强度在哪改

- **侧栏即时修改（推荐）**：打开「右侧栏 → ACP 会话 → 设置」，在「后端缺省模型与强度」下按后端（`default`、具名后端及自动发现的 `agy`/`codex`/`kiro`）填写 `model` 与 `effort`，写回 profile 的顶层 `backendDefaults`。无需重启 DSH，不中断在途轮，新建会话与下次重连的旧会话生效。
- **优先级与回落**：`backendDefaults.<id>.model` / `effort` 优先于 profile 里的静态 `model` / `effort` 或 `backends.<id>.model` / `effort`。点击「清除」或留空后回落到 profile 静态值；自动发现且未手配的后端留空则使用后端自身默认。
- **档位校验**：Kiro 与通用 ACP 接受 `low`、`medium`、`high`、`xhigh`、`max`；agy 接受前四档（不含 `max`）；Codex 不限（文本框）。非法值在保存前拦截。

### 给已有会话换模型

在 Kiro / agy 的会话行（活跃空闲或已释放均可）展开「仅此会话设置」。可选档位随 CLI 和模型变化，面板优先读取当前连接或同后端活连接/内存缓存的清单；均无时显示「清单未知，将使用缺省值」且不报错。切换到没有强度项的模型时显示「此模型不提供」。已释放会话的修改记录为内存重连覆盖（不写注册表），提示「下次重连时生效」，下次重连先应用有效缺省配置，再叠加该会话的显式覆盖；`purge` 删除会话时一并清除。Codex 暂不支持会话级切换，改缺省模型请在设置区或后端配置中修改。

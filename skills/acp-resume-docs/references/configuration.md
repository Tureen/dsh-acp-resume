# 配置主插件

先确认安装时的 profile 名。其 `cordis.patch.yml` 顶层的 `- id: subagent-acp-resume` 是 ACP 主插件行；行内 `name` 为 `dsh-acp-resume`。启用 bundle 后它已经存在。调整字段时覆盖该行，保留完整的 `config`。只写一个 `backends` 或 `roles` 会丢失原有的顶层启动配置。

下表是主行的 22 个字段。默认列取插件 schema。bundle 另行填写了 `command: kiro-cli`、`args: [acp]` 和 `permission: allow`。整块覆盖后省略某字段，得到的是 schema 默认值。

| 字段 | 默认 | 用途、何时修改 |
|---|---|---|
| providerName | acp-resume | 一次性委派 provider 名，宿主内必须唯一。通常沿用默认名，以免与官方 acp 冲突。 |
| command | 必填字符串 | DSH 要启动的外部 ACP 命令。桌面找不到 CLI 时用可执行文件的绝对路径。即使另配 Codex，顶层仍必填。 |
| args | 空字符串数组 | 子进程参数。Kiro、agy 通常需要 acp 子命令。已显式传入的旗标优先。 |
| agentEngine | v3 | 可选 v1、v2、v3、none。非 Kiro 通常设 none，使插件停止追加引擎旗标；手写在 args 中的旗标仍在。 |
| model | 未设 | 需要固定 ACP 模型时填写。省略时使用后端自身选择。 |
| modelSelect | flag | flag 模式按需追加模型和强度旗标。session 模式在持久会话建立或恢复后设置；一次性委派没有池的会话级选择步骤。 |
| effort | 未设 | flag 模式传 --effort；ACP session 模式允许 low、medium、high、xhigh、max，具体档位看模型。 |
| permission | reject | allow 自动答允，reject 拒绝，ask 逐次询问宿主用户；确认服务缺席或回答无效时取消。 |
| env | 空对象 | 字符串键值，叠加到清洗后的子进程环境；按实际需要给路径或凭据。排障时避免输出凭据。 |
| disposeEofGraceMs | 6000 | 关闭时等待 EOF 自然退出和冲洗数据的毫秒数。外部 agent 需要更长退出时间时调整。 |
| disposeGraceMs | 3000 | 释放时等待在途轮结算、终止子进程的阶段宽限。它不限制正常回答时间。 |
| idleTimeoutMs | 600000 | 无活动多久释放进程；本地记录保留。三个时间字段均须为正有限数且不超过 2147483647 毫秒。 |
| registryPath | 空字符串 | 默认使用 $DSH_HOME/storages/acp-resume/registry.json。另设时须为绝对路径；turns 和 workflows 日志随父目录存放。 |
| backends | 未设 | 命名后端字典。名称只含 ASCII 字母、数字、下划线、连字符，长度 1–32，default 已由顶层占用。 |
| defaultBackend | 未设 | 固定新会话优先使用的已定义后端；工具显式选择优先，已有 chat 继续原后端。 |
| discoverBackends | true | 自动发现常见 CLI。仅需人工配置时可关闭，显式后端仍可用。 |
| allowUnverifiedBackends | false | 允许显式选用自动发现的范围外版本；不会将其加入自动回退顺序。 |
| toolPrefix | acp_chat_ | 五个 chat 工具的前缀。status、team_list 派生名字时去掉末尾 chat_；workflow 和 usage 工具名固定。 |
| enableChatTools | true | 关闭持久会话工具、池与后端检测。一次性 provider 仍在，列表与详情显示关闭态。 |
| allowChatJobWait | false | 有 jobs 时默认拦截运行中 ACP job 的阻塞等待。开启会移除等待门；常规收结果仍可等通知后读。 |
| roles | true | 注册角色参数、团队列表和按主会话隔离的花名册。关闭后仍能按 chatId 派工。 |
| workflow | false | 开启模板工具 acp_workflow，要求 roles 为 true；非法组合在插件加载时报错。 |

命名后端的键与协议差异见[后端](backends.md)。工具选择与提示词属于另一独立行，见[Dispatcher](dispatcher.md)。需要可复制的起点时，选择[配方](recipes.md)或[完整模板](../templates/profile-override.yml)。

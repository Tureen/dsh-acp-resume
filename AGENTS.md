# AGENTS.md

dsh-acp-resume 是 DeepSeek Harness 的可续聊 ACP 子代理后端:`@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3` 的独立兄弟包,完整保留官方 one-shot(一次性)委派行为(仅 D11 明载的 ask 权限决策与 ENOENT 指引例外),新增持久会话池——进程保活、远端会话号落盘、进程死后经 `session/load` 重连。改架构前读 [DESIGN.md](DESIGN.md);决策按编号引用 [DECISIONS.md](DECISIONS.md);当前进度与验收状态见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 基线与隔离(硬约束)

- DSH peer 依赖全部 `~0.2.2-rc.5`、Cordis peer `~4.1.0`(D2,2026-11-19 随 App 升 rc.5);`src/run.ts` 的 one-shot 基线仍对照 `dsh-subagent-acp@0.2.2-rc.3`(rc.5 的官方 `run.ts` 与之逐字相同);DSH App 升级时同步重装 peer 并跑全量回归。
- 本包 provider 注册名 `acp-resume`,永不触碰官方 `acp` provider 与现有 kiro 链路(D1)。
- `src/run.ts` 保持官方源码逐字基线，只有 D11 明确记录的 `permission: ask` 权限决策器和 ENOENT 固定指引例外；禁止为消重而重构。`src/connection.ts` 是池专用姊妹实现,约 200 行受控重复是刻意选择,不是待清理债务。
- 42 个官方协议面用例是 one-shot 行为的不回归门槛;真实子进程类 24 例依赖官方 checkout 的 `spawn.ts`(npm 分发包不含),checkout 在场时运行、缺席时自动跳过(D8),跳过属预期,不是待修缺陷。
- 官方源码只读对照:`<官方 checkout>`(默认按 `~/Developer/open-source-projects/deepseek-harness` 探测,可用环境变量 `DSH_OFFICIAL_CHECKOUT` 覆盖),pin `ff6db9df9f37db545e8b124b9043269f17256a34`(master 的 0.2.2-rc.3 状态)。

## Repository layout

```
src/
  index.ts       插件入口:Config(全字段见 README「配置」;`roles` 默认 true、`workflow` 默认 false,`roles: false` + `workflow: true` 加载即报错,D33)+ provider 与工具注册；按命令识别 ACP 强度项并校验档位(D40)
  settings-rules.ts D45:共享前置校验文案。主 Config 的 defaultBackend、roles、workflow、allowChatJobWait、allowUnverifiedBackends、idleTimeoutMs、probeTimeoutMs 为 volatile。工具注册子作用域独立于 ACP 池。
  backend-compatibility.ts D31:发布的 CLI 版本范围；`pnpm check:compatibility` 校验生成文档
  backend-status.ts / backend-readiness.ts / backend-verification.ts D31/D41/D43:子作用域在每轮检测读取 volatile 超时预算；区分超时与握手失败。共享状态、启动版本探测、无会话验证与派工准入；模型与强度的探测报告独立于派工选择
  command-not-found.ts 固定 ENOENT 判断与模型侧行动指引(不回显用户配置)
  permission-request.ts `permission: ask` 的 ACP→宿主用户确认映射与 fail-closed 取消
  run.ts         官方 one-shot 驱动(D11 窄例外:ask 权限决策器与 ENOENT 指引;勿重构)
  connection.ts  连接原语:openNew / openLoad({sessionId, cwd, mcpServers:[]})/ prompt / steer(私有 `_session/steer`)/ dispose;
                 `modelSelect: session` 时开会话后应用 sessionModel(set_model,回退 set_config_option(model))
                 与 sessionEffort：Kiro effortLevel 核对并有限重试(D34)，agy thought_level 新建/重连各设一次并核对(D40)
  codex-approval.ts Codex 审批策略与 ask 桥(D25;复用 userQuestionPermissionResolver,fail-closed 回 cancel)
  connection-codex.ts Codex app-server 私有协议连接层(D25;与 AcpConnection 同形状,自带 JSON-RPC 行传输,不用 ACP SDK)
  chat-options.ts / acp-reported-settings.ts D41/D44:会话可选模型和强度的只读结构及解析；从 ACP 回复与配置更新读取后端报告的模型、展示名和强度
  live-buffer.ts   D46:有查看者时才分配的 UTF-8 尾部环形缓冲，共享攒批计时器。
  pool.ts        D46:按当前轮并列观察文本，最后一个订阅者离开即释放缓冲；D44:存活连接的设置与发送互斥，不落盘；D41 只读投影存活连接的最近设置报告；持久会话池:start/send/steer/close、空闲释放、注册表原子落盘、重连与降级;轮结算与重连事件写按轮日志;D27 角色:sendByRole / startForRole / releaseRole 与自动供给
  dispatcher-preset.ts D37/D38:独立全局声明插件；dispatcherTools 六项开关（readOnlyFs 含 skill）控制子行、description 与工具指引，dispatcherPrompt 追加或替换 persona 的调度规则；声明热更新与 ACP 池隔离
  team-prompt.ts D36:在 Dispatcher 实际绑定且本步团队工具可用时注入角色转述规则
  team-config.ts D27:读工作区 .agents/acp-team.yml(向上至多 3 层),角色蓝图 + 模板的解析与校验;不可用时 onWarn 并视为无配置
  usage.ts       D28:后端额度统一结构与缓存(5 分钟，失败 1 分钟，过期先回旧值后台刷新、按后端单飞);Codex 只读 account/read + account/rateLimits/read
  roster.ts      D27:按 ownerSessionId 隔离的花名册(角色 → chatId),持久化在注册表 rosters 节
  team-view.ts   D47:纯函数团队视图投影(从既有花名册与缓存轮日志派生内存可选 `role?`/`latestTurn?`、五态分类排序与按 owner 互斥分流;零新存储、零额外磁盘 IO)
  workflow-engine.ts D27:按模板执行工作流(parallel 部分容错、{param}/{stepId} 注入、merge 两模式),无状态;可选观察者
  workflow-log.ts D29:按会话的工作流运行日志 workflows/<ownerSessionId>.jsonl(run-start + run-end 摘要，不存原文与 params;同 D18 纪律)
  workflow-record.ts D27:向调用会话写官方 tool-workflow/* 四种进度记录(仅顶层调用;写失败告警一次后停写)
  turn-log.ts    按轮日志 `turns/<chatId>.jsonl`(追加、截断、裁剪、容错读、删除;写失败只告警,D18)
  panel.ts       D46:watch 是带 owner 校验与取消信号的 Remote 流。D44:close/purge/chatOptions/setChatModel/setChatEffort 核对 seat sessionId 与 owner。面板 host 半:`acpResume/list|close|purge|turns|turn|usage|workflows|backends|checkBackends`；状态只读，手动重查复用启动检测(D31)；另有独立的 `acpResumeInfo/features` 返回开关和创建工具名(D35)，关闭持久会话时仍可读
- `src/client/panel-time.ts` / `panel-chrome.tsx`（D47）：全侧栏共享纯时间/耗时格式化与共享视觉原语（左侧 3px 状态竖条四态、10px 卡片外壳、引用稳定 `useMarkdownLabels`、`cleanPreview` 与官方组件再导出）。
- `src/client/features-source.ts` / `PanelFeatureGate.tsx`（D35）：列表、详情正文和标题共享连接级能力查询，关闭时均不订阅业务数据源。工作流关闭时 `workflows-source.ts` 只在区块打开或手动刷新时读取历史。
- `src/client/ProfileSettings.tsx`（D45/D47）：两个官方 ConfigForm、逐字段保存，官方 `Switch`/`Input`/`Modal(tone="warning")` 控件与首次写回确认。
- `src/client/detail-markdown.tsx`（D47）：官方 Markdown 正文与清洗预览，复用共享 labels 和紧凑段距。
- `src/client/live-source.ts`（D46）：仅展开的可见详情正文共享一条流，切走即取消，轮结束刷新原有详情数据源。

- `src/client/ChatSettings.tsx`（D44/D47）：官方 `DisclosureRow` 展开时读取单会话选项，改完刷新；旧宿主签名不符提示重启。
- `src/client/TeamSection.tsx`（D47）：团队派工视图，每角色一张三层卡，按进行中/出错/取消/完成/空闲排序，点击直达详情，`⋯` 菜单释放/删除，与自由会话互斥分流。
- `src/client/` 后端卡片标示模型与强度的报告来源、配置差异和未报告项(D41)。详情与列表：ChatsPanel 的运行中徽标与持续时长、ChatDetail 的运行中合成条目及本地全文展开；除 D46 展开的流式正文外，数据跟随既有数据源轮询，唯一的本地时钟是 ChatsPanel 在途行的 1 秒计时(只在有在途轮时挂载，只重绘该时长)。
  engine.ts      --agent-engine 旗标:追加(用户已写则不追加)与指纹比较时剔除(D19)
  job-wait-gate.ts  D22:tools/pre-execute 监听逻辑,只拒绝运行中 acp-chat 任务的 job_output wait:true；allowChatJobWait 为 true 时不挂门
  tools.ts       五个模型工具:acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close / acp_chat_steer
                 (defineTool + ctx.tools.register,不走 ctx.subagents);roles: true(默认)时另注册 <prefix>team_list(D32,默认 acp_team_list)并给 send/close/steer 加 role,workflow: true 时再注册 acp_workflow(D27;须 roles: true,D33);有 ctx.jobs 时 send 注册
                 acp-chat 后台任务并立即返回 jobId(D17),无 jobs 时同步等待、轮非 completed 抛工具错误
locale/         en.json / zh.json:插件显示元数据(meta.title/description),经 exports 的 ./locale/*.json 暴露
cordis.patch.yml bundle 层:插入 ACP 主插件和独立的 Dispatcher 声明行 `acp-dispatcher-settings`及全局文档发现行 acp-resume-skill-filesystem（D26/D37/D39）
skills/acp-resume-docs/ D39:随包的中文使用文档，入口 + 七份任务参考 + 完整 profile 模板
icon.svg        插件图标,由 package.json 顶层 icon 字段声明;locale 与图标都须在 files 里
scripts/
  backend-compatibility.mjs 生成/校验兼容表
  release.mjs    发布流水线:八个子命令各是一道门槛;tag 只在 CI 于完整 sha 上 success 时才打
tests/
  subagent-acp.spec.ts   官方协议面回归(含 42 例协议面门槛)
  connection.spec.ts     连接原语
  connection-codex.spec.ts Codex 连接层(D25):开/恢复、流式、停止原因、steer/取消、审批(含 ask 桥)、进程失败
  pool.spec.ts           池生命周期
  dispatcher-preset.spec.ts D37:默认定义深比较、工具勾选、旧 profile 警告、已绑定 Agent 的版本隔离、真实 skill 发现/加载与自定义调度提示组装
  live-buffer.spec.ts / live-gateway.spec.ts D46：尾部字节上限、合帧、显式取消和真实 rc.5 Gateway 清理。
  live-settings.spec.ts / profile-settings.spec.tsx D45：真实临时 profile 逐字段保存、在途轮和 Agent 隔离；侧栏表单和写回确认。
  skill-docs.spec.ts     D39:标准模式和 Dispatcher 文档发现、加载、引用文件和可用配置范例
  team-prompt.spec.ts    D36:用 rc.5 Agent、preset 注册表和工具准入组装实际系统提示
  team.spec.ts           D27:工作区配置读取、花名册、角色自动供给与工具 role 参数
  workflow-log.spec.ts   D29:工作流运行日志、运行中跟踪、孤儿清理、Remote 与 runId 共用
  usage.spec.ts          D28:额度映射、缓存、Codex 活跃连接与临时 app-server 读取、工具与 Remote
  workflow.spec.ts       D27:工作流引擎(假池)与 acp_workflow / steer role(真池)
  jobs.spec.ts           后台任务模式 send(真 jobs-local 注册表)与 send 变体随 ctx.jobs 切换
  steer.spec.ts          acp_chat_steer:插话快乐路 / 不支持降级 / 无在途轮拒绝
  engine.spec.ts         --agent-engine 辅助函数与两条 spawn 路径的 argv
  job-wait-gate.spec.ts  D22 门:decideJobWait 纯函数、allowChatJobWait 开关、真实 ToolRuntime 派发
  turn-log.spec.ts       按轮日志单元(追加/读/截断/容错/裁剪/删除/写失败)
  panel.spec.ts          面板 host 半 Remote 方法;client.spec.tsx 面板浏览器半(jsdom);panel-time.spec.ts / panel-chrome.spec.tsx 共享时间与视觉原语(D47);team-view.spec.ts 团队派工纯函数(五态/跨 owner/截断/互斥分流,D47)
  mock-codex-server.ts   Codex app-server mock(D25;无 SDK,会话表落文件支持 thread/resume)
  mock-acp-server.ts     扩展了 session/load 的 mock;会话表落文件以支持跨进程重连(D9/D12)
  fixtures/  helpers/    loader 夹具与测试辅助
lib/            tsc 产物(gitignored)
```

## Commands

```sh
pnpm install     # node >= 24;pnpm-workspace.yaml 的 allowBuilds 若仍是占位文本会报错,改为 true/false 后重试
pnpm build       # tsc -p tsconfig.json → lib/ 与 lib/types/
pnpm test        # vitest run;pnpm 依赖预检失败时直接 ./node_modules/.bin/vitest run
```

发布走 `scripts/release.mjs`(每个子命令一个门槛,红了就停,绝不重跑、不挪 tag):`token` → `preflight` → `ci` → `skipped` → `tag <ver>` → `npm <ver>` → `verify <ver>` → `index <ver>`;也可用 `pnpm release:<step>`。`verify` 用 `RELEASE_MARKERS` / `RELEASE_ABSENT`(JSON:`{"lib/x.js":"text"}`)声明本版必须包含 / 必须移除的标志。**判断性的部分与硬规矩见用户级 skill `release-dsh-plugin`**,不要凭记忆发版。

### 期望测试基线

- 全绿时的期望回归面为各套件用例之和，当前 739 例：官方协议面 `subagent-acp.spec.ts` 68(含恢复的 24 例 D8 豁免)+ `connection.spec.ts` 52 + `connection-codex.spec.ts` 39 + `pool.spec.ts` 95 + `tools.spec.ts` 58 + `jobs.spec.ts` 12 + `panel.spec.ts` 30 + `client.spec.tsx` 139 + `steer.spec.ts` 5 + `engine.spec.ts` 22 + `turn-log.spec.ts` 18 + `job-wait-gate.spec.ts` 15 + `team.spec.ts` 25 + `team-prompt.spec.ts` 6 + `dispatcher-preset.spec.ts` 17 + `skill-docs.spec.ts` 5 + `workflow.spec.ts` 20 + `usage.spec.ts` 8 + `workflow-log.spec.ts` 8 + `backend-verification.spec.ts` 24 + `backend-compatibility.spec.ts` 29 + `live-settings.spec.ts` 16 + `profile-settings.spec.tsx` 4 + `panel-time.spec.ts` 7 + `panel-chrome.spec.tsx` 7 + `live-buffer.spec.ts` 3 + `live-gateway.spec.ts` 2 + `team-view.spec.ts` 5;新套件落地时在此登记。


- D8 豁免已恢复为条件运行:官方 checkout(默认按 `~/Developer/open-source-projects/deepseek-harness` 探测,可用环境变量 `DSH_OFFICIAL_CHECKOUT` 覆盖)在场时全绿、`pnpm test` 退出码 0;缺席时该 24 例自动跳过,其余仍须全绿。
- 测试同时验证 lib/ 与源码行为前先 `pnpm build`,保证 lib/ 不是陈旧产物。

## Conventions

- ESM(`"type": "module"`)。相对导入写 `.js` 后缀(NodeNext);跨包引用一律用包名。TypeScript `strict` + `noImplicitAny` + `verbatimModuleSyntax` + `isolatedModules`。
- **仅命名导出**:默认导出会丢 loader 元数据(index.ts 头注引官方 postmortem 0001)。
- schemastery `~3.19.0`（D42，2026-11-26 实测）：3.18.5 与 3.19.0 均无 `.optional()`。可选字段直接用 `z.string()`，缺省时结果中没有该键。必填用 `.required()`，缺省值用 `.default(...)`。主插件与 Dispatcher 的对象 schema 都保留未知键。需要热更新的字段可用 `.default(...).volatile()`，解析后的值通过 `.get()` 读取。
- 新增 Config 字段时先判断重载是否会释放池。能安全实时应用时，用 volatile 引用并将需要重注册的消费者放在独立子作用域；否则保留普通字段。
- 模块头 JSDoc:一段话讲清契约与边界,`@module` 标识;公共导出与 Config 字段补简明 JSDoc。
- 注释直接、具体:不重述代码、不写推理过程;命令、路径、报错保留原文。
- 凭据走 Config `env` 显式叠加,父进程环境先经官方清洗逻辑;不在测试、夹具、文档写入真实 key。
- send 的后台任务模式见 D17:单飞前置检查在 `jobs.start` 之前;job 的取消走 D6 取消条;无 jobs 服务时保持同步语义。
- D22 等待门仅拦本会话运行中 acp-chat 的 `job_output wait:true`，`stopping` 放行。工具说明允许用宿主的 `wait_agent` 等 inbox 通知或用户插话；完成后按 D17 读结果。
- 池语义固定,改动需先修订 D6:每会话单飞(在途时拒绝新 send,不排队);协议级 `session/load` 拒绝且能认出会话不存在(或未声明 loadSession)，或当前池实例同一 chat 连续 3 条 `error` 后的下一次 send，才降级新会话，分别注记固定短语 `remote session lost, started fresh` 与 `remote session failed repeatedly, started fresh`;后者计数仅在内存中保存，重启重新累计，注册表不存此状态;其余重连失败(含原因不明的 load 拒绝)报错且注册表不动;空闲释放只关进程、注册表保留;注册表写 = 临时文件 + 原子改名;取消 = 本地立即结算 `aborted` + 尽力 `session/cancel` + 作废连接(error 轮同样作废)。
- D46 的流式内容与帧只在内存保留；结算后由原有 D18 日志接替。
- 按轮日志(D18)是诊断镜像不是状态:写失败只经 `onWarn` 告警、绝不改变轮结果;写前复查注册表里会话还在(purge 后不得复活);`purge` 连日志文件一起删;steer 不记。注册表结构不因日志而改。
- 面板详情页签是资源地址页签(`dsh-resource://acp-resume-chat/<chatId>`),不注册 resource provider;身份只能放地址里(官方不持久化导航参数)。
- kiro 侧会话随 new/load 积累(D10):`acp_chat_close` 的工具说明需提示以 `kiro-cli chat --list-sessions` / `--delete-session` 清理。
- 新决策写进 DECISIONS.md(既有条目就地更新并注日期);修订行为前先查是否触碰既有 D 编号。
- 文档与提交信息用中文;IMPLEMENTATION-PLAN.md 的步骤状态(☐/◐/☑)随对应提交更新。
- 动 `src/` 前先看 `git status` 与 IMPLEMENTATION-PLAN.md:实施步骤可能在途且有未提交改动,勿覆盖。

## Editing these instructions

AGENTS.md 是协作规则的唯一事实源;改规则时同步核对 README.md / DESIGN.md / DECISIONS.md 的对应表述,绿色回归面数字变化时更新「期望测试基线」。

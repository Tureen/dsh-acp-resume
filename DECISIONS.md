# 决策记录(DECISIONS)

按编号引用;每条含决策、依据、后果。修订时原条目就地更新并注明日期。

## D1 独立新包,不 fork 官方 subagent-acp(2026-11-04)

依据:fork 会破坏三条硬要求——现有 kiro 链路隔离(同名包替换会劫持 `provider: acp` 配置)、官方更新可跟进(rebase 负担)、客户端升级可适配(peer 面缩小到 seam 契约)。独立包注册 `acp-resume`,与官方 `acp` 并存,三条全部成立。
后果:包内自持官方 one-shot 源码副本;2026-11-09 已与 `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3` 的 npm `src/run.ts` 对照，除 D11 记录的 ask 权限决策器与 ENOENT 指引窄例外外，`src/run.ts` 无差异;官方缺陷修复需择要摘入(面小)。

## D2 基线钉 0.2.2-rc.3,与已装 App 对齐(2026-11-03;2026-11-09、2026-11-19 修订)

依据:用户 App 已自动升级至 0.2.2-rc.3;错版先例:误装 0.1.0-rc.6 导致 provider 行无法激活。
后果:DSH peer 与对应 devDependencies 全部 `~0.2.2-rc.3`(2026-11-19 起为 `~0.2.2-rc.5`,见下方修订);Cordis peer/devDependencies 保持 `~4.1.0`，loader devDependency 保持 `~1.1.0`；新版工具运行时将执行器拆出，直接调度 ToolRuntime 的回归用例另加 `@deepseek-ai/dsh-tool-executor-native` devDependency；App 升级时同步重装并跑回归。

修订(2026-11-09):包所有者决定将 `engines.dsh` 改为仅设最低版本 `>=0.2.2-rc.1`、移除上限，避免每次宿主跨版本线升级都必须发布新版插件。所有者接受代价：未来 0.3+ 宿主若不兼容，安装不再被 engines 拦截，问题可能表现为构建、加载或运行期故障；这不改变 DSH peer 仍钉 `~0.2.2-rc.1` 的策略。官方 checkout 已切到 tag `dsh-v0.2.2-rc.1`，除 D11 已记录的 ask 权限决策器与 ENOENT 指引窄例外外，`src/run.ts` 与官方一致；D8 的 24 个真实子进程用例在该 checkout 下实际运行，连同 42 个 mock 协议面和其余套件共 320 例全绿。

修订(2026-11-09,rc.3):`engines.dsh` 最低版本同步抬为 `>=0.2.2-rc.3`，无上限策略及已接受的 0.3+ 风险不变。任务开始时官方 checkout 未持有 rc.3 tag，故 checkout 固定到 origin/master 的 `ff6db9df9f37db545e8b124b9043269f17256a34`（`apps/cli` 与 `dsh-subagent-acp` 均为 0.2.2-rc.3）；run.ts 基线以 npm `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3` 的 `src/run.ts` 为准。已逐项核对该 release commit 中 `docs/upgrade-guide/v0.2.2-rc.1` 的 19 项，均不触及本包 tools/jobs/userQuestions/subagent provider/panel Remote/client/dsh.bundle API 面，无生产适配项。rc.3 的 `SubagentRuntime.startActivation` 将 `parent` 提到 activation spec 顶层并移除 provider `list()`；测试辅助与注册/卸载断言已按新版 API 调整，插件 `AcpProvider.start` 不变。D8 的 24 个真实子进程用例在 master pin 下实际运行，连同其余套件共 321 例全绿。

修订(2026-11-19,rc.5):DSH App 升至 0.2.2-rc.5,dependencies、peerDependencies、devDependencies 中全部 `@deepseek-ai/dsh-*` 由 `~0.2.2-rc.3` 改为 `~0.2.2-rc.5`,从 registry.npmjs.org 重装,lockfile 中 dsh-* 全部解析为 0.2.2-rc.5;rc.5 各包对 Cordis 的要求仍是 `~4.1.0`,Cordis 与 loader 不动。pnpm 因 rc.5 发布时间短于最短发布期，在 `pnpm-workspace.yaml` 写入这批包的 `minimumReleaseAgeExclude`,随本次提交保留。npm `@deepseek-ai/dsh-subagent-acp` 的 rc.3 与 rc.5 `src/` 逐字相同,`src/run.ts` 不需摘入;官方 checkout pin 与 `engines.dsh`(`>=0.2.2-rc.3`)本次不动。回归:官方 checkout 在场,D8 的 24 例实际运行;首轮全量 431/432,失败的是 `connection-codex.spec.ts` 的 `cancel settles aborted locally and sends turn/interrupt with the turn id`(卡满 5 秒超时),单独重跑 10/10、全量重跑 6/6 均 432 全绿。根因与 peer 无关：该用例在 mock 写出 ready 文件后立即取消，若客户端此时尚未读到 `turn/start` 的回复(未知 turnId),`sendInterrupt` 直接返回、之后也不补发,`turn/interrupt` 永不发出，用例等待中断日志而超时;把 mock 的 `turn/start` 回复延迟 300ms 可稳定复现。本地 `aborted` 结算正确;D6 的远端取消本属尽力而为。(2026-11-19 已修复：取消早于 turn/start 回复时，在回复到达、拿到轮次号后补发 `turn/interrupt`;新增 mock 延迟回复 300ms 的回归用例，基线 432 → 433。)

## D3 不接入内核续聊体系(prepareContinuable)(2026-11-04)

依据:0.2.1-rc.5 契约原文——provider 的该方法只贡献创建输入,continuation manager 随后创建并驱动**本地 Agent**;`SubagentStartRequest` 无自由字段可传"复用哪个远端会话"。外部进程续聊无法经内核表达(官方让 ACP 走 one-shot 分支、社区插件自建工具层,同因)。
后果:续聊层建于包内(会话池+自建工具);不依赖内核 continuable 接口,降低内核演进耦合。

## D4 保留 one-shot provider(2026-11-04)

依据:与官方同型的委派路径是隔离性证明与回归安全网;部分场景仍需一次性外援。
后果:`startAcpRun` 重构为连接原语的薄包装,42 个协议面用例作为不回归门槛。

## D5 自建四个模型工具(2026-11-04)

依据:D3 之下模型触达会话池的唯一途径;官方姿势 `defineTool`(@deepseek-ai/dsh-tools)+ `ctx.tools.register`,参照 tool-subagent 实现。
后果:新增 dev/peer 依赖 dsh-tools;工具不走 `ctx.subagents`,不进委派目录 UI(与外部 one-shot 一致,可接受)。
修订(2026-11-04,D19):工具增至五个,新增 `acp_chat_steer`(给在途轮插话,标并发安全)。
修订(2026-11-04,D17):宿主装有 jobs 服务(`ctx.jobs`)时,`acp_chat_send` 不再等整轮回答,改为把这一轮注册成后台任务(job),立即返回 jobId;回答流式写进该 job 的输出,完成通知由宿主的 tool-jobs 在会话内送达,模型用 `job_output` 读、`job_kill` 停。无 jobs 服务时 send 保持原同步语义。其余三个工具不变。

## D6 池语义(2026-11-04;同日按六维评审修订,见 D16;2026-11-09 重复失败恢复修订;2026-11-18 load 拒绝收窄)

**本次修订背景(2026-11-09):** 今天网络切换后，4 个 kiro 远端会话都能成功 `session/load`，但每次 prompt 约 8 秒后传输断开并以 `stopReason=error` 结算。原规则只会在协议级 load 拒绝时新开会话，这类「能加载、一用就崩」的会话会无限重试同一个远端会话，只能人工 purge；上述 4 个会话已人工清理。

- 单飞:每会话同时仅一个 prompt 在途,在途时新 send 拒绝并提示(与官方"一次一个"一致,不做排队);
- 工具并发标注:`acp_chat_start` / `send` / `list` 标并发安全,不同会话的 send 可并行;`acp_chat_close` 标独占(不与其他工具并行);同一会话的并行 send 仍由单飞拒绝;
- 降级(一,2026-11-18 收窄):**仅协议级会话不存在才降级**。`session/load` 被远端在协议层拒绝(`AcpConnectionError` 的 `stage: load-session` 且 `category: protocol`),且能明确认出会话不存在——原始错误的 message / data / details 含 `session not found`、`no such session`、`unknown session`、`no rollout`(Codex `thread/resume`)或 `thread not found`(不分大小写),或是能力门控判定的 loadSession 未声明——时降级为新会话(判定见 `isLoadSessionMissing`);**原因不明的 load 拒绝**(如 -32603 内部错误、需认证、限流)保留原绑定、本次 send 报错,记 `reconnect-failed`,由调用方决定重试。收窄背景:三引擎交叉审查指出原规则把任何协议错误都当「会话丢了」,一次暂时性拒绝即作废原有上下文。工具回答首行前置注记,内含固定短语 `remote session lost, started fresh`,由模型决定重述上下文。
- 降级(二,2026-11-09):每个 chat 在**当前池实例内存**中累计连续 `stopReason=error` 的已结算轮数；任一非 `error` 结算轮都会折断连续性，成功轮必然清零。累计到 3 后，该 chat 的**下一次** send 在已释放状态下跳过 `session/load`、直接 `session/new`，替换注册表中的远端会话号，回复首行前置含固定短语 `remote session failed repeatedly, started fresh` 的注记。此计数不写注册表、不改变其结构或版本，应用重启后的新池从 0 重新累计；这是有意接受的非持久诊断状态。该路径与协议级 load 拒绝并列，不能把它伪记为远端 load 拒绝。
- 进程启动失败、传输断开、进程退出等其余**重连**失败直接让本次 send 失败,注册表不动,原远端会话号保留待下次重试；prompt 已结算为 `error` 的轮仍按上一条累计。
- 空闲:`idleTimeoutMs`(默认 600 000)到期关进程,**注册表保留**,下次 send 重连;
- 注册表:进程内串行写,临时文件+原子改名,**先落盘成功再更新内存**(2026-11-18);新建连接(start、降级新会话)写注册表失败时先关闭该连接再报错,不留未纳管的孤儿进程,降级分支的注册表仍是旧会话号;记录 chatId/remoteSessionId/cwd/命令指纹;文件损坏(读不了、非 JSON、结构不符)时改名为 `<路径>.corrupt-<时间戳>` 留证,经 `onWarn` 告警后以空表继续;`registryPath` 须为绝对路径(空串取默认路径);
- 取消:send 的工具取消信号让本轮在本地立即结算为 `aborted`,同时尽力发送 `session/cancel`(不等远端回应);随后作废该连接(关进程,注册表保留),下次 send 经 `session/load` 重建;
- 失败轮:结算为 `error` 的轮同样作废连接,理由同取消(子进程多半已死或状态不明);
- close:在途轮先协作取消(`session/cancel`),最多等 `disposeGraceMs` 让它结算,再释放进程;`purge` 额外删注册表条目,释放失败时保留条目并报错;拆卸/关闭对重连窗口有界:close 与 `disposeAll` 中止进行中的启动/重连窗口(池持有的 AbortController,启动竞速据此自行释放子进程),最多等一整轮销毁梯子,即 `disposeEofGraceMs + 2 × disposeGraceMs`(EOF 宽限 + 2 × SIGTERM 宽限,超过 Node 定时器上限时取上限),超时即按已释放处理,窗口晚到的连接一律丢弃并关进程(2026-11-04 补;同日资源审计 P2-2 修订:原上限只有 `disposeGraceMs`,而被中止的窗口要先走完自己的销毁梯子才结算,默认配置下 close/dispose 会比窗口子进程退出早约 3 s 返回);
- 释放:会话在旧进程真正退出(或其销毁报错)之后才离开活跃表,释放期间 `listChats`/面板仍显示 active;释放进行中到达的 send 先等释放完成,再走重连,同一会话不会有新旧两个进程同时挂在同一远端会话上。并发 close 共用同一次释放(2026-11-04 资源审计 P2-1 修订:原先释放一开始就移出活跃表,EOF 收尾窗口内的 send 会立即 spawn 新进程去 load 同一会话);
- 环境:沿用官方凭据清洗 + 显式 env 叠加。

修订(2026-11-04,D17,后台任务模式):
- 单飞不变:同一会话已有在途轮(即它的 job 仍在跑)时,新 send 在**注册 job 之前**就作为工具错误拒绝,不生成第二个 job;
- 取消入口增加 `job_kill`(以及属主 agent 销毁时注册表发起的取消):两者都走上面的取消条——本地立即结算 `aborted`、尽力 `session/cancel`、作废连接、注册表保留;job 结束为 `killed`;
- 后台模式下工具调用自身的取消信号不再作用于这一轮(工具在返回 jobId 时已结束,轮归 job 所有);同步降级模式仍按原条执行;
- 失败轮、降级注记、close 语义不变;降级注记成为 job 输出的第一行。

修订(2026-11-25,与 D31 的关系):D31 的就绪检查与改派只作用于新建会话(`acp_chat_start`)和角色的首次供给。已有 chat 的 send、空闲释放后的重连(`session/load` / `thread/resume`)、steer 都不经过就绪检查，按注册表里记录的后端与本条的降级规则处理;检测结果变化(例如 Kiro 后来装上了)不会把已有 chat 换到别的后端。D6 降级(协议级会话不存在，或连续 3 条 `error`)为 Codex 后端新建线程时，只使用该后端配置里显式写的 `model`;自动发现的 Codex 没有显式模型，因此不传模型，沿用 app-server 的默认，与 D31「重连自动发现的线程不传新默认模型」一致。就绪服务通过检测得到的默认模型只用于 `acp_chat_start` 的新建。

## D7 session/load 参数形状(2026-11-03 实测)

kiro-cli 2.29(v2 引擎):`session/load {sessionId, cwd, mcpServers:[]}` 实测可用;`session/list` v2 无(v3 才有)。重连必须回放原 cwd。
后果:注册表存 cwd;发现远端会话列表依赖 kiro 自身(`kiro-cli chat --list-sessions`)。

## D8 测试豁免:真实子进程类 24 例(2026-11-04;2026-11-09 统一为 24)

依据:官方测试直读包内 `src/spawn.ts`,npm 分发包不含该模块;相关行为(销毁梯子/环境清洗/进程退出细节)阶段二不修改,由官方仓库测试覆盖。
后果:`spawnSubprocess` 导入失败的 24 例豁免(原文写 25,与 D16 修订及 AGENTS.md 不一致,2026-11-09 统一为 24);42 个协议面用例为有效回归面。

修订(2026-11-04,D16):豁免经条件导入官方 checkout 的 `spawn.ts` 恢复(路径默认按 `~/Developer/open-source-projects/deepseek-harness` 探测,可用 `DSH_OFFICIAL_CHECKOUT` 覆盖),24 例重新纳入回归面;checkout 缺席时这 24 例自动跳过。全绿基线 131(协议面 67 + connection 23 + pool 29 + tools 12)。

修订(2026-11-09,D2):官方 checkout 已切到 `dsh-v0.2.2-rc.1`;24 例真实子进程用例在该基线实际运行并通过。若 checkout 缺席，仍按本条自动跳过，不把跳过当作缺陷。

## D9 mock 服务器扩展 session/load(2026-11-04,实施第 3 步)

官方 mock 无 load 分支;扩展为内存会话表:load 命中恢复历史,未命中可配置报错/空,支撑池生命周期测试。

修订(2026-11-17,D24 实施):mock 不感知 backend 概念；不同 argv 与会话存储区使双后端的 session/load 场景隔离。注册表旧记录未带 `backend` 时按默认后端解释。

## D11 撤销 run.ts 消重重构,双实现并存(2026-11-04;2026-11-09 permission: ask 窄例外修订)

决策:第 2 步原计划"startAcpRun 重构为 openAcpConnection 薄包装"实施后回归退化 5 例,当场撤销,run.ts 恢复官方原版;connection.ts 作为池专用姊妹实现与官方驱动并存。
依据:官方测试对启动失败消息(`subagent-acp: Subagent failure ...`)与 prompt 失败分类有逐字断言,任何语义搬移都是回归面;"基线不动、增量在自有文件"是本包的立身原则,DRY 收益不抵风险。
后果:run.ts 与 connection.ts 存在受控重复(约 200 行语义同源);官方升级时 run.ts 面天然安全,connection 面自行维护;42+6=48 绿回归面继续有效。

修订(2026-11-09,窄例外):`permission: ask` 必须让 one-shot 路径把 ACP `session/request_permission` 转发到宿主 `ctx.userQuestions`，无法只在池专用 `connection.ts` 实现。因此允许 `run.ts` 在两处保持与官方副本不同：注入 ask 的权限决策器，以及 ENOENT 的固定行动指引；其余 one-shot 生命周期、协议处理、取消与销毁梯子仍逐字跟随官方。两项差异均有本包回归覆盖，禁止据此把 run.ts 重构、合并或扩展为通用分叉。

## D12 mock 会话表文件持久化(2026-11-04)

依据:跨进程 load 重连断言要求第二个进程能 load 第一个进程建的会话;内存表不够。MOCK_SESSION_STORE 落 JSON,MOCK_REMEMBER 以"回显上一条 prompt"提供上下文存活的可观测证据。
后果:mock 具备进程间记忆,connection.spec 的跨进程用例全绿。

## D10 kiro 侧会话积累(运维注记)

每次 new/load 均在 kiro 侧留会话记录;`acp_chat_close` 的工具说明中提示以 `kiro-cli chat --list-sessions` / `--delete-session` 清理。

## D13 工具注册条件化 + 包身份(2026-11-04)

依据:apply 默认注册工具曾硬依赖 `ctx.tools`,使无该服务的测试上下文(官方 spec setup)整体失败;可选服务必须 `ctx.get` 探测(仓库规则)。包 loader 名与 providerName 统一为 `acp-resume`(D1 独立身份),官方 spec 的两处名字断言随包身份适配。
后果:仅注册 provider 的场景(官方 spec)与完整宿主(工具齐)都成立;池清理挂 `ctx.effect` 注销器(fiber 拆卸释放进程,注册表保留)。
修订(2026-11-04,D16):`ctx.get` 一次性探测改为 `ctx.inject(['tools'], ...)` 响应式注册,条件化目的不变,补上 tools 服务晚到或重载的情形。

## D14 试用前评审修复(2026-11-04)

按 cordis-styling-nitpicking 方法从插件入口全面审查后的修复,均补回归用例:
- **P0 重连窗口并发泄漏**:busy 标记原在 await 之后,释放态两个并发 send 会建立两条连接并覆盖丢失一条;现在重连前经 starting 占位,并发 send 在窗口期即被拒。
- **P0 取消标志污染后续轮**:连接级 cancelled 标志原不复位,一次取消后同连接所有后续轮误判 aborted;每轮结算后复位。
- **边界:取消轮迟到流式块污染下一轮**:ACP 更新无轮标识,管道级交错使轮隔离不充分;池的对策=取消后作废连接(官方 one-shot 对取消同样以进程终结回应),下次 send 经 session/load 干净重建。回归用例以同文本发送使断言与远端竞速无关(取消不承诺副作用落地)。
- **P1 cwd 校验前移**:pool.start 复用官方 assertUsableCwd,fail loud 最早点。
- **P1 启动清理失败上报**:不再静默吞 dispose 失败,经 onError 上报。
- **P1 拆卸次序**:disposeAll 先停准入、等待在途轮结算、再释放进程(fiber 卸载的 effect 注销器返回被 await 的 promise)。
- **P2 purge**:close 工具增 purge 参数,pool.remove 释放进程并删注册表条目;工具文案泛化 kiro 提示。
已知限制(记录):注册表为单写者设计,多宿主进程共享同一路径无文件锁(单机单人场景);chatId 为工具边界字符串(模型 JSON 边界已由 schema 校验)。

## D15 可见性走自绘侧栏面板,不走子智能体目录(2026-11-04)

依据:用户要求按会话聚合显示(续聊不累加)。查证:目录条目单位是 child,child 复用通道(保留 childId/prepareContinuable)硬绑本地后端(`reserved child ids require a local backend`),外部后端每次 startExternal 新建 child——轮即 activation 会致十轮显示"10 个子智能体";跨轮复用 run id 违反 SubagentRun.id 唯一性契约。右侧栏是公开扩展面(官方 ui-subagent 侧栏聊天同位示例;dat-lequoc/dsh-kiro 的设置页为第三方带 UI 先例)。
决策:采纳 B——自绘"持久会话"页签(只读视图 + 释放/删除操作,不含输入框);完整设计与交互见 PANEL-DESIGN.md。
后果:目录与工具显示语义各归其位;未来官方 continuable ACP 落地后可评估切换官方目录,面板数据源(池注册表)可平移。

修订（2026-11-25，D35）：持久会话关闭时保留侧栏入口和已保存的详情地址。列表与详情正文显示关闭提示，详情标题显示短会话号，三处均停止订阅业务数据源。

## D16 六维评审与修复记录(2026-11-04)

评审方式:多个 kiro 会话并行从六个维度审查 src/,结论以变异实验(故意改坏代码看测试是否变红)和探针脚本实证,不凭读代码下结论。

必修项与修复(池语义的最终表述以 D6 为准):
1. **拆卸链**:`disposeAll` 先停准入,再等进行中的重连窗口,再关闭全部会话;重连窗口里新建的连接不再漏关。插件 fiber 的注销器返回 `disposeAll()` 的 promise,宿主卸载时会 await 它。
2. **降级分类**:原先任何 load 失败都降级新会话,会把"进程没起来"误判成"会话丢了"并覆盖注册表;现在只有协议级 load 拒绝才降级,其余失败让 send 报错、注册表不动。
3. **取消丢失**:两处取消会被漏掉:send 开始前信号已触发(只挂了监听器,不会再触发);轮失败后等待进程退出信息期间到达的取消(被判成 error)。现在两者都归本轮,结算为 `aborted`;取消照旧在本地立即结算,不等远端回应 `session/cancel`。
4. **error 轮作废连接**:与取消轮同样关进程,下次 send 重建,避免在坏连接上继续发。
5. **close 语义**:在途轮协作取消 + 最多等 `disposeGraceMs` + 释放;原先 close 不发取消直接拆进程,`disposeAll` 则无上限地等在途轮结算。
6. **工具错误面**:send 的轮不是 `completed` 时抛工具错误(官方约定:非 completed 即 isError),错误里带诊断首行摘录与已收到的部分输出;send/close 对未知 chatId 统一报 `unknown chat <id>; call <prefix>list ...`。
7. **降级注记前置**:降级时回答首行即注记(含固定短语 `remote session lost, started fresh`),失败轮的错误里同样带上,模型不会漏看。
8. **并发标注**:start/send/list 标并发安全,close 标独占(D6)。
9. **tools 服务响应式注册**:改用 `ctx.inject(['tools'], ...)`,tools 服务晚于本插件到达或被重载时都能正确(重新)注册;池挂在插件 fiber 上,tools 重载不杀会话进程。替代 D13 的 `ctx.get` 一次性探测。
10. **配置与注册表健壮性**:`idleTimeoutMs` 在 apply 入口校验(正有限数,不超过 Node 定时器上限);`registryPath` 须为绝对路径;注册表损坏时改名留证并经 `onWarn` 告警(D6)。

结构化错误契约:连接启动失败统一抛 `AcpConnectionError`,带 `stage`(`initialize` / `new-session` / `load-session`)、`category`(`protocol` / `transport` / `process-exit` / `process-start` / `unknown`)与可选 `jsonRpcCode`(远端 JSON-RPC 拒绝时的错误码)。`message` 只含固定安全事实,原始错误放 `cause`。spawn 本身抛错诊断为 `stage: initialize; category: process-start`。`code === 'ENOENT'` 的同步或异步 spawn 失败额外附固定英文行动指引，不回显用户的 command、PATH 或系统原始错误；`cause` 与 `onError` 仍保留原始错误。`permission: ask` 的服务缺席、无回答者、无效回答或取消统一回 ACP `cancelled`，不改变启动错误分类或将其误报为协议失败。池的降级判定只读这两个字段,不解析文案。

能力门控:`session/load` 前检查 `initialize` 响应的 `agentCapabilities.loadSession`,不为 `true` 即按 `load-session` + `protocol` 失败处理(从而降级新会话)。**已真机确认(2026-11-04)**:kiro-cli 声明 `loadSession`——0.1.3 装机后行为验证,SIGKILL 进程后 `session/load` 重连恢复暗号上下文且无降级注记(若未声明,门控必触发降级,注记必现)。

已知遗留(本轮不修):
- 注册表仍是单写者设计,多个宿主进程共用同一路径无文件锁(D14 已记)。

已修(2026-11-04):挂起的重连窗口卡死拆卸(测试阶段探针发现:load 永不返回时 `disposeAll` / `close` 无界等待),改为中止窗口 + `disposeGraceMs` 兜底(D6 close 条)。

## D17 send 走宿主后台任务(jobs)(2026-11-04)

问题:同步 send 把 kiro 整轮回答当工具返回值,agent loop 一直等它,kiro 跑多久这一步就卡多久。官方的长任务正道是 jobs 能力族(`packages/jobs/README.md:12`):工具把长任务注册成 job,属主 agent 不阻塞自己的回合,完成后在会话内收到通知。

依据(官方 checkout `my-subagent-acp` @ dsh-v0.2.1-rc.5 实读,路径相对仓库根):
- 注册形状:`ctx.jobs.start(spec)` 同步返回 `<kind>-<16 位 hex>` 的 id(`packages/jobs/jobs/src/index.ts:113`);`JobSpec` = `kind` / `label` / `owner?` / `toolCall?` / `output?` / `run(job) => JobHooks`(`packages/jobs/jobs/src/types.ts:179-213`)。`run` 在 `start` 内同步调用,抛错则什么都不注册。
- 所有权:生产方把 `exec.agent.id` 填进 `owner`,把 `{ callId: exec.callId, rootCallId: exec.rootCallId }` 填进 `toolCall`(bash:`packages/shell/tool-bash/src/index.ts:272-273`;workflow:`packages/workflow/tool-workflow/src/index.ts:276-279`)。其他会话对该 job 的 get/read/kill 一律抛错(注册表按 owner 设防,`jobs/src/index.ts:62-63`)。
- 增量输出:`JobHandle.append(text, { channel? })` 推送进该 job 的输出环(`types.ts:139-155`);不带 channel 的块模型可见,`log` 通道只给观察者(`packages/jobs/tool-jobs/src/render.ts:75-84`)。`job_output` 先给自上次读以来的增量,结束后再附一次 `JobOutcome.result`(`tool-jobs/src/index.ts:184-191`)。
- 完成通知:tool-jobs 订阅 `settled` 事件,忙时注入下一步、闲时唤起新回合(`tool-jobs/src/index.ts:272-308`);通知正文只有状态行加 "Read its output with job_output"(`:126`),不带结果本身。
- 取消:`job_kill` → `jobs.kill(id, caller, reason)`(`tool-jobs/src/index.ts:403`)→ 生产方的 `JobHooks.cancel(reason)`,该函数须同步、幂等,且最终让 `done` 结算(`types.ts:158-171`);bash 的接法见 `tool-bash/src/index.ts:287-290` 与 `src/background.ts:99-129`,workflow 见 `tool-workflow/src/index.ts:310`。
- 前提:没有 job 控制器服务该 owner 时 `start` 拒绝(`jobs/src/index.ts:72-74`);控制器由 tool-jobs 加载时挂上。
- 容量:jobs-local 每个 job 运行期保留 256 KiB 输出,结算时模型未读的字节不裁(`packages/jobs/jobs-local/README.md:44-46`,`jobs-local/src/index.ts:628`)。

决策:
- **流式**:kiro 的 `agent_message_chunk` 文本逐块 `append` 进 job 输出(不带 channel,模型可见),模型等待期用 `job_output` 能看到进展;不再另给 `result`,否则结束后的读会把整段回答再给一遍。各次读拼起来就是完整回答,与同步模式的返回文本相同;降级时注记是第一行,空回答时写入 `(agent returned no text)`。为此 connection 的 `prompt` 加可选文本观察者、pool 的 `send` 加可选 hooks(`onText` / `onFreshSession`),两者都把观察者抛错吞掉。
- **结局映射**:`completed` → `completed`;`aborted` → `killed`;`error` / `max-tokens` / `refusal` / 其他 → `failed`,detail 为原工具错误的首行(如 `the agent ran out of room before it finished its answer`)。send 本身失败(重连失败等)→ `failed`,由 job 自己的取消引起时为 `killed`。`done` 永不 reject。
- **所有权与调用标识**:按 bash 姿势,`owner` 取 `exec.agent.id`(无 agent 时为无主 job),`toolCall` 取调用标识。kind 为 `acp-chat`,label 为 `<会话 label 或 chatId>: <消息首行,至多 60 字>`。
- **单飞与前置检查**:新增 `pool.assertSendable(chatId)`,同步复核 send 会给出的拒绝(池已销毁、未知会话、在途、注册表记录属于另一 agent 命令)。工具先做这项检查再 `jobs.start`;`run` 在 `start` 内同步调用 `pool.send`,而 send 在第一个 await 之前就占住会话,检查与占用之间没有可插入的空档(同一步里并行两个 send 到同一会话,第二个是工具错误)。注册表拒绝(无控制器、属主 job 数达上限)同样作为工具错误抛出,不降级为同步执行:上限报错本身告诉模型去 kill 或等待,自动转同步会让卡顿换个地方复现。
- **不加 `wait` 参数**:官方 bash/workflow 都是默认前台、`run_in_background` 选择后台;本包按需求反过来默认后台。需要内联等待时,`job_output` 的 `wait: true` 就是官方的阻塞原语(上限受 tool-jobs 配置约束),再加一个 `wait` 只是第二条做同一件事的路径。(2026-11-06:D22 起,对运行中 acp-chat 任务的 `wait: true` 默认被拒,结果只走完成通知。)
- **接线**:与 bash 相同(`tool-bash/src/index.ts:546-555`):tools 作用域内,无 `ctx.jobs` 时注册同步 send;jobs 到达时换成后台 send;jobs 离开而 tools 仍在时换回同步。start/list/close 不随之变化。
- **降级**:无 jobs 服务的上下文(官方 spec 的 setup、未装 jobs-local 的宿主)保持原同步语义与原工具说明,既有用例不变。
- **依赖**:`@deepseek-ai/dsh-jobs` 进 peer + dev(当前 D2 基线 `~0.2.2-rc.5`),peer 标 optional:源码只做类型导入,构建产物不在运行时引用它(`lib/*.js` 中无该包名);`@deepseek-ai/dsh-jobs-local` 只进 dev(测试用真注册表)。

后果:模型发出 send 后可继续工作,回答经完成通知 + `job_output` 取回;面板不受影响(数据源仍是池注册表,PANEL-DESIGN.md 不动)。已知边界:会话正处于释放中(空闲释放刚触发)时 send 要先等释放完成才占住会话,这一小段窗口内同会话的第二个后台 send 能通过前置检查,随后它的 job 以 `already has a prompt in flight` 结束为 `failed`,不会产生第二条连接(2026-11-04:此描述自 D6 释放条 P2-1 修订起成立;此前释放一开始就移出活跃表,第一个 send 不等待直接重连)。

已知差异(2026-11-04 资源审计 P3-1,不修行为,只记录):拆卸引起的 job 结局文案不统一。插件卸载、jobs 服务卸载或属主销毁时轮在途,job 为 `killed`,detail 是 `the agent stopped before finishing…`,读起来像 agent 自己停下;卡在重连窗口时被插件卸载,job 为 `failed: acp-resume: pool already disposed`;被面板/工具 close 或 purge 打断重连窗口,job 为 `failed: …was released before the prompt started`。三者都是安全失败(进程已释放、`done` 已结算),区别只在给模型的说法。

## D19 默认切 kiro v3 引擎 + 插话工具 `acp_chat_steer`(2026-11-04)

问题:kiro-cli 已升到 2.37.1。v2 默认引擎下,会话进行中再发 prompt 会被拒("Prompt already in progress"),模型没有办法在长任务跑到一半时补一句指示;只能 `job_kill` 重来。同时想用上 v3(KAS 引擎)。

依据(全部真机实测,kiro-cli 2.37.1):
- `--agent-engine v3` 启用 KAS 引擎,`initialize` 声明 `sessionCapabilities{list,close,delete,fork}`。
- 私有扩展请求 `_session/steer {sessionId, message}` 在 v2 / v3 都能用:v3 返回 `{queued:true, messageId}`,且回答流里出现 `[STEERING <id>: …]` 归因块。两个引擎的 `initialize` 都**不声明**它,ACP 规范里也没有 steer——所以只能按「方法是否存在」试探,不能按能力声明判断。
- **v2 创建的会话可被 v3 `session/load`,上下文完好**(实测)。这是引擎默认值可以直接切、不会让旧会话作废的前提。

决策:
- **`agentEngine` 配置**:`v1 | v2 | v3`,默认 `v3`。启动子进程时在 args 末尾追加 `--agent-engine <值>`;池的 `specBase` 与 one-shot provider 两处都追加。用户的 `args` 里已含 `--agent-engine`(含 `--agent-engine=v2` 写法)时不追加,以用户显式为准。已知限制(2026-11-09 已解除,见文末修订):原先不认这个旗标的 agent 没有关闭追加的开关。
- **指纹放宽(修订 B12/D16 的重连校验)**:重连时 `command` 仍须严格相等;`args` 比较前**剔除 `--agent-engine` 及其值**(两种写法),其余差异照旧拒绝。理由:会话跨引擎可加载已实证;若某个引擎确实读不了,`session/load` 会被协议级拒绝,自然走 D6 的降级新会话兜底(注记照旧),不需要在指纹层提前拦。注册表记录的 args 含追加后的旗标,旧记录(无旗标)与新配置比较时同样等价。
- **`acp_chat_steer(chatId, message)`**:
  - 连接层 `AcpConnection.steer(message)` 对活连接发 `_session/steer {sessionId, message}`;`-32601 Method not found` 抛 `AcpSteerUnsupportedError`(按类识别,不解析文案);其他错误原样上抛。应答里 `queued` 缺省按 true 处理(请求成功即被接受),`messageId` 有则透传。
  - 池层 `steer(chatId, message)` 要求会话有活连接且有在途轮(`busy`);否则报「没有在途轮,无可插话,改用 send」。未知 chatId 与 send/close 同格式。steer **不占轮、不改 busy**,同一会话可连续多条,先后顺序由 kiro 侧排队,因此不与 D6 的单飞冲突。
  - 工具层标并发安全。成功返回 `queued`(有 `messageId` 一并给出)。说明文案写明:排队的插话在下一个工具/消息边界生效,不打断当前步;要立即停止用 `job_kill` / `acp_chat_close`。agent 不支持时抛「当前 agent 不支持插话」类工具错误,并提示改为等待或停止后重发。
  - 修订(2026-11-18,多后端后文案中性化):模型可见的工具说明与报错不提协议方法名和引擎版本。说明写 `Requires a backend that supports mid-turn steering`,不支持时报 `this backend does not support mid-turn steering; …`。连接层仍按 `_session/steer` 与 `-32601` 判定，机制不变。
  - 与后台 job 并存:steer 不创建 job、不改 job 状态,在途 job 照常结算;插话在输出流里留下的归因块算作 agent 的回答文本,原样进入 job 输出(形态由 kiro 决定,本包不解析)。
- 不做:不为 steer 增加「自动探测并缓存支持情况」;每次调用直接试,失败即降级文案,避免缓存过期。

后果:`acp_chat_*` 工具从四个变五个;kiro 新建会话默认走 v3 引擎(`--agent-engine v3`),旧会话继续可续;测试 172 → 188(steer 5、engine 7、pool 指纹放宽 3、jobs 并存 1)。未验证:真机 v3 引擎下 `session/prompt` 的流式分块与 v2 的差异(本包的 mock 无法覆盖),留待装机冒烟。

修订(2026-11-05,显式钉模型/档位):
- **新增 `model?` / `effort?` 两个可选 Config 字段**。v3 的 ACP 会话默认 `model=auto`(服务器按任务路由,`effort` 不可控);用户要求能显式钉死。CLI 已支持 spawn 级 `--model <id>` 与 `--effort <level>`,作用于该进程启动的会话;本包一会话一进程,语义干净。schemastery 3.18.5 下不写 `.required()` / `.default()` 的 `z.string()` 即可选,缺省时结果里不出现该键,因此只有用户显式设了才拼旗标,否则保持 `auto`。
- **argv 拼接与 `--agent-engine` 同款**:两条 spawn 路径(池 `specBase` 与 one-shot provider)在用户 `args` 未显式含 `--model` / `--effort`(`--model x` 与 `--model=x` 两种写法都识别)且 Config 有值时追加;用户显式写了则不追加。空串按未设处理。
- **生效语义是 spawn 级**:对既有会话,钉死的模型/档位要等下次重连(新进程)才应用,运行中进程不变——文档与 Config JSDoc 都写明这点,避免用户误以为改配置能即时切活跃会话的模型。
- **指纹排除清单扩为三旗标**:重连指纹比较时剔除的从 `--agent-engine` 扩到 `--agent-engine` / `--model` / `--effort`(各自的分离与 `=` 写法及值)。理由:`auto` 本身就在会话内按任务动态换模型,会话存的是对话不是模型;模型/档位差异不像 `command` 差异那样构成"换了一个 agent"。实现上原 `stripAgentEngine` 泛化为 `stripVolatileFlags`;追加逻辑泛化为 `buildChildArgs(args, {engine, model?, effort?})`。(2026-11-05 精简:`stripAgentEngine` 别名与 `withAgentEngine` / `hasAgentEngineFlag` 两个薄封装为零生产引用的死导出,已删除;生产只用 `buildChildArgs` / `stripVolatileFlags`。engine.spec 的两例改以这两个活函数直接断言,等价覆盖、例数不变。)
- 测试 188 → 266 的其余增量含本轮 7 例(engine helper 2 + 两条 spawn 路径 4 + pool 模型/档位指纹 1;其余为上游其他改动)。
- 2026-11-25 补注(D34):`modelSelect: session` 时 `--effort` 与 `--model` 一样不再追加，强度改为建会话/重连后的 `session/set_config_option(effortLevel)`;`modelSelect: flag` 的旗标语义不变。变异自检:model/effort 不追加、指纹漏剔、忽略用户已设旗标、空串当有效值、one-shot 路径漏拼、指纹剔除过头——六类故意改坏均被测试抓红。

修订(2026-11-09,`agentEngine` 可显式关闭追加):
- 问题:原语义下,只要 `args` 里没写 `--agent-engine`,每次拉起子进程都会追加 `--agent-engine v3`,没有关闭途径(上文"已知限制")。非 kiro 的 ACP agent 不认该旗标,多半因未知参数退出,导致"换 `command` 即可换 agent"并不成立。发布前修掉。
- 决策:`agentEngine` 取值从 `v1 | v2 | v3` 扩为 `v1 | v2 | v3 | none`,**默认仍为 `v3`**,用户不动配置时行为不变。`none` 表示完全不追加。选 `none` 而不是新增布尔字段,是因为 schemastery ~3.18.5 的 `z.union([...] as const).default(...)` 已是该字段的既有写法,一个字段表达"选哪个引擎或不选",不会出现 `agentEngine: v2` 与"关闭"两个字段互相矛盾的组合。
- 实现:`engine.ts` 新增类型 `AgentEngineSetting = AgentEngine | 'none'`,`buildChildArgs` 对 `'none'` 跳过 `--agent-engine`;`AgentEngine` 本身不变。两条 spawn 路径(池 `specBase` 与 one-shot provider)共用 `buildChildArgs`,因此同时生效。`--model` / `--effort` 的追加不受影响。
- 与用户 `args` 的关系:`none` 只管"是否追加"。用户自己在 `args` 里写的 `--agent-engine`(两种写法)照常原样传给子进程,不会被删。
- 指纹一致性:重连指纹比较仍用 `stripVolatileFlags` 剔除 `--agent-engine` 及其值,不区分该旗标是追加的还是用户写的。关闭态下注册表记录的 args 不含旗标,与此前记录(含追加的旗标)或之后改回 `v3` 的配置比较时,剔除后都相等,不会因切换 `agentEngine` 而拒绝旧会话。
- 测试:engine.spec 增 3 例(helper 的 `none` 一例、池路径 `none` 的实际 argv 一例、one-shot 路径 `none` 的实际 argv 一例)。
- 未验证:没有在真实的非 kiro ACP agent 上实测过关闭态;只验证了不追加旗标。

## D18 按轮日志 + 会话详情页签(2026-11-04)

问题:v1 面板只有卡片(状态/摘要/轮数/释放/删除),看不到一个会话里到底发生过什么。注册表只存 `turnCount` 与首轮摘要,没有逐轮内容。

裁定记录(2026-11-04,用户按研究推荐全选;研究见 PANEL-DETAIL-RESEARCH.md,界面规格见 PANEL-DESIGN.md §2.6):
1. 详情形态:**资源地址页签,不注册 provider**(方案 A)——地址 `dsh-resource://acp-resume-chat/<chatId>`,类型声明 `patterns`,数据由包内按会话的数据源拉取;
2. 数据:**自落轮次日志**,注册表不动;
3. 入口:**整张卡片可点**;
4. 展开状态:**组件内状态**(切走页签再切回会合上);
5. 在途轮实时文本:**留 v3**。

决策与细则:
- **日志文件**:`<registryPath 的父目录>/turns/<chatId>.jsonl`,只追加,一行一条 JSON。两类记录,共用每会话递增的 `seq`(从 1 起,裁剪后不复用):
  - `turn`:`startedAt`、`at`(结算时刻)、`message`、`output`(回答文本)、`stopReason`(completed / aborted / error / max-tokens / refusal / …)、`freshSession`、可选 `diagnostic`;每个 `completed` 之外的结局也记。
  - `event`:`session-lost`(`session/load` 被协议拒绝,新开远端会话顶替;随后同一次 send 还会记一条 `freshSession: true` 的 `turn`)、`session-reset-after-errors`(当前池实例同一 chat 连续 3 条 `error` 轮后，下一次 send 主动跳过 load、新开远端会话；它不是 `session-lost`，不表示 load 被拒绝)、`reconnect-failed`(send 在 prompt 发出前失败:load 的非协议类失败、进程起不来、已记录的 agent 指纹与当前配置不符;带上未发出的消息与错误文案)。拆卸引起的中止(`was released before the prompt started`)与池已销毁不记。
- **不记的**:steer(不是轮)、send 在做任何事之前就被拒绝的情形(未知会话、在途、信号已中止)、启动(start)。
- **写入点**:`AcpSessionPool.send` 的轮结算处(紧跟注册表更新,因此 jobs 与同步两种 send 都覆盖,tools.ts 不改)与重连窗口/失败处。写之前复查注册表里该会话还在,与"结算前 purge 不得复活记录"同一条规则,所以 purge 之后不会留下孤儿日志。
- **与 D6 / D17 的边界**:注册表字段与版本不变;单飞、取消条、空闲释放、释放时序全部不动。两种降级分别为协议级 load 拒绝与当前池实例连续 3 条 `error` 后的主动新会话；后者的计数只存内存、重启从 0 开始，`session-reset-after-errors` 与 `session-lost` 分别记录两种原因。日志写失败**只经 `onWarn` 告警,绝不改变轮的结果**(同 D6 "轮结果优先于拆卸失败");`purge` 在删注册表条目后删日志文件,删失败只告警;`close` 保留日志。
- **容量**:单条上限——`message` 8192 字符、`output` 32768 字符(按码点截,不拆代理对,截断时记 `messageTruncated` / `outputTruncated`)、`diagnostic` 与 `error` 2000 字符;每会话保留最近 200 条,文件超过 400 条时用"临时文件 + 原子改名"裁回 200 条(条数在进程内计数,首次写入时读一次文件)。
- **容错**:读逐行解析,不能解析或形状不对的行跳过;进程崩溃留下的半行,下一次追加先补换行;`seq` 取文件中最大可读值 + 1。chatId 作文件名前校验(只允许字母数字与 `._-`,首字符为字母数字),不合法则告警并不读写,防路径逃逸。
- **host 读接口**(`AcpResumePanelService`,与 list/close/purge 同款 source 模式,参数自校验):`turns(chatId, limit?)` → `{ chat, entries, total }`,`entries` 是最近 `limit` 条(默认 50,上限 200)的**预览**(message / output 各至多 120 字,附 `messageMore` / `outputMore` 标志),`chat` 是该会话的注册表行,所以详情页一次调用拿全;`turn(chatId, seq)` → 单条全文。未知会话 `acp-resume/unknown-chat`(同现有错误码),日志里没有该 seq `acp-resume/unknown-turn`(新),参数非法 `gateway/bad-request`。与研究 §3.4 的偏差:研究草图写的是 `detail / turns(before, limit) / turn`;实施时合并 `detail` 进 `turns`(省一次往返),并把分页改成只给 `limit`(加载更早 = 提高 `limit`),因为 5 秒轮询每次整体重取,游标会和裁剪、追加互相竞争。
- **client**:新增页签类型 `acp-resume.chat`(`id: dsh-acp-resume/chat`),`patterns: ['dsh-resource://acp-resume-chat/**']`,`canOpen` 校验地址,不设 `priority`(默认 extension)、不设 `multiple`、不进引导页;正文与 chip 标题各占 `sidebar.right.pane.tab` / `.title` 槽位。同一地址聚焦已有页签,关一个不影响其他,刷新后凭持久化的地址恢复。`ChatDetailSource` 每个 chatId 一个、正文与标题共用,有订阅者才每 5 秒轮询;答 `unknown-chat` 时发布 `gone` 并停轮询。列表卡片 `onClick` 打开详情,释放/删除按钮 `stopPropagation`,标题是真按钮以支持键盘。client 依赖面不变(`inject` 仍是 `slots / locale / sidebarRightTabs`,另有 `connection` 的响应式等待)。
- **隐私**:日志以明文保存发给外部 agent 的消息与回答,和 kiro 自己的会话存储同级;`purge` 随记录一并删除。v2 不提供关闭开关(用户未要求);若需要,加 Config `recordTurns` 即可,是纯增量改动。
- **兼容**:旧注册表、旧会话无日志,详情页显示空历史占位,不迁移;降级回 v1 后日志文件被忽略;新 host 配旧 client 无影响(只多两个没人调的方法),旧 host 配新 client 时详情页显示读取失败条而列表不受影响;`PooledChatInfo` 不变。

后果:池多一个 `TurnLog` 成员与 `chatInfo` / `turnEntries` 两个只读方法;面板 host 半 3 → 5 个 Remote 方法;client 半新增 4 个文件;测试 192 → 259(见 AGENTS.md「期望测试基线」)。未验证:真机 GUI 中官方侧栏对第二个页签类型、chip 标题槽与"同地址聚焦"的实际表现(以官方源码与 jsdom 测试为依据,装机验收清单见 PANEL-DESIGN.md §2.6)。

D15 追注(2026-11-04):v2 增加会话详情页签,见 D18;D15 "只读视图 + 资源操作、不含输入框"的边界不变。

D15 修订(2026-11-17,在途轮可见):列表与详情页签额外投影当前池实例内每 chat 至多一条在途 prompt 的完整已发送消息和 `startedAt`；列表显示「进行中」与持续时长，详情将合成 `running` 条目置顶并由浏览器侧截断、展开全文。该信息只在 `LiveChat` 内存中存在，轮结算、关闭、purge、池重启后即消失；不写注册表、不写按轮日志、不计入 `turns.total`，D18 不变。未加入 agent 流式输出、思考、工具调用或面板内输入/取消；时长只按现有面板轮询节奏更新，不增高频刷新。

D15 修订(2026-11-17,D24 设计):多后端实施时，面板每行增加 chat 所属后端的中性徽标；仅一个有效后端时不显示。列表、详情页签、在途轮投影、轮次日志和资源操作其余语义不变，待 D24 获确认后实施。


D18 修订(2026-11-05,D21):轮询节奏由固定 5 秒改为自适应(5 秒 ↔ 静默退 30 秒),并要求数据源快照引用稳定;详见 D21。数据/工具语义不变。

修订(2026-11-18,状态点五态与列表统计):面板与详情页的状态点改用官方 `StateDot`,按优先级分五态:`ongoing`(有轮在途，官方转圈)>`error`(最新日志条目是 `error` 轮或 `reconnect-failed`,红)>`warning`(最新条目是新会话作答的轮或换新会话事件，橙)>`idle`(进程在、无在途轮，官方 `done` 绿)>`released`(官方 `idle` 中性灰)。注意力高于存活：`error` 轮会释放进程，若按存活排序，红点永远看不到。注意力由池在 `listChats` 时从按轮日志最新一条派生(`attention` 投影字段，日志读取按文件戳缓存，每次轮询每会话一次 stat),注册表结构不变，日志仍只是镜像。面板头部加「N 进行中 · N 空闲 · N 已释放」统计行;活跃会话超过 5 条时其余折叠在「展开全部(N)」之后，已释放分组不变。
修订(2026-11-18,对齐官方 Team UI 的颜色与密度):绿色只表示「完成」。状态点改为 `ongoing`(在途)>`error`>`warning`>`done`(进程在且最新日志条目是正常完成的轮，绿)>`idle`(进程在、无完成记录，官方 `idle` 灰)>`released`(官方 `idle` 的空心 `step` 样式，比空闲更弱)。池投影新增 `lastCompleted`(最新条目是 `completed` 且非新会话作答的轮)。活跃组超过 6 条才折叠(折叠按钮自占一行，只藏 1 条不省空间),折叠时显示前 5 条与「显示其余 N 个 / 收起」;展开状态存模块级变量，面板隐藏重挂不丢，重载复位。行上只留圆点、名称(label,其次首轮标题，再次短 id,单行省略)、后端徽标、在途时长与释放/删除按钮;「当前:…」、首轮标题、状态、轮数、最后活跃移入行的原生 `title` 悬停文本;cwd、远端 id 只在详情页，归属不再显示(严格本会话过滤下恒为本会话)。在途时长由每行独立的 1 秒本地计时驱动，只在有在途轮时挂载、只重绘该时长，基准为快照 `fetchedAt`,不增加 RPC;时长格式最多两个相邻单位(`3分12秒`、`1时5分`),详情页用同一格式，但只随轮询更新。

## D20 会话归属:默认发现面严格过滤,操作面不设访问控制(2026-11-05;2026-11-17 修订)

问题:持久 chat 注册表是 profile 级全局数据。用户要让模型工具和侧栏默认只发现当前 DSH 会话创建的 chat，同时保留跨会话拿到 chatId 后继续操作的能力。

用户裁定(2026-11-17):发现面按 owner 会话严格过滤，操作面不做所有权校验。

决策:
- **归属采集与兼容**：`acp_chat_start` 从 `exec.agent?.id` 取得 `ownerSessionId`，传给 `pool.start`。注册表版本保持不变；旧记录缺失 owner 不迁移、不回填。
- **工具发现面**：`acp_chat_list` 固定只返回 `ownerSessionId === exec.agent.id` 的记录。无 agent 的 headless 调用退化为全量，避免无会话身份时误报空列表。旧记录在正常会话列表中不可发现。
- **面板发现面**：host `list()` 仍全量返回，浏览器半直接使用会话型 seat 的 `inject(sessionId)` 提供的当前会话 id 过滤卡片。无 sessionId 时不显示 profile 全局记录。面板不提供「全部」逃逸或额外 Remote；每张可见卡片显示 owner 前 8 位。
- **操作面不是权限边界**：`send` / `steer` / `close` / `purge` 不按 owner 检查。任何会话只要知道 chatId 就能操作它；池、工具和 host Remote 均不增加访问限制。

后果:owner 只控制默认发现性，不限制访问。测试覆盖工具的严格过滤、headless 回退、owner 输出和跨会话 send，以及侧栏严格过滤与 seat 会话 id 注入。

## D21 面板轮询降本:快照引用稳定 + 自适应节奏 + host 读缓存(2026-11-05)

问题:用户反馈"跑起来 CPU 需求挺高"。现场测量(用户提供,不复测):kiro/KAS 引擎空闲 CPU 可忽略——排除;插件 node 半不在 top 榜——排除;嫌疑集中在 DSH 渲染管线(Renderer + GPU helper + WindowServer)周期性重绘。

坐实的本插件可控病根:`chats-source` / `detail-source` 每 5 秒轮询后**无条件 `publish` 新对象**——`{status, chats, fetchedAt}` 每次新建,`chats` 每次 `[...].sort()` 新数组,且 `fetchedAt = now()` 必变。违反官方 client 反应式纪律(`packages/client/AGENTS.md`:observable 的 `getSnapshot` 在事实未变时须返回同一引用)。后果:`useSyncExternalStore` 每 5 秒判定"变了" → 面板整树重绘 → WindowServer 跟着重绘,形成每 5 秒一次的重绘脉冲,叠加动画即持续 CPU 占用。

修复(三层,全在本插件可控面):
1. **快照引用稳定**(`snapshot-equal.ts` + 两个源的 publish 守卫):响应到来后按字段逐 chat / 逐 entry 浅比较(小而扁平的 DTO,不是通用深比较)。内容等价则**保留上一次的快照对象**(连 `fetchedAt` 也不动——它只是相对时间基准,不该独自触发重绘),`publish` 不通知、引用不变;仅真实变化或 status 翻转才发布新引用。`fetchedAt` 从此标记"上次变化时刻"而非"上次拉取时刻",相对时间在静默期冻结,语义更准(数据确实没动)。
2. **自适应节奏**:默认 5 秒(`POLL_INTERVAL_MS`);连续 3 次(`QUIET_POLLS_BEFORE_BACKOFF`)无变化退到 30 秒(`IDLE_POLL_INTERVAL_MS`);任何内容变化、面板 close/purge 操作、detail 的 loadMore 都重置回 5 秒。与「刷新」按钮不冲突——刷新是一次即时 `refresh()`,不改节奏状态。轮询仍只在有订阅者(页签挂载)时运行,无订阅即停(沿用既有订阅门)。
3. **host 读缓存**(`turn-log.ts`):`read` 按文件 `mtimeMs:size` 缓存已解析 entries,文件未变返回**同一数组引用**(既省一次整文件 read+parse,又让 host `turns` 对未变日志回同构结果,配合第 1 层让 client 侧也不换引用)。`append`/`remove` 显式清缓存;外部改动经 stamp 不符自然失效。`list()` 是内存投影、无 IO,确认无需改。

收益依据(改前 → 改后,单会话单面板打开、池静默):
- 列表面板重绘:每 5 秒 1 次 → 内容不变时 **0 次**(仅首帧与真实变化时各 1 次)。
- 详情页签重绘:同上,每 5 秒 1 次 → 0 次。
- 轮询往返:5 秒一次恒定 → 静默期 30 秒一次(RPC 频次降至 1/6)。
- host 文件 IO:`turns` 每次整读 jsonl → 文件未变时 **0 次 read/parse**(命中缓存)。
- 不臆测 KAS/宿主渲染管线的绝对占用;本条只保证消除本插件产生的周期性重绘与冗余 IO。

后果:新增 `src/client/snapshot-equal.ts`;两个源加 publish 守卫与 backoff 状态;`TurnLog` 加 mtime 缓存;测试 281 → 295(client +10、turn-log +4,另含 snapshot-equal 单测)。行为对用户可见的唯一变化:静默期相对时间不再每 5 秒刷新(冻结在上次变化),有变化立即恢复。已知边界:mtime 缓存的 `append`/`remove` 显式失效与 `:size` 分量是针对"同毫秒同长度"极端情形的防御(单写者 + append 必增长的前提下通常冗余);真机 GUI 重绘脉冲消除待装机用 Activity Monitor 复测确认。

修订（2026-11-25，D35）：同一连接上的列表、详情和标题共享能力快照和在途查询。打开、手动刷新或连接重建时读取；不为能力查询新增定时器。

## D22 禁止 acp-chat 阻塞等待:结果只走完成通知唤醒(2026-11-06)

问题:宿主 tool-jobs 的 `job_output` 带 `wait: true` 时最长阻塞 600000ms(`maxWaitTimeoutMs` 默认值),而 acp-chat 一轮常跑十几分钟。模型反复顶格等待,期间用户的新消息排队,体感整段卡约 10 分钟。job 结算后 tool-jobs 本就会注入 "background job … finished" 完成通知并唤醒模型(D17),硬等没有必要。

机制(官方 checkout `my-subagent-acp` @ dsh-v0.2.1-rc.5 复核,路径相对仓库根):
- 工具派发前发瀑布事件 `tools/pre-execute`,监听者返回 `{kind:'deny', reason}` 即拒绝执行:工具本体不跑,模型收到 `Error: <reason>` 且 `isError:true`,对话可继续(类型 `PreToolDecision`:`packages/core/tools/src/index.ts:608-612`;deny 的呈现:`:1528-1539`)。
- 官方注册先例:`ctx.on('tools/pre-execute', async (exec, next) => …)`:`packages/experimental/hooks-codex/src/index.ts:228`(返回 deny 见 `:232`)、`hooks-claude-code/src/index.ts:244`、`experimental/auto-review/src/index.ts:684`、`packages/jobs/tool-jobs/src/index.ts:221`。
- `exec.arguments` 已解析,非法 JSON 时是原始字符串,须判型;`job_output` 参数名 `job_id` / `wait` / `timeout_ms`(`tool-jobs/src/index.ts:316-319`)。
- `jobs.get(id, caller)` 不推进读游标;未知 job 或非本会话 job 抛错(`jobs-local/src/index.ts:397-410`)。`caller` 取 `exec.agent.id`,与 tool-jobs 自身用法一致(`tool-jobs:154-160`)。
- 已结算 job 的 wait 立即返回、不阻塞(`jobs-local:500`)。bash 前台等待走 registry.wait、不经工具派发(`tool-bash:297-320`)。

决策:`src/job-wait-gate.ts` 的 `decideJobWait` 在 `scope.inject(['jobs'])` 内以 `tools/pre-execute` 监听器挂载。四个条件全满足才 deny:工具名 `job_output` 且有 agent;参数是对象、`wait === true`、`job_id` 为非空字符串;`jobs.get` 不抛错;job 的 kind 为 `acp-chat` 且状态为 `running`。`stopping` 放行(2026-11-06 评审修订):模型自己 `job_kill` 后宿主抑制完成通知,拒绝文案里「会收到通知」就成了假话;且 D6 下取消本地立即结算,`stopping` 极短暂,拦它没有收益。其余一律放行(返回 `undefined` 交给下一个监听者)。`get` 抛错(未知 id、外会话 job)放行,由 `job_output` 报它自己的错——不在门里猜。拒绝文案(`waitDeniedReason`)告诉模型:这是仍在运行的 acp-chat 轮,等待已禁用;不要轮询,结算时会收到会话内通知;本轮就此结束即算收集,通知前再无 wait 地读只会拿到空增量(压过 tool-jobs 系统提示里「最终回答前先收集」的倾向);可做独立工作或告知用户待定后结束本轮;通知后用不带 wait 的 `job_output` 读取;在此之前不要再向该 chat 发送。`acp_chat_send` 的工具说明与返回文本同步改为「不要等,完成会唤醒」。

边界:
- 只拦运行中的 acp-chat;已结算放行,其他种类任务(bash、workflow 等)完全不受影响。
- 依赖 tool-jobs 的 `completionDelivery` 保持默认 wakeup(完成通知唤醒)。若宿主把它改成不唤醒,模型要靠用户下一条消息或不带 wait 的 `job_output` 查询才会取到结果,体验会退化。[读官方代码得出,未在真机验证]
- 通知并非总会来:连续唤醒超过 tool-jobs 的 `maxConsecutiveWakes` 后通知静默;模型自己 `job_kill` 的任务不发完成通知(宿主抑制)。前者靠用户下一条消息或无 wait 的 `job_output` 兜底;后者正是 `stopping` 放行、且 kill 后可直接读的原因。[读官方代码得出]
- 单飞拒绝文本(pool)、`acp_chat_send` 描述、steer 降级文本一并去掉「wait for …」措辞,改为「结束本轮/等通知」,避免与门互相矛盾诱导死循环。
- 取舍:放弃「在本轮内拿到结果」,换「不阻塞用户输入」。需要同步语义的宿主(无 jobs 服务)仍走 D17 的内联 send,不受此门影响。
- 监听器内部不抛异常:`jobs.get` 包 try/catch,抛异常也会拦调用但文案不可控。

修订(2026-11-18,send 回执精简):后台模式 `acp_chat_send` 的成功回执只保留三件事:jobId、完成时会在会话内唤醒、在此之前不要再发给这个 chat。「结束本轮即算收集」「通知后用不带 wait 的 job_output 读」「用 job_kill 停止」只留在工具说明里，不再每轮重复。D22 门的拒绝文案不变。

修订(2026-11-20,拦截面扩展到 `wait_agent`):真机验证发现，模型拿到 `acp_workflow` 的 jobId 后调 `wait_agent`(30 秒、120 秒)等待，工作流要跑几分钟，两次都超时;原门只拦 `job_output` 的 `wait: true`。现在调用方会话有运行中的 `acp-chat` job 时(chat 轮与 `acp_workflow` 运行都用这个种类),门也拒绝 `wait_agent`。`wait_agent` 没有 wait 参数，调用本身就是阻塞等待，所以不看参数。判定用 `jobs.list(<调用方>)`,只看 `kind === 'acp-chat'` 且 `status === 'running'`;`list` 抛错、没有调用方、只有已结算或其他种类的 job 时放行。拒绝文案:`You have a running acp-chat job; end your reply instead of waiting — the completion notification will wake you.` 代价：这段时间里模型对真正的子代理调用 `wait_agent` 也会被拒，只能等通知唤醒;为避免卡住用户输入，接受这一代价。`allowChatJobWait: true` 时不注册监听器，两种拦截都不生效。

开关:`allowChatJobWait`(默认 `false`,即默认禁止)。设 `true` 时不注册监听器,恢复 `wait` 硬等。无 jobs 服务时本就不注册(与 send 变体的条件化一致)。

后果:新增 `src/job-wait-gate.ts`、`tests/job-wait-gate.spec.ts`(13 例,含经真实 `ToolRuntime` 派发的一例:拒绝时工具本体未跑、结果 `isError` 且以 `Error: Waiting on job acp-chat-` 开头(文案重构后));测试 295 → 308(评审修订补 stopping 放行一例,重挂载回归并入既有监听用例;send 文案锁定并入 jobs.spec 既有用例)。

(2026-11-06 注记)模型可见文案按描述层优化原则重构:正面协议优先(先说「完成会唤醒、再无 wait 读取」)、因果完整(说明机制而非只给禁令)、后果明示(wait 被拒、提前读只得 no new output)、冲突化解(带着运行中任务结束本轮即算已收集,对冲 tool-jobs 系统提示的「最终回答前先收集」)。涉及 `acp_chat_send` 描述与返回文本、`waitDeniedReason` 三处;描述里写作 `job_output with wait`(不含字面 `wait: true`,由文案锁定测试保证)。
## D23 permission: ask 转发宿主用户确认(2026-11-09)

问题:bundle 默认 `permission: allow` 适合 kiro-cli 开箱运行，但用户需要一个真实可用的收紧选项。此前 `reject` 只能自动拒绝，无法让用户逐次判断外部 ACP agent 的 `session/request_permission`。

决策:
- **配置与依赖**:`permission` 扩为 `allow | reject | ask`，默认仍为 `reject`，bundle 补丁仍为 `allow`。`ask` 通过可选宿主服务 `ctx.userQuestions`（`@deepseek-ai/dsh-user-questions`）向发起调用的活跃根 agent 提问；该服务或回答者缺席、调用者不是可交互根 agent、回答无效或服务报错时一律 fail closed，回 ACP `{ outcome: { outcome: 'cancelled' } }`，绝不自动允许。
- **请求映射**:每次 ACP 请求生成一个单选问题。标题优先用 `toolCall.title`，否则固定为外部 ACP 子代理的权限请求；正文列出 tool name、kind 和受限长度的文本内容项。ACP 每个 option 映射为唯一显示标签（保留 name、kind 和序号），闭包表将被选 label 精确映射回原 `optionId`；只接受该问题唯一、无 custom 的单选回答，其余回 cancelled。宿主按当前界面语言呈现问题文本与选项，插件不自行翻译用户提供的 ACP 文本。
- **等待与超时**:使用 `ctx.userQuestions.ask`，不使用会返回 `pending` 的 `askTimed`，因为 ACP 权限 RPC 必须在当前请求中得到 `selected` 或 `cancelled`。ACP 请求没有可读取的超时字段，插件不另造本地计时器；有可用回答者时问题持续等待，直到用户选择、调用取消、宿主/连接关闭或远端自身结束请求。服务缺席或拒绝立即回 cancelled，作为默认 deny；取消导致的 cancelled 不另加轮结果注记，沿用既有 aborted 语义。
- **取消、空闲与 jobs**:one-shot 的请求信号、同步 send 的工具信号及后台 job 的 job 控制器信号都传给问题。任一信号先取消即立即向 ACP 回 cancelled，并由现有 D6 取消条尽力 `session/cancel`、作废连接；迟到的用户回答被观察后丢弃。挂起问题属于在途 prompt，`busy` 保持为真且空闲计时器已清除，因此不会被空闲释放。后台 job 在用户回答前保持 running；D22 仍拒绝模型对运行中 job 的阻塞 `job_output wait:true`，完成通知才是收集结果的通道。
- **两条路径**:one-shot `run.ts` 与池的 `connection.ts` 都使用同一权限决策器。run.ts 的接入是 D11 记录的窄例外；connection 只在当前 prompt 存在 ask 决策器时转发，轮外或连接已取消的权限请求 fail closed。`allow` 继续选择第一个 allow-shaped option，`reject` 继续 cancelled，保持既有行为。

后果:新增 `dsh-user-questions` peer/dev 依赖与按调用临时绑定的权限决策器；ask 用户需要宿主已组合该服务和其界面回答者。测试覆盖 one-shot 与持久工具的允许、持久连接的拒绝与无回答者 fail-closed、既有 allow/reject 自动策略以及取消期间清理；所有路径只回传 ACP 原始 optionId，不把选项文本当授权事实。

## D24 多后端命名空间(2026-11-17,已实施)

### 动机

本插件需要同时接入多个 ACP agent 厂商。`kiro-cli` 是已实测的主力后端；Google Antigravity 的 `agy acp` 已完成握手实测，`initialize` 返回 `loadSession: true`，且 `sessionCapabilities` 含 `resume` / `close` / `load` / `list`。后续的 gemini-cli、opencode 也可按同型后端接入。

现状只有一个全局后端。切换 `command` / `args` 会让旧 chat 的远端会话号失去正确路由，形成孤儿记录；也无法让多个后端同时服务不同 chat。

前置事实已完成(2026-11-17，主会话协议直连探针):环境为本机 macOS 的 Antigravity ACP Server `agy` 1.5.9。`initialize` 返回 `loadSession: true`、`sessionCapabilities {resume, close, load, list, additionalDirectories}`、`promptCapabilities {image, embeddedContext}` 与 4 项 authMethods；两轮对话正常，回答分别为 `NOTED`、`5`，每轮约 2–3 秒。SIGKILL 后重生并以同一 sessionId `session/load`，暗号 `ZX-9427` 完整找回，历史保留。兼容性发现：`session/prompt` 只接受 `[{type:'text', text}]` 数组，字符串返回 `-32602`；`session/update` 通知嵌套在 `params.update`，`sessionUpdate` 位于 `params.update.sessionUpdate`，不同于 kiro 的平铺形态 `params.sessionUpdate`。另观察到自动会话标题 `session_info_update`、`usage_update(used/size, 1 MiB 窗口)`、`session/new.models.availableModels` 的 gemini-3.8-flash 系列和 `user_message_chunk` 回显。

修订(2026-11-17,实施裁定):注册表 `backend` 是字段加法，文件版本保持 1；读时缺省为 `default`，不迁移、不写版本 2，以免旧插件把新文件当损坏件搬走。`PooledChatInfo` 投影必有 `backend` 与有效后端数 `backendCount`；wire DTO 可选，徽标仅 `backendCount > 1` 显示，不新增 Remote。命名表禁止保留名 `default`，名称匹配 `[A-Za-z0-9_-]{1,32}`；每后端另有 `env`，叠加全局 env，凭据不跨后端泄漏。one-shot 固定默认后端，多厂商 one-shot 另行决策；后端重命名或删除使既有 chat send 明确失败，不迁移、不猜测回落。连接层仅对池路径归一化平铺/嵌套 update，run.ts 依 D11 不动。
- **配置形态，加法且向后兼容**：保留现有顶层 `command` / `args` / `agentEngine` / `permission` / `model` / `effort`，其语义变为**默认后端**。新增可选 `backends` 命名表；每个命名后端包含同一组 `command` / `args` / `agentEngine` / `permission` / `model` / `effort` / `env`，以及可选 `description`，后者可覆盖内置文案。`backends` 中出现一项即启用该后端，删除即关闭；不再增加独立 `enabled` 旗子。每个后端自行消化旗标策略与权限语义，不污染其他后端。
- **工具面自适应**：注册时从已解析配置计算有效后端。总数为 1 时，`acp_chat_start` **不含** `backend` 参数，工具定义与今日单后端版本逐字节一致。总数至少为 2 时，`acp_chat_start` 增加可选 string 参数 `backend`。其说明逐后端列出一行中性描述：用户 `description` 优先，缺省为“后端名 + command 基名”；禁止“实测充分”“推荐”等评价性或优先级措辞。其余四个工具不改变参数面。
- **chat 级绑定**：`acp_chat_start` 创建 chat 时选定后端。`chatId → backend` 终身绑定；`send` / `steer` / `close` / `list` 均按注册表保存的后端路由，不会因之后编辑默认后端而改写既有 chat。
- **注册表与兼容**：`RegistryEntry` 增加可选 `backend` 字段，注册表保持版本 1。旧记录缺字段时解释为默认后端，不迁移、不丢弃。重连既有的 `command + args` 指纹比较天然构成后端身份校验，无需另设身份机制。D9 的 mock 与跨进程 load 测试以不同 argv 和会话存储区覆盖。
- **池命名空间**：连接管理按 `(backend, chat)` 命名空间进行。每个后端有独立连接、空闲计时和配置投影；每 chat 单飞规则不变，不为跨后端新增排队或共享 busy 状态。
- **权限与旗标**：`permission` / `agentEngine` / `model` / `effort` 只读取 chat 所属后端的配置。Antigravity 一类把提问混入 `session/request_permission` 的语义，由该后端自身的 `permission`，例如 `ask`，天然隔离。
- **面板**：每条 chat 行增加所属后端的中性徽标；只有一个有效后端时隐藏该徽标。列表、详情页签、在途轮投影、轮次日志和资源操作的其他语义不变。
- **steer**：按 chat 所属后端调用；agent 不支持 `_session/steer` 时复用既有 `-32601` 降级机制。能力失败不污染其他后端，也不修改现有 steer 语义。
- **明确不做**：不修改 D6 或 D18；不在代码中按产品名硬编码 `kiro` / `agy` 分支；不增加流式输出展示或高频轮询。

### 后果与实施门槛

D24 已作为一项原子增量实现。验收覆盖：0.1.20 单后端 `acp_chat_start` 夹具逐字节一致；双后端 argv 路由、非默认后端 `session/load` 重连、两后端在途轮互不干扰；全量基线 343 绿。Antigravity 的多轮和杀进程 `session/load` 探针结果仅记录协议兼容事实，不构成产品支持承诺。

修订(2026-11-18,默认后端统一用可回传名):`PooledChatInfo.backend` 一律是 `start` 能接受的名字(默认后端为 `default`),展示用的友好名放独立字段 `backendDisplay`(默认后端取 command 基名，如 `kiro-cli`;命名后端即其名)。此前 `backend` 对默认后端给的是 command 基名，模型把 `kiro-cli` 传回多后端版 `acp_chat_start` 会报 unknown backend。面板徽标用 `backendDisplay`,旧宿主缺该字段时回落 `backend`。`acp_chat_list` 每行改为 `backend <名字> | <状态>`,状态为 `running (<本轮已跑时长>)`、`idle (<距上轮>)`(进程在、无在途轮)或 `released (…)`,不再统一写 idle;去掉 `owner <前8位>` 列(D20 已按本会话过滤，该列全是同一值)。多后端版 `acp_chat_start` 回执改为 `chat started: <chatId> (backend: <名字>, cwd: <cwd>); send messages with …`,输出结构加 `backend`、`cwd`;单后端版工具定义与回执逐字节不变。

修订(2026-11-25,与 D31 自动发现的关系):开启自动发现(`discoverBackends`,默认 `true`)时，候选后端至少有 3 个(默认后端加上自动发现的 Codex 与 `agy`,已配置同类后端的除外),`acp_chat_start` 因此总是多后端版(带可选 `backend` 参数)。本条「单后端版工具定义与 0.1.20 逐字节一致」的承诺，实际只在 `discoverBackends: false` 且没有配置命名后端时成立;对应的逐字节夹具测试也是在这个前提下跑的。

## D25 Codex app-server 私有协议适配器(2026-11-18,实施完成,mock 全绿,真机探针待做)

### 动机

Codex CLI 不说 ACP，而是用自己的 app-server 私有协议(stdio 上的 JSON-RPC，thread/turn/item 三层模型)。官方 `@deepseek-ai/dsh-subagent-codex` 只做 one-shot，没有 steer 和 resume。本决策把 Codex 接为持久池的第三个一等后端，走私有协议适配，换来 ACP 没有的原生能力：steer(插话不打断)、thread resume、分项审批。

### 协议事实(kiro 调研 + agy 调研 + kiro 核验,双引擎交叉验证)

- **通信**:stdio JSON-RPC 2.0，spawn `codex app-server`。握手为 `initialize {clientInfo:{name:'dsh-acp-resume'}}` 加 `initialized` 通知。
- **会话**:`thread/start {cwd, model, approvalPolicy, sandbox, ephemeral:false}` 返回 `thread.id`，落盘为远端会话号。重连用 `thread/resume {threadId, model, approvalPolicy, sandbox}`；SIGKILL 后实测可恢复。
- **ephemeral**:必须显式传 `false`。默认 `true` 不落盘，无法 resume。
- **轮**:`turn/start {threadId, input:[{type:'text',text,text_elements:[]}], effort?}` 立即返回 `turn.id`(inProgress)，结果靠通知流；终点是 `turn/completed {status: completed|interrupted|failed}`。
- **steer**:`turn/steer {threadId, input, expectedTurnId}` 向同一轮追加 userMessage，不打断正在跑的命令；必须传当前在途轮的 `expectedTurnId`。
- **取消**:`turn/interrupt {threadId, turnId}`，毫秒级。
- **流式**:`item/agentMessage/delta`，params 为 `{threadId, turnId, itemId, delta}`。最终输出取 `item/completed` 中 `agentMessage.phase === 'final_answer'` 的 `text`。
- **审批**:三套 `item/*/requestApproval`(命令/文件/权限)。`availableDecisions` 含 `accept` / `acceptWithExecpolicyAmendment` / `cancel`，不含 `decline`，但服务端接受 `decline` 回复：该条被拒、整轮继续；`cancel` 则整轮 interrupted。
- **模型**:`model/list` 返回 10 个(含 2 个隐藏)，由 `thread/start` 或 `turn/start` 的 `model` 参数指定。默认模型 `gpt-6.1-terra` 在当时的本机环境不可用，原先要求显式指定；D31 现按上游账号与默认模型信息自动验证，不再一律必填。
- **stopReason 映射**:completed→end_turn、interrupted→cancelled、failed→error、`codexErrorInfo === 'contextWindowExceeded'`→max-tokens。

### 架构裁定

- 新模块 `src/connection-codex.ts`，导出 `openCodexConnection(spec, open, signal?)`，返回与 `AcpConnection` 同形状的对象(prompt / steer / notifyCancel / dispose / remoteSessionId / processSettled / observeOutcome)；启动失败沿用 `AcpConnectionError` 的阶段与类别，池的降级规则(协议级 load 拒绝 → 新会话)原样适用。
- `pool.ts` 的 `BackendSpec` 增加 `protocol: 'acp' | 'codex'`，池按协议选 `openAcpConnection` 或 `openCodexConnection`。
- 不使用 `@agentclientprotocol/sdk`，自己实现按行 JSON-RPC 传输(参照官方 dsh-subagent-codex)。
- 审批映射独立成 `src/codex-approval.ts`；`permission: ask` 的宿主确认桥复用 `userQuestionPermissionResolver`(见下「审批层与 ask 桥」)。
- one-shot provider(`run.ts`)不改，Codex 只做持久池后端。D6 / D11 / D18 语义均不动。
- 每个 chat 一个进程，与 kiro / agy 池一致。`thread/loaded/list` 显示一个进程可承载多线程，本决策有意不用。

### Config

`BackendConfig` 增加 `protocol?: 'acp' | 'codex'`(默认 `'acp'`)。Codex 后端额外字段：`model`(当时因默认模型不可用设为必填；D31 改为可选)、`sandbox`(`read-only` | `workspace-write` | `danger-full-access`，默认 `read-only`)、`approvalPolicy`(`never` | `untrusted` | `on-request` | `on-failure`，默认 `never`)。Config schema 随池集成轮扩展。

### 连接层实施细节(第一轮)

- **审批自动决策**:`allow`→`accept`，`reject`→`decline`；`ask` 见下节。无桥、轮外到达、轮已取消的审批一律 `cancel`(fail closed)。未识别的服务端请求回 `-32601`，避免服务端空等。
- **轮隔离**:通知带 `turnId`，只处理当前轮的；`turn/start` 回复前到达的通知先缓存，拿到 `turnId` 后重放同轮部分。
- **输出**:流式观察者收到当前轮全部 `agentMessage` delta(含非最终的过程性消息)；结算输出取 `final_answer` 文本，没有则取 delta 拼接。因此两者在有过程性消息时不严格相等，与 ACP 连接的「拼接等于结算输出」约定有差异。
- **取消**:与 D6 一致，本地立即结算 `aborted`，并向远端发 `turn/interrupt`；`turn/start` 回复前取消，则在拿到 `turnId` 后补发。
- **steer**:无在途轮时抛普通错误；服务端 `-32601` 抛 `AcpSteerUnsupportedError`，复用既有降级。`messageId` 取返回的 `turnId`。
- **未经实测的形状**:`turn/completed` 的 `turn.status` / `turn.error.codexErrorInfo` 嵌套位置、`thread/start` 回复的 `thread.id` 位置，以及权限类审批的回复形状(本轮统一回 `{decision}`)，来自调研而非本机直连；解析已做容错，由 mock 与真机探针轮核验。

### 已知风险

- `decline` 不在 `availableDecisions` 里却被接受，依赖未文档化行为，Codex 升级可能失效；失效时 reject 策略退回 `cancel`(整轮 interrupted)。
- 默认模型不可用属环境问题(Codex 版本或账号)，适配器原先通过必填 `model` 规避；D31 改为验证 Codex 提供的明确默认值。
- 官方包针对 0.147.0，本机为 0.160.0，协议可能有小变化。
- 私有协议无稳定性承诺，升级 Codex 后须重跑真机探针。

### 池集成与 Config(第二轮,已实施)

- `BackendSpec` 增加可选 `protocol`(缺省即 acp)与 `codex {model, sandbox?, approvalPolicy?, effort?}`；`specBase` 不变，故指纹校验(command + args)与所有 ACP 路径原样。池内 `connect()` 按协议选 `openAcpConnection` 或 `openCodexConnection`，`start` / `reopen` 的三处打开点都走它。
- `BackendConfig` 增加 `protocol`(`acp` | `codex`，默认 `acp`)、`sandbox`、`approvalPolicy`，`effort` 对 Codex 即 `turn/start` 的 effort。三个新字段都是枚举校验，不是自由字符串。
- Codex 后端的 args 原样取用户值，为空则 `['app-server']`；不追加 `--agent-engine` / `--model` / `--effort`(Codex 没有这些旗标)。Codex 后端缺 `model` 时启动即报错。
- 只有命名后端(`backends`)可选 Codex；顶层默认后端恒为 ACP。
- mock:`tests/mock-codex-server.ts`(协议、环境开关见其头注)。

### 审批层与 ask 桥(第四轮,已实施)

- **复用而非重做**:Codex 的三套审批(`item/commandExecution|fileChange|permissions/requestApproval`)被翻成 ACP 形状的权限请求(选项 `accept` 允许、`decline` 拒绝该步并继续、`cancel` 取消整轮；标题与正文含命令、cwd、grantRoot、reason，文本截断)，交给既有 `userQuestionPermissionResolver`；所选 `optionId` 再映回 Codex 的 `decision`。D23 的问题映射、取消传播、等待语义原样适用，池每轮传入的 `permissionResolver` 同时服务两种协议。
- **选项受 `availableDecisions` 约束**:列表里没有 `accept` 就不提供「允许」；`decline` 与 `cancel` 恒提供(`decline` 依赖已记录的未文档化行为)。`acceptWithExecpolicyAmendment` 不提供：它会改写 Codex 的持久规则，超出一次性确认的范围。
- **fail-closed**:无桥服务、轮外审批、信号已取消、桥抛错、回答 cancelled 或回答了未提供的选项，一律回 `cancel`(整轮 interrupted)。挂起的问题随轮信号取消。
- **未经实测**:三套请求的字段名(`command`、`cwd`、`grantRoot`、`reason`、`availableDecisions`)与 permissions 类的回复形状来自调研，解析全部容错，缺字段只会让问题正文变短。

### 完成状态

连接层、池集成、Config、mock、审批层与 ask 桥、文档均已完成；测试基线见 AGENTS.md。**真机探针待做**：对本机 Codex 0.160.0 验证上述未实测的字段形状、`decline` 行为与 `thread/resume` 在 SIGKILL 后的恢复，结果回填本节。

## D26 ACP Dispatcher preset:可选的纯派工模式(2026-11-18)

### 动机

插件提供 ACP 工具(能力层),但用户有时需要一种纯派工模式(模式层):主 Agent 只做调度(拆任务、分配、收结果),不直接执行。DSH 原生有 agent preset(会话模式菜单里的预设),用它实现,由用户选择,不强绑。

### 设计原则:能力与模式解耦

- 装插件 = 所有模式都能用 `acp_chat_*` 工具。标准模式下可混用:自己跑 bash,或委派 ACP。
- 选 Dispatcher preset = 工具集里物理上只有 ACP 工具与任务管理工具(无 bash / fs / web / subagent),模型只能派活。
- 是否使用完全由用户决定。不选 preset,任何现有模式的行为不变。

### 实现

在包自带 `cordis.patch.yml` 的 `insert` 之后追加第二个 `- insert:`,定义 preset `acp-dispatcher`(名称 ACP Dispatcher,`order: 10`),引用 `@deepseek-ai/dsh-agent-preset`。preset 内含的插件:
- `persona`(调度者身份提示词)、`agent-instructions`(maxBytes 65536)、`time-context`;
- `subagent-acp-resume`(本插件);
- `tool-jobs`(后台任务收发)、`tool-todo`(`allowParallelInProgress: true`)、`tool-ask-user`(需澄清时问用户)。

### 不做

- 不新增 `acp_dispatch` 之类的快捷工具;现有五个工具足够,模型在 persona 指引下自然使用。
- 不改 `src/`,不改现有 preset。
- 不做后端自动路由;模型自己读工具描述选 backend(见 D24)。

### 已知风险(未验证,须真机核对)

- preset 在 DSH 里按 preset 单独挂载一棵插件树(读 `agent-preset-registry/src/mount.ts` 得出,未实机验证)。preset 内再声明 `dsh-acp-resume`,可能与 bundle 已全局挂载的同名插件并存:一是 `acp-resume` provider 重名(`DUPLICATE_PROVIDER`),二是两个插件实例各有一个池,同一注册表文件被两处写。若实测出问题,改法是去掉 preset 内的这一项,依赖全局实例提供工具,并确认 preset 工具白名单如何引用全局工具。
- preset 内的 `dsh-acp-resume` 不带 config,走插件默认值(`command` 缺省等),不继承 bundle 段的 `kiro-cli` / `permission: allow` 与用户顶层覆盖。
- persona 提示词为英文,与官方 persona 一致;中文用户通常不受影响,不另做本地化。
- 修订(2026-11-18,调度纪律):persona 去掉「用 acp_chat_list 跟踪进度」(会诱导轮询),改为「用 acp_chat_send 派工(记下 jobId)、等完成通知、用 job_output 收结果」,与 D22 一致;另加三条：目标目录不明确时先问用户再建 chat;同一 cwd 的多个 worker 写文件范围不得重叠;轻量查证直接用 web 工具，完整调研交给 worker。
- 修订(2026-11-18,结果汇总框架与模式描述):persona 末句「Collect results from completed jobs and synthesize the final answer」换成汇总判断框架(有依赖的等前置完成;独立结果到一条报一条并说明还在跑的;区分阻塞性与参考性结果;部分结果已能回答就立即给出)。prefix 改为 YAML 字面块(`|-`)保留换行，让清单仍是清单;没有放进 persona 的 `suffix`,因为官方 suffix 排在第一方指引之后、与调度身份分离。preset 加 `description`(官方 `dsh-agent-preset` Config 字段，纯字符串、不分语言),修复选模式时描述为空。
- 修订(2026-11-25,随 D31 调整提示词):PR #1 改写了 persona 开头两句，改为四句:
  1. 派工或报告可用 worker 之前，先调用后端状态工具(默认前缀下为 `acp_backend_status`);它不会建会话。启动与发送工具名可能带自定义前缀。
  2. 检测进行中要如实说明;CLI 升级、登录或默认模型变化后，可在「右侧栏 → ACP 会话 → 后端状态旁的『重新检测后端』」重新检测，不删会话、不登出、不改设置;不要建测试会话。
  3. 用户选定的后端要把它的 ID 传给 `acp_chat_start`,绝不替换;否则用配置的默认。未固定的 Kiro 默认只在 DSH 找不到 Kiro 可执行文件时才回退到就绪的 Codex、再到 Antigravity,发生时要说明;已安装 Kiro 的版本、握手或登录问题不是换后端的理由。自动发现的 Codex 是只读的，不要派需要写文件的任务。新建失败时说明原因与可选项。
  4. 对已有 chat 按 chatId 续聊，不因检测结果换后端;派工(记 jobId)、等完成通知、用 `job_output` 收结果的纪律不变。
  其余各句(目录不明先问、同 cwd 写入范围不重叠、轻量查证用 web、不亲自执行、汇总判断框架)不变。preset 标识 `acp-dispatcher` 保持不变(D31「模式与边界」)。
- 修订(2026-11-25,随 D32 加团队协作纪律):persona 在既有纪律之后、汇总判断框架之前加三句：选角色前查 `acp_team_list` 看各角色的 summary 与当前状态;一个 worker 的结果改变另一个该做的事时立即转达(对方在跑用 `acp_chat_steer`,否则 `acp_chat_send`);转达写自足的摘要并注明来源角色，不写「见 A 的结果」。
- 修订(2026-11-25,D33):删掉「选角色前查 `acp_team_list`」一句(`roles: false` 时该工具不存在，同一指引已写在 `acp_team_list` 自身描述里),两句转达纪律保留;「把后端 ID 传给 `acp_chat_start`」改为「用户点名后端且启动工具有 backend 参数时传它的 ID」,单后端版 start 没有这个参数。

修订（2026-11-25，D36）：从静态 persona 移出剩余两句角色转述要求。选用 Dispatcher 且本步骤可使用团队工具时，由全局插件按 D36 注入。共享目录的写入边界和汇总规则仍写在 persona 中，按 chatId 派工同样适用。

修订（2026-11-25，D37）：bundle 改为挂载独立声明插件 `dsh-acp-resume/dispatcher-preset`（Loader 行 `acp-dispatcher-settings`）。注册表 id 仍是 `acp-dispatcher`。旧行覆盖会告警并被跳过；请删除旧覆盖，把只读文件配置迁为新行的 `config.dispatcherTools.readOnlyFs: true`。保留完整 persona 或额外子插件时，先禁用新行，再用 `insert` 放入原官方声明及完整 config。旧行原来被禁用时，改为禁用新行。

## D27 工作区工作流组件:角色蓝图 + 模板编排 + 花名册自动供给(2026-11-18,第一轮实施：配置层、花名册、自动供给、工具 role 参数;同日第二轮实施 `acp_workflow` 引擎与 steer 的 role)

### 动机

D26 的 Dispatcher 模式靠 persona 提示词调度，是软约束：双审核、双路调研这类多步流程，模型容易漏步、错序或忘了合并。D27 引入工作区级配置驱动的工作流组件：工作区里写好角色蓝图和流程模板，插件按配置建会话、按模板跑步骤，结构化流程从「模型记住」变成「配置定死」。

### 三层隔离

| 层 | 载体 | 内容 | 谁写 |
|---|---|---|---|
| 插件层 | Config `roles`(默认 `true`)与 `workflow`(默认 `false`)(2026-11-25 修订，见 D33:原先只有 `workflow` 一个开关，同时管角色与模板;2026-11-20 曾把它改为 opt-in) | `roles` 管角色能力，`workflow` 只管模板与 `acp_workflow`;两者都为 `false` 时工具面与 D27 之前逐字节相同 | 用户 |
| 工作区层 | `<工作区根>/.agents/acp-team.yml` | 角色蓝图(`roles`)与流程模板(`templates`);只是定义，不含任何实例 | 用户手写，插件给示例 `docs/acp-team.example.yml` |
| 主会话层 | 注册表 `registry.json` 的 `rosters` 节 | 花名册：本会话把哪个角色实例化成了哪个 chat | 插件自动维护 |

蓝图与实例分开：改蓝图不影响已建的会话;花名册只记实例，不复制蓝图内容。

### 工作区配置

- **查找**:从调用会话的工作目录起向上找 `.agents/acp-team.yml`,起点目录算第 1 层，最多查 3 层(起点、父目录、祖父目录),先找到的为准;找到文件的目录即「工作区根」。工作目录取宿主 `workingDirectory` 服务对该会话的当前值，服务缺席时取会话头的 `cwd`。
- **结构**(YAML,解析用 `yaml` 包，本包唯一新增运行时依赖，零传递依赖):
  - `roles[]`:`name`(必填，匹配 Unicode 字母/数字/下划线/连字符,1-32 字符，即 `/^[\p{L}\p{N}_-]{1,32}$/u`,表内唯一;2026-11-20 修订：真机验证发现中文名被拒，放宽为 Unicode,原为 `[A-Za-z0-9_-]{1,32}`)、`backend`(可选，缺省默认后端;须是已配置的后端名，在供给时校验)、`cwd`(可选，相对路径按工作区根解析，缺省即工作区根)、`seeding`(可选，播种消息：新会话建好后先发的第一轮，用来交代身份、职责与约束)。
  - `templates[]`:`name`(必填、唯一)、`description`、`params`(字符串数组)、`steps[]`。步骤两种：`{ id, parallel: RoleRef[], prompt? }`(一组角色并行执行;多个此类步骤按书写顺序依次执行，前一步结果注入后一步 prompt,即「sequential」)与 `{ id, merge: { mode: 'return_to_model' | 'role', role? } }`。`RoleRef` 是角色名字符串，或 `{ role, prompt? }`(该角色单独的 prompt 覆盖步骤 prompt)。步骤 `id` 在模板内唯一;引用的角色必须在 `roles` 里;`mode: role` 必须给出 `role`。
- **降级**:文件不存在时静默视为「无工作区配置」;读不了、YAML 解析失败、结构或引用校验不通过时，经 `onWarn` 告警一条具体原因，同样视为无配置。无配置只影响 role 引用(报「找不到角色」),chatId 路径与 D27 之前完全一致。
- **读取时机**:只在需要蓝图时读(供给一个尚未实例化的角色、`acp_workflow` 取模板),不缓存;已实例化的角色路由只查花名册，不读文件。

### 花名册语义

- 结构:`rosters: { [ownerSessionId]: { entries: [{ role, chatId, backend }] } }`,是注册表文件的字段加法，文件版本仍为 1(同 D24 `backend` 的做法);旧文件没有该节时读作空表;该节结构损坏时只把花名册读作空表并告警，不把整个注册表当损坏件搬走。降级到 0.2.8 之前的插件版本后，下一次注册表写入会丢掉 `rosters` 节(旧代码只写 `sessions`),会话记录不受影响。
- 同一会话内，一个角色名至多对应一个 chat。实例只属于创建它的 DSH 会话(`exec.agent.id`,与 D20 `ownerSessionId` 同源);role 的解析与路由只查本会话的花名册。没有会话身份的 headless 调用不能用 role(报错)。
- 不做跨会话接手：新会话就是新花名册，同名角色会另建一个 chat。D20 的「操作面不设访问控制」不变：别的会话用 chatId 仍可直接操作该 chat,只是不能按角色名找到它。
- 远端会话中断走既有 D6 降级:D6 换的是注册表里的 `remoteSessionId`,chatId 不变，所以花名册条目不用改，角色名照旧指向同一个 chat。
- 生命周期:`acp_chat_close` 以 role 调用时，先同步解除该角色的花名册绑定，再释放进程(chat 记录按 `purge` 决定保留或删除),下次引用该角色按当时的蓝图新建;释放期间到达的同角色 send 因此会新建会话，不会重连正在释放的旧会话(2026-11-20 三方审核修订：原先先释放后解绑，并发 send 会把旧会话重连成没有花名册条目指向的活进程);释放失败时角色已解绑、chat 记录保留;以 chatId 关闭一个已入花名册的 chat 只是空闲释放，绑定保留，下次引用经 `session/load` 重连。任何方式 purge 一个 chat,都会删掉所有指向它的花名册条目，不留悬空指针。花名册条目指向的 chat 记录已不在时，按未实例化处理并清掉该条目。

### 自动供给(auto-provision)

任何工具以 `role` 引用角色时:
1. 本会话花名册有该角色 → 直接路由到它的 chat(进程已空闲释放的，照常经 `session/load` 重连)。
2. 没有 → 读工作区蓝图 → 以蓝图的 `backend` / `cwd` 调 `start`(label 记为角色名,`ownerSessionId` 记为本会话)→ 若有 `seeding`,先发播种消息并等它结算 → 登记花名册 → 执行原操作(如 send 的消息)。
3. 播种轮不是 `completed` 时，供给失败：删除这个半成品 chat(连同记录与日志),不登记花名册，原操作报错;下次引用重新供给。
4. 同一会话同一角色的供给单飞：供给进行中再次引用该角色，按 D6 单飞拒绝(提示等待当前轮完成通知),不会建出两个 chat。单飞占位在调用的第一个 `await` 之前同步取得。

模型只需写角色名，不用感知建会话、播种、登记这些步骤，用法类似数据库连接池。播种轮记进该 chat 的按轮日志(它是真实的一轮),但不流进本次 send 的 job 输出。

### 工具面扩展(本轮)

- `acp_chat_send`:加可选 `role`,与 `chatId` 二选一(都给或都不给 → 工具错误)。`workflow: true` 时 `chatId` 由必填改为可选。后台 job 模式下，预检同步完成(角色已实例化则走既有 `assertSendable`;未实例化则检查蓝图存在、该角色不在供给中),供给与发送都在 job 里跑，取消走 D6 取消条。
- `acp_chat_close`:加可选 `role`,语义见上文「生命周期」。
- `acp_chat_list`:入了本会话花名册的 chat,行首加 `role <名> | `。
- `acp_chat_start` 不加 role:自动供给取代了「先 start 再 send」的需要;D24 单后端 start 的逐字节兼容不受影响。`acp_chat_steer` 的 role 参数随下一轮工作流引擎一起做(插话对象通常是工作流步骤里的角色)。
- `workflow: false` 时，三个工具的定义与 D27 之前完全一致。(2026-11-25 修订，见 D33:改由 `roles: false` 决定;`roles` 默认 `true`,默认配置下这三个工具带 `role`。)

### `acp_workflow` 工具(下一轮实施)

- 参数 `(template: string, params: object)`,只能跑工作区里定义好的模板，不支持调用时临时编排;要新流程就改配置加模板。
- 注册为后台 job,与 `acp_chat_send` 同用 D17 语义(立即返回 jobId,完成通知唤醒,D22 门同样拦阻塞等待)。
- 步骤:`parallel`(组内角色并行)、按顺序执行的步骤链(前步结果注入后步 prompt)、`merge`。
- `merge` 模式由模板配置决定，不在调用时动态选择:`return_to_model`(把各路结果原样返回给模型)或 `role`(交给指定 ACP 角色合并，返回其输出)。
- 步骤里引用的角色与 send 的 role 共用同一本花名册和同一套自动供给。

### 工作区配置变更

不自动重建班底。已实例化的角色继续用当初的会话(它的身份由当时的播种决定),新蓝图只对之后新供给的角色生效。要让某个角色按新蓝图重建，由模型(或用户指示模型)以 role 调 `acp_chat_close`,下次引用即按新蓝图自动建。

### 不做

- 跨会话接手(adopt)别的会话的花名册。
- 调用时自由编排步骤。
- 动态模板(运行时生成或修改模板)。
- 蓝图变更后自动重建或热更新已有角色。

### 后果

注册表文件新增 `rosters` 节(字段加法，版本不变);新增运行时依赖 `yaml`;Config 新增 `workflow`;`acp_chat_send` / `acp_chat_close` 在 `workflow: true` 时 `chatId` 变为可选、新增 `role`。D6 的单飞、降级、取消语义不变，只多了「供给中」这一种单飞占位。

### 修订(2026-11-18,第二轮:`acp_workflow` 引擎实施裁定)

- **占位符**:prompt 里用单花括号 `{name}`。先查调用参数，再查前面步骤的 id;都不是的 `{…}` 原样保留(prompt 里可能本来就有花括号)。模板校验新增三条：参数名与步骤 id 须匹配 `[A-Za-z_][A-Za-z0-9_-]{0,63}`,且两者不得同名(同一命名空间);`return_to_model` 合并只能是最后一步;同一 parallel 步骤内同一角色只能出现一次(D6 单飞下第二个必然失败)。
- **顺序注入**:prompt 里写了 `{stepId}` 的，就地替换为该步骤的渲染结果;一个前步都没引用的，自动在末尾追加「前一步结果」。渲染格式为 `### Step <id>`,其下每个角色一段 `#### <角色>`,失败的写 `#### <角色> (failed)` 加原因。
- **parallel 部分容错**:单个角色发送被拒或轮未以 `completed` 结算，该项记为 `{ "error": "<原因>" }`,其余角色照常;只有一个步骤内所有角色都失败时，整个工作流以 `failed` 结束。
- **merge**:`role` 模式把前面所有步骤的渲染结果拼在合并指令之后，发给合并角色(经自动供给),其回答即该步 `result`;合并角色失败即工作流 `failed`。合并步骤可带可选 `prompt` 作为合并指令(其中的 `{param}` 生效),缺省用固定的合并指令。`return_to_model` 只是结束运行，该步记为 `{ id, mode: "return_to_model" }`,各路结果就在前面步骤里原样返回。
- **返回结构**:`{ template, status: "completed" | "failed" | "aborted", error?, steps: [...] }`。parallel 步骤为 `{ id, results: { 角色: 文本 | { error } } }`,role 合并为 `{ id, result }`。运行未完成时仍带已完成的步骤。
- **参数**:声明的参数必须全部给出;未声明的参数名报错，用来拦拼写错误;取值只接受字符串、有限数字、布尔，统一转成字符串。
- **job**:与 `acp_chat_send` 共用 job 种类 `acp-chat`,因此 D22 门同样拒绝对运行中工作流的阻塞等待，不用另改门。job 标签为 `workflow <模板名>`,输出就是上面的 JSON(结束时一次写入，不流式穿插各角色的增量),`completed` / `failed` / `aborted` 分别对应 job 的 completed / failed / killed。`job_kill` 中止 job 的信号，传给每个在途的角色发送，按 D6 取消条结算;运行在步骤之间检查信号，不再开始新步骤。无 jobs 服务时同步执行，未完成的运行作为工具错误抛出，附部分 JSON。
- **注册**:工具名固定为 `acp_workflow`,不跟 `toolPrefix`;只在 `workflow: true` 时注册，与 send 一样随 jobs 服务在同步版与后台版之间切换。
- **steer 的 role**:`acp_chat_steer` 加可选 `role`(与 chatId 二选一),经本会话花名册解析;该角色尚未建会话时报「没有会话，因此没有可插话的轮」,不触发自动供给(插话的前提是已有在途轮)。
- **未做**:工作流运行不进面板(各角色 chat 的轮次照常进面板与按轮日志);不支持步骤级超时与重试。

### 修订(2026-11-20,进度事件对齐：方案 1,直接写官方 `tool-workflow/*` 记录)

- **动机**:`acp_workflow` 目前只是一个静默的后台 job,用户等待时看不到进度。官方 workflow 在对话里有进度卡片(按阶段分组、成员启停、状态统计),由 `dsh-client-ui-workflow-run` 读会话日志里的 4 种 `tool-workflow/*` 记录折叠渲染。本插件写出同样的 4 种记录，就能复用官方界面，不写任何客户端代码。
- **4 种记录**:官方 `packages/workflow/tool-workflow/src/types.ts` 中 `SessionEventMap` 的扩展;四个类型名已列入 `dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`(`src/known-event-types.ts`),官方承诺已发布的事件类型长期保留，读旧日志不会出错。
  - `tool-workflow/run-start {runId, name}`
  - `tool-workflow/agent-start {runId, seq, label, phase?, childId}`
  - `tool-workflow/agent-end {runId, seq, outcome}`,`outcome` 取 `completed` / `failed` / `cancelled`
  - `tool-workflow/run-end {runId, stopReason}`,`stopReason` 取 `completed` / `error` / `cancelled`
- **映射**:
  - `runId` 为每次运行新生成的随机 UUID,`name` 取模板名。
  - 每个角色成员(parallel 步骤里的一个角色，或 `merge: role` 的合并角色)记一次 start 和一次 end;`seq` 在本次运行内从 1 递增，同一 seq 的 start 与 end 成对;`label` 为角色名;`phase` 为所在步骤的 id。
  - `return_to_model` 合并不产生成员。
  - `childId` 填 `acp-role:<角色名>`。这是一个稳定的占位值，不是真实的子会话 id;官方面板查不到对应会话，读代码推断该行会显示为不可点击(`WorkflowRunPanel.tsx` 按 `childId` 查会话与导航模式，查不到即无导航)。尚未在真实界面核对。
  - 成员结局:角色轮 `completed` → `completed`;运行被取消(信号已中止，或轮以 `aborted` 结算)→ `cancelled`;其余(发送被拒、轮以 `error` 等结算)→ `failed`。
  - 运行结局:工作流 `completed` → `completed`,`failed` → `error`,`aborted` → `cancelled`。
- **写入时机**:只在模型直接调用(`exec.parent === undefined`,与官方一致)时写，写进调用方会话(`exec.agent.session`);被其他工具嵌套调用时不写。后台 job 路径另外在每个步骤开始时调 `job.updateProgress(<步骤 id>)`,任务列表里能看到当前步骤。
- **降级**:任一次写入抛错时，经 `onWarn` 告警一次，并停写本次运行余下的记录，工作流照常执行、结果不变(与官方 recorder 的策略相同)。记录器不向引擎抛任何异常;引擎对观察者回调同样兜底。
- **类型**:不新增 peer 依赖。把 `session.append` 收窄成 `(type, data) => void` 后强转调用，结构与官方 `types.ts` 逐字段一致。
- **风险**:
  - 借用的是官方事件名，格式变更不由本包控制;D2 升级 DSH peer 时须对照官方 `tool-workflow/src/types.ts` 核对这 4 种记录。
  - 记录留在会话日志里，卸载本插件后，历史会话里的进度卡片仍会显示。
  - 已评估：这 4 种类型在 `KNOWN_SESSION_EVENT_TYPES` 中，旧日志的读取有官方兼容保证。

### 修订(2026-11-20,默认关闭)

(2026-11-25 再修订，见 D33:本段的「只有 `workflow: true` 才有 role 参数、团队文件读取、花名册与自动供给」已拆给新开关 `roles`(默认 `true`);`workflow` 只剩 `acp_workflow` 与列表末行的模板部分，默认仍为 `false`。)

Config `workflow` 的默认值由 `true` 改为 `false`:工作流是独立组件，按用户要求改为显式开启(opt-in)。只有设了 `workflow: true` 才会有 `acp_workflow` 工具、现有工具的 `role` 参数、工作区 `.agents/acp-team.yml` 的读取、花名册与自动供给;默认状态下五个工具的定义与 D27 之前逐字节相同。已有的 `rosters` 节在关闭后保留在注册表里不被删除，重新开启后照常可用。

### 修订(2026-11-20,回执明确禁止 wait_agent)

真机验证：模型调 `acp_workflow` 拿到 jobId 后没有结束回复，而是调 `wait_agent`(30 秒、120 秒)等待，工作流要跑几分钟，两次都超时。`acp_workflow` 与 `acp_chat_send` 的后台回执末尾统一追加固定一句:`Do not call wait_agent or job_output with wait — end your reply now; the completion notification will wake you automatically.` 门控层面的拦截见 D22 同日修订。

### 修订(2026-11-20,三方审核：回执与工具描述措辞)

- 后台回执末句改为 `Do not call wait_agent or job_output with wait. Send any other independent tasks, then end your reply; the completion notification wakes you.` 原句「end your reply now」会让想并行派发 A/B/C 的模型在发完 A 后就停下。适用于 `acp_chat_send` 与 `acp_workflow`。
- `acp_workflow` 描述补结果语义：失败角色在步骤里显示为 `{error}`,一步内全部失败才整体失败;运行结束后角色保留会话与记忆，可用 `acp_chat_send role=…` 追问、`acp_chat_close role=…` 重置。删掉进度记录的事件名与 `session_event_read` 读法(那是实现细节，模型不需要),改为「进度以工作流卡片展示给用户，结果经 job_output 取」。

### 修订(2026-11-20,三方审核：配置错误要传给模型，可用角色与模板要能被发现)

- 原先 `.agents/acp-team.yml` 存在但校验失败时，模型只看到「no usable workspace team config」,会误以为没有这个文件。新增 `readTeamConfig` 返回三种结果:没找到、可用、无效(带文件路径与具体原因)。以 role 或模板名引用时，没找到的报 `no workspace team config (...) found from <目录>`,无效的报 `cannot resolve <role|template> <名>: workspace team config <路径> is invalid: <原因>`,同时仍经 `onWarn` 告警。「找不到文件时视为无配置」的语义不变。
- `acp_chat_list`(`workflow: true` 且有调用会话时)在输出末尾加一行：可用时为 `workspace roles: <名1>, <名2>; templates: <模板>(<参数>), …`,文件无效时为 `workspace config error: <路径>: <原因>`,没有文件时不加。这一行每次 list 都重新读文件，不告警，也不缓存。

### 修订(2026-11-20,三方审核：未知字段严格校验)

每一层映射(文件顶层、角色、模板、步骤、`merge`、`parallel` 里的对象项)都只接受已知字段，出现未知字段即判整份配置无效，报错写明字段名与允许的字段(如 `roles[0] has unknown field seed; allowed: name, backend, cwd, seeding`)。原因：把 `seeding` 写成 `seed` 时原先静默无播种。顶层允许可选的 `version`,给出时必须为 `1`(真机配置已在用)。同一步骤同时写 `merge` 与 `parallel` 报错(原先 `parallel` 被静默丢弃);merge 步骤的步骤级 `prompt` 也报错，合并指令应写在 `merge.prompt`。

### 修订(2026-11-25,蓝图省略 `backend` 时的取值)

角色蓝图不写 `backend` 时，首次供给按新建会话的路由走(D31):找得到 Kiro 时用 `default`;宿主查找明确找不到配置的 Kiro 可执行文件时，改派到就绪的 Codex(只读)或 `agy`,首次供给的回答首行会写明(D31 2026-11-25 修订)。花名册记录的是 chatId,而 chat 的后端在创建时就定下了，所以该角色会**持续绑定在改派后的后端上**,之后即使 Kiro 能找到了也不会自动换回，直到以 role 调 `acp_chat_close` 解绑，下次引用再按当时的路由重建。这是已知行为，不是缺陷;需要固定后端的角色应在蓝图里写明 `backend`。工作流步骤引用的角色同样适用(它们与 send 的 role 共用花名册与自动供给),且 D31 修订注明工作流结果 JSON 暂不标注改派。

### 修订(2026-11-25,D32 团队上下文)

角色蓝图加可选 `summary`(给别人看的一句职责，见 D32),允许字段表随之更新，未知字段仍报错。有 `seeding` 的角色，首次供给时插件在用户写的 `seeding` 前拼一段固定英文团队上下文再发;没有 `seeding` 的角色行为不变，仍不发播种轮。新增只读工具 `acp_team_list`,只在 `workflow: true` 时注册(2026-11-25 修订，见 D33:改为随 `roles` 注册)。花名册与蓝图的存储结构不变。

## D28 后端额度查询：先接 Codex(2026-11-20)

### 动机

多个后端并行干活时，用户需要知道各后端的额度用了多少。Codex `app-server` 提供只读的账户与额度方法，查询不消耗额度。kiro v3 不暴露账户额度(v2 有，但代价高),本次不接入，统一显示为 `unsupported`;用户已确认跳过。

### Codex 额度接口

字段形状取自本机 `codex-cli 0.170.0` 的 `codex app-server generate-ts` 生成的协议类型(`v2/GetAccountRateLimitsResponse.ts`、`RateLimitSnapshot.ts`、`RateLimitWindow.ts`、`GetAccountResponse.ts`、`Account.ts`):
- `account/read`:回 `{ account, userId, requiresOpenaiAuth }`;`account` 为 `{ type: 'chatgpt', planType, … }`、`{ type: 'apiKey' }` 等，或 `null`。
- `account/rateLimits/read {excludeResetCreditDetails: true}`:回 `{ rateLimits: RateLimitSnapshot, … }`;`RateLimitSnapshot` 含 `primary` / `secondary` 两个窗口 `{ usedPercent, windowDurationMins, resetsAt }`(`resetsAt` 为 unix 秒，可为 null)与 `planType`。`excludeResetCreditDetails` 是协议里专为后台轮询设的参数，跳过单独的重置额度明细查询。
- **只读白名单**:连接层只新增 `readAccount()` 与 `readRateLimits()` 两个方法，各自固定发上面一个方法名;不暴露通用的请求入口。`consume`、`sendAddCreditsNudgeEmail` 等有副作用的账户方法，本包永远不会发。
- 被动推送 `account/rateLimits/updated`(每轮结束后)本版不用。

### 统一返回结构

```ts
{ backend: string, protocol: 'codex' | 'acp',
  status: 'ok' | 'unsupported' | 'error',
  plan?: string,         // 如 "prolite";chatgpt 账户取 account.planType,其他账户取 account.type,都没有时取 rateLimits.planType
  usedPercent?: number,  // 不封顶，可超过 100
  windowMins?: number,   // 如 10080(周窗口)
  resetsAt?: number,     // unix 秒
  fetchedAt: number,     // 本地毫秒时间戳
  error?: string }       // status 为 error 时
```

- `backend` 为可回传给 `acp_chat_start` 的后端名(默认后端为 `default`,同 D24 修订)。
- **一个数字代表哪个窗口**:Codex 同时报 `primary`(通常是 5 小时窗口)与 `secondary`(通常是周窗口)。返回结构只有一组 `usedPercent` / `windowMins` / `resetsAt`,取 `usedPercent` 更高的那个窗口(相同时取更长的窗口),也就是当前最先卡住的限制。两个窗口都没有时只给 `plan`。
- ACP 后端(含 kiro 默认后端)一律 `status: 'unsupported'`,不发任何请求。

### 缓存

- 单层缓存，按后端存一条结果,TTL 5 分钟(`USAGE_TTL_MS`;失败结果为 1 分钟，避免故障时频繁起进程)。
- 没有缓存时等本次读取完成;缓存过期时先返回旧结果，同时在后台刷新;同一后端同时只有一次读取在跑，并发请求共享它。
- `refresh: true` 跳过缓存，等一次新的读取(仍与正在进行的读取共享)。
- 缓存只在当前插件实例内存里，重启后重新读取。

### 读取方式

- 优先用池里该后端的活跃 Codex 连接直接发两个只读请求(JSON-RPC 允许与在途轮并发)。
- 没有活跃连接时临时起一个 `codex app-server`(该后端的 command / args / env,工作目录为用户主目录):只做 `initialize` → 两个只读请求 → 关闭，不开线程、不落盘。临时进程不进池、不进注册表，用完即按销毁梯子关闭。
- 单次读取上限 15 秒，超时记为 `error`。

### 暴露面

- 工具 `acp_backend_usage {backend?, refresh?}`:只读，并发安全，返回统一结构数组(给了 `backend` 就只含该后端，未知后端名报工具错误)。工具名固定，不跟 `toolPrefix`;**只在至少配置了一个 Codex 后端时注册**,所以没有 Codex 的安装工具面不变。
- Remote `acpResume/usage(refresh?)`:面板用，返回同一结构数组。
- 面板:ChatsPanel 头部每个 `ok` 或 `error` 的后端一行(如 `codex · prolite · 83%`,悬停显示窗口与重置时间;失败行显示「额度读取失败」,悬停显示原因),`unsupported` 不显示。面板拉额度与拉会话列表互不阻塞：额度慢或失败不影响列表。额度结果跟随既有轮询节奏，由宿主缓存兜住频率：面板开着时，每个 Codex 后端约 5 分钟读一次。

### 不做

- kiro 额度(等 v3 提供接口，或用户确认可以接受 v2 的代价)。
- 通用 ACP 后端的 `usage_update`。
- 被动推送 `account/rateLimits/updated`。

## D29 侧边栏工作流面板(2026-11-20)

### 动机

工作流进度现在只出现在对话流里(D27 的官方进度卡片)。卡片会随对话滚走，看不到跨运行的概览，也没有从一次运行跳到某个角色会话的入口。D29 在侧边栏「ACP 会话」面板里加一个工作流区块：显示正在运行的工作流和最近几次结果，展开后能看到每一步的成员，点成员打开它的会话详情页签(D18)。

### 存储

- 文件：注册表旁的 `workflows/<ownerSessionId>.jsonl`,每个 DSH 会话一个。纪律与 D18 按轮日志相同：只追加、超量裁剪、坏行跳过、写失败只经 `onWarn` 告警，绝不影响工作流执行与结果。会话 id 不是安全文件名时(含路径分隔符等)不写，并告警。
- 每次运行两行:
  - `run-start {v:1, kind:'run-start', runId, template, startedAt, jobId?}`
  - `run-end {v:1, kind:'run-end', runId, at, status, error?, steps}`,`status` 取 `completed` / `failed` / `aborted`;`steps` 为摘要 `[{ id, members: [{ role, chatId?, outcome }] }]`,`outcome` 取 `completed` / `failed` / `cancelled`;`return_to_model` 合并步骤没有成员。
- **不存角色回答原文**(原文已在各角色 chat 的按轮日志里，靠 chatId 跳转查看);**不存 params**(可能含用户原文)。
- 读取：按 runId 配对 start 与 end;有 start 而无 end、且当前池实例里也不在运行的，判为 `interrupted`(例如运行中途宿主重启)。返回最近 5 次(新的在前)。读取按文件 `mtimeMs:size` 缓存。
- 裁剪：文件里的运行数超过 100 时，原子重写为最近 50 次运行(临时文件 + 改名)。
- **孤儿清理**:purge 一个 chat 后，如果该 chat 的所属会话在注册表里已没有任何 chat,连带删除该会话的 `workflows/` 文件。这样工作流记录不会比它涉及的会话活得更久。

### 运行中状态

- 只在池实例内存里跟踪(与 D15 在途轮同规则),不落盘;池重启后丢失，对应文件里那次运行显示为 `interrupted`。
- 跟踪器实现 `WorkflowObserver`(D27),记录当前步骤和已开始成员的角色、chatId 与结局;与官方进度记录器、后台 job 的进度行组合使用，互不影响。
- **runId 共用**:由跟踪器生成，并传给官方进度记录器作为 `tool-workflow/*` 记录的 `runId`。侧栏条目和对话里的进度卡片因此一一对应。
- 观察者的 `memberEnd` 加可选参数 `chatId`(来自该角色本次发送的结果),发送被拒、没有结果时为空。

### Remote

`acpResume/workflows(ownerSessionId)` → `{ running, recent }`。`running` 为该会话在本池实例中正在运行的工作流(`runId`、`template`、`startedAt`、`jobId?`、`currentStep?`、`steps`);`recent` 为最近 5 次已结束或中断的运行(`runId`、`template`、`startedAt`、`endedAt?`、`status`、`error?`、`steps`)。参数必须是非空字符串。

### 界面(ChatsPanel 内的新区块)

- 位置：活跃会话列表(及其「显示其余 N 个」折叠按钮)之后、已释放分组之前。会话没有任何运行中或最近的工作流时，整个区块不显示。
- 区头:「工作流 · N 进行中」(没有运行中的时只写「工作流」)。
- 运行中的行：官方转圈点 + 「模板名 · 当前步骤」+ 逐秒走的时长(复用 D18 修订里的在途时长组件，只在有运行中工作流时挂载)。
- 最近结束的行(至多 5 条):`completed` 绿点、`failed` 红点、`aborted` 与 `interrupted` 橙点，加模板名与「N 分钟前」。
- 单击一行在行内展开或收起：逐步列出步骤 id 与成员(角色名 + 短 chatId,带各自结局点);点击成员打开该 chat 的详情页签。展开状态只存在组件里。
- 数据源：每个会话独立读取工作流；工作流已开启或旧宿主未提供能力查询时，只在区块挂载期间每 5 秒轮询 `acpResume/workflows`,内容没变时快照引用不变(D21);与会话列表的数据源互不影响。

修订（2026-11-25，D35）：`workflow: false` 时停止工作流区块的周期轮询；持久会话面板仍启用时，打开区块可读取并展示当前 owner 已有的最近运行记录，沿用原有保留和清理规则。手动刷新会话时也可更新已挂载区块的历史。仅宿主插件在同一连接上热重载时，浏览器模块不保证一起重载；面板在重开、刷新或连接重建时重新确认配置。

### 不做

- 不在侧栏重跑或取消工作流(取消仍用 `job_kill`)。
- 不展示角色回答原文(在会话详情页签里看)。
- 不跨会话展示别的 DSH 会话的工作流(与 D20 的发现面一致)。

### 修订(2026-11-20,显示剩余而非已用)

用户要看的是「还剩多少」。统一结构加 `remainingPercent = max(0, round(100 - usedPercent))`(已用超过 100% 时为 0,不为负),`usedPercent` 保留给模型与工具。面板头部行改为 `codex · prolite · 剩 17%`(英文 `17% left`),悬停仍显示窗口已用比例与重置时间。

## D30 会话详情页签密度优化(第一步：纯展示层，2026-11-20)

动机：详情页签信息分散、留白多，一屏看不到几轮。本步只改 `src/client/ChatDetail.tsx` 与文案，不动宿主协议(`panel.ts`、Remote、数据源都不变)。

- **标题区**:一行，圆点 + 名称(label → 首轮标题 → 短 id,与列表一致)+ 右端「⋯」菜单(官方 `Menu`):「释放进程」/ 分隔线 /「删除记录…」。释放在有在途轮时仍先确认;删除仍先确认，确认后关闭页签。删掉刷新按钮(数据源本就自动轮询)。
- **元信息一行**:`后端 · N 轮 · 多久之前`(只在配置了多个后端时写后端名，同列表);有在途轮时整行换成 `后端 · 进行中 1分20秒`,逐秒走(复用列表的在途计时组件，只在有在途轮时挂载)。完整 chatId、cwd、完整远端会话 id、状态说明移到名称的悬停提示;删掉 cwd 行、远端 id 行、「首轮:」行和区块标题旁的轮数。
- **轮次列表**:无边框列表行加分隔线。收起时两行：问题首行(主色，行尾相对时间;未正常完成时加结束原因标签，换过新会话加「新会话」标签)与回答首行(次色，截断时行尾「全文 · N 行」)。`#seq` 移入悬停提示;去掉「问」「答」标签和通栏展开按钮。点击整行展开或收起，同一时间只展开一条。展开后的完整问答、「查看诊断」、「收起」不变。
- **进行中条目**:置于列表最上方，转圈点 + 已发送消息首行 + 逐秒时长，点击展开全文。
- **连接事件**:去掉「连接」标签，保留警告色竖条、一行说明和时间。
- **空状态**:一行灰字「暂无轮次记录」。
- **文案**:删去不再使用的 question / answer / expandFull / expandFullLines / refreshDetail / runningMessage / eventBadge / turnExpand;新增 fullLines / inFlightFor / releaseProcess / deleteRecord / moreActions。`chatTitle`(「首轮:」)仍用于列表行的悬停提示，保留。

修订(2026-11-20,密度再平衡):用户反馈 D30 之后「过于简朴、内容过密」,整体太扁平，每轮的信息不够辨认。在 D30 的结构上加回信息量，仍只改展示层:
- 收起时问题预览最多 2 行、回答预览最多 3 行：取前几行非空行(每行至多 200 字),保留换行，再用 CSS `line-clamp` 限住折行;还有未显示的行或被截断时，行尾照旧显示「全文 · N 行」。
- 异常轮加左侧竖条，样式同连接事件:`error` 红色;未正常完成(`aborted`、`max-tokens`、`refusal` 等)或由新会话作答的轮橙色;正常完成的轮无竖条。
- 进行中条目显示已发送消息的前 2 行。
- 元信息行末尾追加 cwd 的最后一级目录名(如 `kiro-cli · 12 轮 · 3 分钟前 · dsh-acp-resume`),进行中时同样追加;完整路径仍在名称的悬停提示里。

## D31 派工后端的版本支持、就绪检查与准入(2026-11-22)

- **发布支持而非逐版实测**：[兼容范围与证据](docs/backend-compatibility.md)按 CLI + 协议或引擎记录边界；支持范围来自版本化的上游文档、发行说明和源码，证据不足时只补关键边界。`src/backend-compatibility.ts` 是运行时和发布表的唯一版本来源，`pnpm check:compatibility` 检查同步。范围之外是插件的支持策略，不等于已证实不兼容。
- **补丁版策略（2026-11-22 修订）**：已核对的次版本线默认接纳后续正式补丁版。范围上限为下一条尚未纳入的次版本线，且不包含该版本；下限保留已知协议和修复要求。已知回归可单独排除。版本通过不替代协议和就绪检查，预发行版不进入自动选择。
- **启动自动验证**：使用宿主 subprocess 的环境与查找语义读取 CLI 版本，对符合条件的候选做有时限的连接检查。自动发现的范围外 CLI 默认不握手；`allowUnverifiedBackends: true` 允许探测并显式尝试，但不改变自动选择的范围。「重新检测后端」复用同一流程，不是初次启用的条件，不清理会话、登录或配置。侧栏默认只显示一行「后端状态」摘要与独立的「重新检测后端」按钮；无需展开即可检测，版本范围与修复提示仍在详情内。宿主和面板保留未找到的内置 CLI 行并显示支持范围；发现不等于就绪。ACP 握手不凭 `authMethods` 猜登录；Codex 只读 `account/read`（显式不请求刷新 token）、`config/read` 和 `model/list`，不触发登录、不创建会话、不发提示词。上游 CLI 自己可能访问网络。面板轮询和模型状态工具只读缓存。
- **Codex 零配置**：若没有显式 Codex 后端，从 PATH 发现 `codex` 后使用 `read-only` / `never` / `reject`，只继承查找路径覆写，不带入其他后端的显式凭据。显式设置优先；省略模型时验证 Codex 用户级配置，若未设置才采用唯一公布的可用默认；不替用户猜模型。重连自动发现的线程不传新默认模型，保留原线程选择。
- **Antigravity 零配置（2026-11-22 修订）**：未显式配置时，从 PATH 添加命名后端 `agy`，仅用 `agy acp`，沿用 CLI 的模型设置，拒绝 ACP 权限请求，不复用其他后端的显式凭据或授权。与 Codex 共享 `discoverBackends` 开关；显式配置优先。启动只握手，不猜测登录；若握手或首次建会话明确收到 ACP `AuthRequired`，提示 CLI 登录并重新检测。
- **新建路由（2026-11-23 二轮审阅后修订）**：显式 `backend` 优先，其次是固定的 `defaultBackend`；指定目标不可用时明确报错，不自动改派。否则默认按顶层 `default` 配置启动。发现开启且顶层命令识别为 `kiro-cli`（包括指定可执行文件路径）时，仅在宿主查找明确返回找不到该可执行文件的情况下，才从范围内且就绪的 Codex、`agy` 中依次选择。版本未知或超出范围只告警；版本读取、握手、认证失败或临时探测错误都不算找不到命令，不触发改派。此规则不要求 argv、引擎或模型设置与内置配方相同；自定义包装命令或关闭发现时保留原路由。没有合格的回退候选时尝试原命令，保留固定的 ENOENT 指引。自动发现的范围外 CLI 可通过 `allowUnverifiedBackends: true` 后显式选择或固定为默认项，不纳入自动回退。
- **状态不拦截续聊**：工具注册不随就绪结果增减。已有 `chatId` 的发送、重连和既有角色绑定不查就绪门，按原后端和 D6 处理；仅新建和首次供给角色需要选路。注册表中的 `default` 含义、历史绑定和 D6 的降级条件均不变。单次启动失败只作诊断，不锁住后端，不要求手动复查才能重试。
- **默认发现（2026-11-23 二轮审阅后修订）**：保留 `discoverBackends: true`，以保留零 YAML 体验。与 [PR #1 首轮审阅第 ⑤ 条](https://github.com/Tureen/dsh-acp-resume/pull/1#issuecomment-7090561573) 不同，二轮审阅接受默认开启的前提是仅在明确找不到配置的 Kiro 可执行文件时才回退。用户可设 `discoverBackends: false` 关闭额外发现和回退，不影响已配置后端。
- **模式与边界**：修订 D26，保留 `acp-dispatcher` 预设标识（宿主重启后恢复历史需要它）；没有可用的自动候选时返回诊断，不启用 bash 或切到标准模式。`acp_backend_status` 与面板读取同一状态。官方 one-shot 和 `src/run.ts` 按 D11 不动。

- **改派要写明(2026-11-25 修订)**:未显式指定 `backend`、也没有固定 `defaultBackend`,且宿主查找明确找不到配置的 Kiro 可执行文件而改派到 Codex / `agy` 时，模型与用户都要能看出这是被动改派。现实风险是 macOS 从 Dock 启动的 DSH 宿主 `PATH` 常不含 `~/.local/bin`,Kiro 明明装着却被判找不到，悄悄换成只读 Codex。
  - **来源**:是否发生改派由就绪服务的选路结果给出，不靠「后端名 ≠ `default`」反推。新增 `BackendReadinessService.route()`,返回 `{ backend, fallbackFrom? }`;只有「未指定、未固定、顶层 Kiro 明确找不到」这一条路径换掉了 `default` 时才带 `fallbackFrom: 'default'`(含先做一次检测后再改派的分支)。显式 `backend`、固定的 `defaultBackend`、找到了 Kiro、或没有可用替代而仍按原命令启动，都不带。池的 `start` 优先调 `route()`,只有 `select()` 的旧调用方按无改派处理。
  - **文案**:固定一句 `<被替换后端的命令名> was not found; this chat uses <后端名>`;落到沙箱为只读的 Codex 后端(自动发现的 Codex 恒为只读)时末尾加 ` (read-only)`;`agy` 不加。
  - **出现在哪**:`start` 结果的 `fallbackNotice` 字段(只在创建它的那次结果里，不落注册表、不进列表);多后端版 `acp_chat_start` 的输出结构加可选 `fallbackNotice`,回执末尾追加 `. <这句话>`;单后端版工具定义与回执不变(关闭发现时没有改派)。以 role 首次供给落到改派后端时，同步 `acp_chat_send` 的回答首行加 `[<这句话>]`,后台 job 的输出首行同样写入(job 回执在供给前已返回，所以不在回执里)。
  - **「找不到」的实际范围**:判据是宿主 `dsh-subprocess-local` 的 `resolveExecutable` 返回 `SUBPROCESS_EXECUTABLE_NOT_FOUND`(或 `ENOENT`)。宿主在逐个候选路径 `stat` + `access(X_OK)` 时吞掉具体原因，把「文件无执行权限」「同名是目录」「PATH 中的目录无读权限」都报成找不到，所以这三种情况**会**改派;本条早先「权限错误不算找不到」的说法与实际行为相反，以此为准。不改行为:无执行权限的 Kiro 本来也起不来。查找超时与其他解析错误仍不算找不到。
  - **工作流成员回执（2026-11-25 修订）**：角色首次供给时，池在发送前通过 `onBackendFallback` 提供创建回执。工作流按步骤和角色记录当次通知，在最终 JSON 的对应成员回答或错误前加同一句 `[<改派说明>]`；角色合并步骤记在该步的合并结果上。其他成员和后续步骤引用的原始回答保持原样。直接调用和后台 job 共用这一输出。
  - **会话列表**：`acp_chat_list` 继续显示实际后端，不标注改派。创建原因没有落盘，注册表投影无法区分用户点名和自动改派。
  - **候选工具描述与额度（2026-11-25 修订）**：多后端启动工具列出候选，指引先查后端状态。仅当 Config 的命名后端中显式配置了 `protocol: codex` 时注册 `acp_backend_usage`；自动发现的 Codex 即使就绪也不会增加工具。手动重新检测只更新状态。

## D32 Dispatcher 的团队上下文：角色摘要、播种前置上下文与团队列表(2026-11-25)

### 动机

调研官方 Agent Team 后的结论：本插件的 ACP worker 不知道自己在一个团队里，也不知道队友是谁;调度者也不知道每个角色负责什么。这些信息(角色蓝图、花名册)其实都在插件内部，只是从没告诉过任何一方。

### 设计原则

1. **身份由插件注入，不靠用户手写。** 官方每个子代理都会自动拿到身份上下文;本插件也不该要求用户在每个角色的 `seeding` 里重复写「你是团队一员、队友有谁」。这类内容机械、易漏、改了角色还得逐个改。
2. **只注入静态身份，不注入动态状态。** 播种只发生一次，之后状态就过时了;官方也不给成员推送任务板快照，遵循「读的时候去问，不复制推送」。所以注入的只有角色名、队友名与职责;谁在忙、做到哪，由调度者用 `acp_team_list` 现查。
3. **不新建存储。** 一切从已有的角色蓝图与花名册派生。官方删掉独立名册和邮箱的理由就是它们与已有数据重复;本插件同理，不新增文件或注册表字段。

### 实施

- **`summary` 字段**:`RoleBlueprint.summary` 可选，是一句给**别人**看的职责(调度者选角色、队友了解分工时用);`seeding` 仍是给角色**自己**的完整职责。空串视为未设，内部空白(含换行)折成一个空格以便单行展示。加入角色的允许字段表，未知字段仍严格报错。
- **播种前置团队上下文**:首次供给有 `seeding` 的角色时，发出的播种消息是「上下文 + 空行 + 用户 seeding 原文」。上下文是固定英文(系统生成的内容，与用户语言无关;worker 可能是 Codex 也可能是 kiro,英文更稳):

  ```
  You are the team role "<role>" in this workspace's ACP team.
  Your teammates (reached through the agent that dispatches you; workers do not talk to each other directly):
  - <name>: <summary>
  - <name>
  When you need something from a teammate, state the request explicitly in your answer; the agent that dispatches you relays it.
  ```

  (2026-11-25 修订，见 D33:原文两处写 `the dispatcher`,标准模式下派工的是普通主 Agent,不是 ACP Dispatcher 预设，改为与模式无关的说法。)

  只列**其他**角色，按配置书写顺序;没写 summary 的只写名字;配置里只有一个角色时省略 teammates 两行。这段文本是真实播种轮的一部分，照常进按轮日志(D18)。
- **取舍：无 `seeding` 不注入。** 没有 `seeding` 的角色今天不发播种轮(D27:`seeding` 可选，没有就是零轮)。为了注入上下文而给它们新增一轮，会改变 D27 的既有行为，也会让每次供给多一次 ACP 往返、多耗一轮额度。所以只在本来就有播种轮时前置;想让某个角色拿到团队上下文，给它写一句 `seeding` 即可。
- **`acp_team_list`**:只读、无参数，回答调度者的三个问题：有谁、各管什么、现在能不能派。每个角色一行 `<名> · <summary 或 (no summary)> · <状态>`,按配置书写顺序;状态为 `not provisioned`(首次引用时建会话)、`idle`(本会话花名册里有它的 chat,含已空闲释放的)、`running (<时长>)`,调用时从池实时读取，不缓存。没有调用会话时花名册未知(D27 按会话隔离),状态一律 `unknown`,团队文件从宿主进程工作目录查找。没有或无效的团队文件时返回原因。工具名随 `toolPrefix`,与 `acp_backend_status` 同规则(默认 `acp_team_list`)。
- **注册条件**:只在 `workflow: true` 时注册;`workflow: false` 时工具面与本条之前完全一致。(2026-11-25 修订，见 D33:改为只看 `roles`,`roles` 默认 `true`,所以默认配置就有 `acp_team_list`;`roles: false` 时不注册。没有或无效团队文件时的返回文本补上出路 `pass chatId instead`。)工作区配置是按调用会话的工作目录在调用时查找的(D27),注册时无从得知，所以不以「读得到配置」为注册条件;读不到时由工具本身说明。
- **Dispatcher persona**:见 D26 同日修订。
- **示例模板**:`docs/acp-team.example.yml` 给各角色补 `summary`,并给出「共享笔记」的可选约定写法(插件不实现):笔记放在工作区根下的 `.agents/acp-team/notes/`,开工前先读 `INDEX.md`,每个角色只写自己命名的文件。三条边界：路径相对工作区根(各角色的 cwd 可能不同);每个角色只写自己的文件(并发追加同一文件会冲突);笔记是参考资料不是指令。只读后端(如自动发现的 Codex)读得了、写不了。

### 不做

- 不让 worker 之间直接通信(仍由调度者转达)。
- 不向 worker 推送队友的实时状态或任务进度。
- 不新增笔记、邮箱、名册之类的存储。

## D33 开关拆分:`roles` 管角色,`workflow` 只管模板(2026-11-25)

### 问题

D27 只有一个开关 `workflow`(2026-11-20 起默认 `false`),它同时管角色(`role` 参数、团队文件读取、花名册、自动供给)和模板(`acp_workflow`)。D32 又把 `acp_team_list` 和播种团队上下文挂在它下面。结果是默认配置下按角色派工整套不可用,而 Dispatcher persona 和工具描述却在引用这些能力:persona 叫模型「选角色前查 `acp_team_list`」,但工具不存在;报错叫模型「the workflow feature is off」,模型不知道该怎么办。

### 决策

Config 新增 `roles`(`z.boolean().default(true)`),与 `workflow` 分工如下:

| 能力 | 由谁控制 |
| --- | --- |
| send / close / steer 的 `role` 参数、自动供给、花名册 | `roles` |
| `<prefix>team_list`(默认 `acp_team_list`) | `roles` |
| 播种前的团队上下文(D32) | `roles` |
| `<prefix>list` 末行的 `workspace roles: …` | `roles` |
| `acp_workflow` | `workflow` |
| `<prefix>list` 末行的 `; templates: …` 部分 | `workflow` |

四种组合:

| `roles` | `workflow` | 结果 |
| --- | --- | --- |
| `true` | `false` | 新默认:角色能力全开,无 `acp_workflow`,列表末行只列角色 |
| `true` | `true` | 全部能力,列表末行列角色和模板 |
| `false` | `false` | 工具面与 D27 之前逐字节相同 |
| `false` | `true` | 配置错误,加载时报 `acp-resume: workflow: true requires roles: true; the workflow engine dispatches to roles. Set roles: true, or set workflow: false` |

`roles` 默认 `true` 的理由:按角色派工不是进阶能力。没有 `.agents/acp-team.yml` 的工作区里它什么都不做(列表不加末行,`acp_team_list` 和 role 报错会说明缺文件并给出改用 chatId 的出路);有这个文件就说明用户想按角色派工,再要求改一次插件配置只是多余的门槛。模板编排会让一次调用跑多步、多角色,仍保持显式开启。

「工具面与 D27 之前逐字节相同」的承诺,从此只在 `roles: false, workflow: false` 时成立;默认配置下 send / close / steer 带可选 `role`,`chatId` 变为可选,并多一个 `acp_team_list`。

### 同批的自洽性修复

- persona:删掉「选角色前查 `acp_team_list`」(见 D26 同日修订);backend 一句改为「启动工具有 backend 参数时才传」。
- `acp_workflow` 描述:「结果经 `job_output` 取」只在后台版出现,同步版不提 `job_output`。
- 列表末行与列表工具描述随开关分支:`workflow: false` 时只写 `workspace roles: …`,描述也只说 roles;`roles: false` 时没有末行,也没有 `workspace config error` 行。
- 报错出路:没有团队文件时 role 报错与 `acp_team_list` 结果追加 `pass chatId instead; roles need an .agents/acp-team.yml in the workspace`;文件无效时 role 报错追加 `fix the file, or pass chatId instead`;文件里没有角色时 `acp_team_list` 返回 `no roles defined in <路径>; define roles there, or pass chatId instead`。`role` 参数描述追加 `Only when the workspace defines roles (see <prefix>team_list).`,工具名随 `toolPrefix`。
- `roles: false` 时仍传 `role` 的报错改为 `role is not available: the roles feature is off (Config roles: false); pass chatId instead`。
- 团队上下文里的 `the dispatcher` 改为 `the agent that dispatches you`(见 D32 同日修订):标准模式下派工的不一定是 ACP Dispatcher 预设。

### 实现与后果

- `RoleSupport` 加可选字段 `templates`,插件按 `workflow` 设置;直接调用 `registerChatTools` 的测试不传时视为开启。`registerChatTools` 在 `templates === false` 时不注册 `acp_workflow`,`describeTeamConfig` 按它决定是否带模板。
- `acp_team_list` 只按 `roles` 注册,不看配置文件是否读得到,理由同 D32:团队文件按调用会话的工作目录在调用时查找。
- 注册表结构不变;已有 `rosters` 节在 `roles: false` 下保留,重新开启后照常可用。
- 测试:tools.spec 按四种组合各断言一次注册的工具名、`kc_send` 是否有 `role`、`kc_list` 末行;另有配置冲突报错、默认配置下无团队文件时的 `pass chatId instead` 出路。

## D34 kiro v3 会话级思考强度：`modelSelect: session` 延伸到 `effort`（发布版本 0.5.0）

修订（2026-11-25）：原计划随 0.4.1 交付，现并入 0.5.0。

背景:`modelSelect` 此前没有单独的 D 条目，只在 Config 注释里说明:`'flag'`(默认)追加 `--model`;`'session'` 不追加，建会话/重连后调 `session/set_model`,遇 -32601/-32603 回退 `session/set_config_option(model)`。`effort` 在两种模式下都被拼成 `--effort` 旗标(D19 2026-11-05 修订)。kiro v3 不接受 `--model` / `--effort`(带了会被就绪检查判为 `unsupported-mode`),所以 README 要求 v3 用户省略 `effort`,`effort` 对 kiro v3 等于不可用。

真机探针(kiro-cli 3.6.0,`acp --agent-engine v3`,2026-11-25,探针脚本留在 /tmp,不进仓库):
- 强度走 `session/set_config_option {sessionId, configId: 'effortLevel', value}`,回复带完整 `configOptions`,可从中读到 `effortLevel.currentValue`。没有专用方法;`session/set_model` 仍回 -32603(`details` 为 `Ext method "session/set_model" has no persistence classification`)。
- 值域按模型不同:`model` 选项的 `_meta.kiro.effortLevels` 给出每个模型的合法档位，例如 claude-opus-5.5 / sonnet-5.5 / haiku-5.5 为 `low|medium|high|xhigh|max`,claude-opus-4.6 / sonnet-4.6 为 `low|medium|high|max`(没有 `xhigh`),gpt-5.6-* 另有 `none`。`hasEffort: false` 的模型(`auto`、claude-*-4.5、glm-5、deepseek-3.2 等)的 `configOptions` 里没有 `effortLevel`。
- 非法值不报错，只保持原值:`ultra`、`bogus`、给 opus-4.6 传 `xhigh` 都返回成功，值不变。对 `auto` 发 effortLevel 同样返回成功，选项仍然缺席。
- 会话级设置落盘:新进程 `session/load` 的回复里 `effortLevel` 就是上次设的值。
- **与旧数据不同的一点**:`session/new` 与 `session/load` 刚返回时，模型还在初始化,`session/new` 的回复里甚至还没有 `effortLevel`;此时立即发 set 会返回成功但值不变。约 40 ms 后 `config_option_update` 通知补出 `effortLevel`。按 25 ms 间隔重试，新建后第 1~4 次、重连后第 2~9 次才生效(≤ 240 ms)。同一时机切 `model` 均在第 1 次生效。

决策:
- **`modelSelect: session` 管模型和强度两项**:不追加 `--effort`(两条 spawn 路径共用 `buildChildArgs`,one-shot provider 同样不追加，它本来也不做会话级切换);池连接在模型之后发 `set_config_option(effortLevel)`,新建与重连各一次。`modelSelect: flag` 照旧追加 `--effort`,v2 路径不变。重连指纹不受影响(D19 本就剔除 `--effort`)。
- **配置期校验**:ACP 后端在 `modelSelect: session` 且 `effort` 非空时，值必须属于 `SESSION_EFFORT_LEVELS = low | medium | high | xhigh | max`,否则加载即报 `acp-resume: <effort | backends.<名>.effort> "<值>" is not a session effort level; with modelSelect: session it must be one of low, medium, high, xhigh, max`。理由：协议对非法值静默不生效，不校验用户就永远发现不了。只校验 session 模式:flag 模式下值交给 CLI 自己判断;Codex 后端的 `effort` 走 `turn/start`,值域不同，不受这套检查约束。这个集合是各模型档位的并集上限，具体模型可能更窄(如 opus-4.6 没有 `xhigh`),这种情况只能运行期发现。
- **按回复确认，有限重试**:回复带 `configOptions` 时检查 `effortLevel.currentValue`,不等于目标值就隔 50 ms 重发，最多 20 次(约 1 秒，探针最坏 240 ms 的 4 倍余量)。回复不带 `configOptions` 的 agent 视为已生效，只发一次。最终仍未生效时只经 `onError` 告警，分两种措辞：选项缺席(`the session's model lists no effortLevel option (it may not support effort)`)与值没变(`effortLevel stayed <当前值> (the model may not offer that level)`)。请求本身报错也只告警。三种情况都不阻断连接，与模型切换同一策略。
- agy 的强度编码在模型 ID 里,README 仍要求 agy 省略 `effort`;若 agy 配了 session 模式 + `effort`,会照样发 effortLevel 并在被拒时告警。

后果:kiro v3 可用 `modelSelect: session` + `model` + `effort` 同时钉模型与强度;`model` 缺省时强度作用于该账号的默认模型。新建会话的启动在强度未立即生效时最多多等约 1 秒。测试 591 → 597:engine.spec 3 例(session 模式经插件实际发 effortLevel 且不带 `--effort`;flag 模式与未设 effort 都不发;非法值加载报错且 Codex 的 `ultra` 不受影响),connection.spec 3 例(新建与重连各一次且在模型之后;回复显示旧值时重试到生效;选项缺席与请求失败只告警),engine helper 的 session 模式用例补 `--effort` 断言。

## D35 能力查询与客户端开关感知（2026-11-25，目标 0.5.0）

rc.5 的浏览器 Loader 按客户端模块名建行，没有将宿主插件 Config 随行交给浏览器。面板需要区分宿主关闭持久会话、后端暂时不能派工和旧宿主缺少新方法。

- 宿主在一次性 provider 注册后、持久会话开关提前返回前，独立注册只读 `acpResumeInfo/features()`。它只返回 `chatToolsEnabled`、`workflowEnabled` 和 `startToolName`。前两项来自生效配置，工具名按 `toolPrefix + 'start'` 生成。能力查询随插件卸载，不创建池、不触发检测，也不需要 tools 服务。
- 列表正文、详情正文、详情标题共用连接级能力源。首次订阅按需读取，等待能力结果时不挂载业务订阅；后续消费者共享结果。面板重开或手动刷新可重新确认。`connection/reset` 使前代能力响应失效，有订阅时立即重读。
- `chatToolsEnabled: false` 保留页签与资源地址，正文显示关闭态，可手动刷新；标题使用地址中的短会话号。开启后恢复现有数据源，空状态使用宿主给出的创建工具名。`workflowEnabled: false` 使用 D29 的只读历史模式。
- 仅 `gateway/invocation-unavailable` 选择旧协议模式：列表、详情和工作流沿用原读取方式，空状态用通用创建提示。连接错误、权限拒绝和无效响应显示读取失败，可重试。旧客户端忽略新方法，原有 Remote 的入参与返回结构保持兼容。

## D36 团队提示词按 preset 与本步工具可用性动态注入（2026-11-25，目标 0.5.0）

Dispatcher 的调度身份仍由 bundle 中的 persona 提供。角色间如何转述由宿主插件提供英文 section `acp-resume:team`，位于 `DEPLOYMENT_PERSONA_PREFIX + 1`。正文要求：当结果改变另一角色的下一步行动时，转发自足的摘要，注明来源角色、发现和接收方该做什么。

- 持久会话工具启用且 `roles: true` 时，在已有 tools 子作用域内通过 `ctx.inject(['systemPrompt', 'agentPresets'], …)` 注册。提示服务或 preset 注册表缺席时，一次性 provider 和原有工具仍可加载。
- 组装时从 `agentPresets.composedPreset(agent.ctx)` 读实际绑定，默认挂载也适用。仅对 `acp-dispatcher` 继续检查 `tools.get(teamListName(toolPrefix), scope, toolSet)`。无 Agent、其他 preset、团队工具缺席或未获本步准入都返回空字符串。section 正文不写工具名，适用于自定义前缀。
- `workflow` 只控制模板。roles 开启时，两种合法 workflow 设置使用相同的转述规则；roles 关闭仍可按 chatId 派工。`roles: false, workflow: true` 沿用 D33 的配置校验。完整覆盖 preset 配置的用户如保留旧 persona 中的手写转述句，需要自行移除重复文字。

## D37 Dispatcher 工具面按 Config 勾选（2026-11-25，目标 0.5.0）

- **声明所有者。** bundle 全局挂载主插件与独立的 `acp-dispatcher-settings` 行。后者只注入 `agentPresets`，由 Cordis fiber 持有 `register()` 返回的注销函数。更新该行会替换同 id 的当前定义，已绑定 Agent 保留引用的旧版本。主插件与 ACP 池属于另一行。
- **默认组合。** 保留 D36 后的 id、展示名、order 10、description、完整 persona 和全部子行顺序与参数。基础行是 persona、agent-instructions、time-context、tool-jobs。web、present、todo、askUser、compaction 默认开；压缩组保持两个隔离服务与三个子项。ACP 工具继承自全局插件。
- **边界。** readOnlyFs 默认关；打开后生成文件行并显式关闭 readImage、write、edit、applyPatch，再配合 fs-search 提供 read、glob、grep。工具开关同源生成 description 和 persona。团队转述延续 D36。主 Agent 的可选项不含 bash 或可写文件工具。
- **升级。** Loader 行 id 与会话持久化的 preset id 独立。合法 profile 中的旧行覆盖找不到目标时，rc.5 记录警告并继续加载。保留原来的 `config.id` 能延续会话引用，但不会搬迁覆盖内容。只读文件、禁用状态和完整自定义的迁移方法见 D26 与中英文 README。

修订（2026-11-26，0.5.1）：最初从标准模式删减工具时，一并移除了 skill 发现与加载两个子项，未单独评估这项能力。为让 Dispatcher 主 Agent 在任务匹配时加载相应指引，新增第七项 `dispatcherTools.skill`。开启时在 present 后、compaction 前加入 `skill-filesystem` 和 `tool-skill`，沿用标准模式的 Loader 表达式，在当前安装中解析 `@deepseek-ai/dsh-agent-preset` 自带的 skills 目录。可用 skill 的说明会进入主 Agent 上下文，因此默认关闭，升级后沿用 0.5.0 的工具面和 persona。

修订（2026-11-26，0.5.1）：有意更正默认 persona 的目标目录规则及对应回归夹具。此前只说目录不清楚时提问，主 Agent 即使明知用户指的是另一个仓库，也可能把自己的工作目录传给 Worker。创建 chat 前应识别目标项目、仓库或 worktree，显式传入其绝对路径；只有请求或前文明确指向调度者目录时才使用它。目标唯一就直接派工，有多个候选就列出请用户选择，无法识别则先问清目标。关闭提问工具时在对话中询问。

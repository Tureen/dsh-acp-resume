# 决策记录(DECISIONS)

按编号引用;每条含决策、依据、后果。修订时原条目就地更新并注明日期。

## D1 独立新包,不 fork 官方 subagent-acp(2026-11-04)

依据:fork 会破坏三条硬要求——现有 kiro 链路隔离(同名包替换会劫持 `provider: acp` 配置)、官方更新可跟进(rebase 负担)、客户端升级可适配(peer 面缩小到 seam 契约)。独立包注册 `acp-resume`,与官方 `acp` 并存,三条全部成立。
后果:包内自持官方 0.2.1-rc.5 源码副本;官方缺陷修复需择要摘入(面小)。

## D2 基线钉 0.2.1-rc.5,与已装 App 对齐(2026-11-03)

依据:用户 App 实测为 0.2.1-rc.5(Info.plist);错版先例:误装 0.1.0-rc.6 导致 provider 行无法激活。
后果:peer 全部 `~0.2.1-rc.5`;App 升级时同步重装并跑回归。

## D3 不接入内核续聊体系(prepareContinuable)(2026-11-04)

依据:0.2.1-rc.5 契约原文——provider 的该方法只贡献创建输入,continuation manager 随后创建并驱动**本地 Agent**;`SubagentStartRequest` 无自由字段可传"复用哪个远端会话"。外部进程续聊无法经内核表达(官方让 ACP 走 one-shot 分支、社区插件自建工具层,同因)。
后果:续聊层建于包内(会话池+自建工具);不依赖内核 continuable 接口,降低内核演进耦合。

## D4 保留 one-shot provider(2026-11-04)

依据:与官方同型的委派路径是隔离性证明与回归安全网;部分场景仍需一次性外援。
后果:`startAcpRun` 重构为连接原语的薄包装,42 个协议面用例作为不回归门槛。

## D5 自建四个模型工具(2026-11-04)

依据:D3 之下模型触达会话池的唯一途径;官方姿势 `defineTool`(@deepseek-ai/dsh-tools)+ `ctx.tools.register`,参照 tool-subagent 实现。
后果:新增 dev/peer 依赖 dsh-tools;工具不走 `ctx.subagents`,不进委派目录 UI(与外部 one-shot 一致,可接受)。

## D6 池语义(2026-11-04;同日按六维评审修订,见 D16)

- 单飞:每会话同时仅一个 prompt 在途,在途时新 send 拒绝并提示(与官方"一次一个"一致,不做排队);
- 工具并发标注:`acp_chat_start` / `send` / `list` 标并发安全,不同会话的 send 可并行;`acp_chat_close` 标独占(不与其他工具并行);同一会话的并行 send 仍由单飞拒绝;
- 降级:**仅** `session/load` 被远端在协议层拒绝(`AcpConnectionError` 的 `stage: load-session` 且 `category: protocol`,含能力门控判定的 loadSession 未声明)时降级为新会话;工具回答首行前置注记,内含固定短语 `remote session lost, started fresh`,由模型决定重述上下文。进程启动失败、传输断开、进程退出等其余重连失败直接让本次 send 失败,注册表不动,原远端会话号保留待下次重试;
- 空闲:`idleTimeoutMs`(默认 600 000)到期关进程,**注册表保留**,下次 send 重连;
- 注册表:进程内串行写,临时文件+原子改名;记录 chatId/remoteSessionId/cwd/命令指纹;文件损坏(读不了、非 JSON、结构不符)时改名为 `<路径>.corrupt-<时间戳>` 留证,经 `onWarn` 告警后以空表继续;`registryPath` 须为绝对路径(空串取默认路径);
- 取消:send 的工具取消信号让本轮在本地立即结算为 `aborted`,同时尽力发送 `session/cancel`(不等远端回应);随后作废该连接(关进程,注册表保留),下次 send 经 `session/load` 重建;
- 失败轮:结算为 `error` 的轮同样作废连接,理由同取消(子进程多半已死或状态不明);
- close:在途轮先协作取消(`session/cancel`),最多等 `disposeGraceMs` 让它结算,再释放进程;`purge` 额外删注册表条目,释放失败时保留条目并报错;拆卸/关闭对重连窗口有界:close 与 `disposeAll` 中止进行中的启动/重连窗口(池持有的 AbortController,启动竞速据此自行释放子进程),最多等 `disposeGraceMs`,超时即按已释放处理,窗口晚到的连接一律丢弃并关进程(2026-11-04 补);
- 环境:沿用官方凭据清洗 + 显式 env 叠加。

## D7 session/load 参数形状(2026-11-03 实测)

kiro-cli 2.29(v2 引擎):`session/load {sessionId, cwd, mcpServers:[]}` 实测可用;`session/list` v2 无(v3 才有)。重连必须回放原 cwd。
后果:注册表存 cwd;发现远端会话列表依赖 kiro 自身(`kiro-cli chat --list-sessions`)。

## D8 测试豁免:真实子进程类 25 例(2026-11-04)

依据:官方测试直读包内 `src/spawn.ts`,npm 分发包不含该模块;相关行为(销毁梯子/环境清洗/进程退出细节)阶段二不修改,由官方仓库测试覆盖。
后果:`spawnSubprocess` 导入失败的 25 例豁免;42 个协议面用例为有效回归面。

修订(2026-11-04,D16):豁免经条件导入官方 checkout 的 `spawn.ts` 恢复(路径默认 `/Users/Tulane/Developer/open-source-projects/deepseek-harness`,可用 `DSH_OFFICIAL_CHECKOUT` 覆盖),24 例重新纳入回归面;checkout 缺席时这 24 例自动跳过。全绿基线 131(协议面 67 + connection 23 + pool 29 + tools 12)。

## D9 mock 服务器扩展 session/load(2026-11-04,实施第 3 步)

官方 mock 无 load 分支;扩展为内存会话表:load 命中恢复历史,未命中可配置报错/空,支撑池生命周期测试。

## D11 撤销 run.ts 消重重构,双实现并存(2026-11-04)

决策:第 2 步原计划"startAcpRun 重构为 openAcpConnection 薄包装"实施后回归退化 5 例,当场撤销,run.ts 恢复官方原版;connection.ts 作为池专用姊妹实现与官方驱动并存。
依据:官方测试对启动失败消息(`subagent-acp: Subagent failure ...`)与 prompt 失败分类有逐字断言,任何语义搬移都是回归面;"基线不动、增量在自有文件"是本包的立身原则,DRY 收益不抵风险。
后果:run.ts 与 connection.ts 存在受控重复(约 200 行语义同源);官方升级时 run.ts 面天然安全,connection 面自行维护;42+6=48 绿回归面继续有效。

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

结构化错误契约:连接启动失败统一抛 `AcpConnectionError`,带 `stage`(`initialize` / `new-session` / `load-session`)、`category`(`protocol` / `transport` / `process-exit` / `process-start` / `unknown`)与可选 `jsonRpcCode`(远端 JSON-RPC 拒绝时的错误码)。`message` 只含固定安全事实,原始错误放 `cause`。spawn 本身抛错诊断为 `stage: initialize; category: process-start`。池的降级判定只读这两个字段,不解析文案。

能力门控:`session/load` 前检查 `initialize` 响应的 `agentCapabilities.loadSession`,不为 `true` 即按 `load-session` + `protocol` 失败处理(从而降级新会话)。**已真机确认(2026-11-04)**:kiro-cli 声明 `loadSession`——0.1.3 装机后行为验证,SIGKILL 进程后 `session/load` 重连恢复暗号上下文且无降级注记(若未声明,门控必触发降级,注记必现)。

已知遗留(本轮不修):
- 注册表仍是单写者设计,多个宿主进程共用同一路径无文件锁(D14 已记)。

已修(2026-11-04):挂起的重连窗口卡死拆卸(测试阶段探针发现:load 永不返回时 `disposeAll` / `close` 无界等待),改为中止窗口 + `disposeGraceMs` 兜底(D6 close 条)。

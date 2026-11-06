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
修订(2026-11-04,D19):工具增至五个,新增 `acp_chat_steer`(给在途轮插话,标并发安全)。
修订(2026-11-04,D17):宿主装有 jobs 服务(`ctx.jobs`)时,`acp_chat_send` 不再等整轮回答,改为把这一轮注册成后台任务(job),立即返回 jobId;回答流式写进该 job 的输出,完成通知由宿主的 tool-jobs 在会话内送达,模型用 `job_output` 读、`job_kill` 停。无 jobs 服务时 send 保持原同步语义。其余三个工具不变。

## D6 池语义(2026-11-04;同日按六维评审修订,见 D16)

- 单飞:每会话同时仅一个 prompt 在途,在途时新 send 拒绝并提示(与官方"一次一个"一致,不做排队);
- 工具并发标注:`acp_chat_start` / `send` / `list` 标并发安全,不同会话的 send 可并行;`acp_chat_close` 标独占(不与其他工具并行);同一会话的并行 send 仍由单飞拒绝;
- 降级:**仅** `session/load` 被远端在协议层拒绝(`AcpConnectionError` 的 `stage: load-session` 且 `category: protocol`,含能力门控判定的 loadSession 未声明)时降级为新会话;工具回答首行前置注记,内含固定短语 `remote session lost, started fresh`,由模型决定重述上下文。进程启动失败、传输断开、进程退出等其余重连失败直接让本次 send 失败,注册表不动,原远端会话号保留待下次重试;
- 空闲:`idleTimeoutMs`(默认 600 000)到期关进程,**注册表保留**,下次 send 重连;
- 注册表:进程内串行写,临时文件+原子改名;记录 chatId/remoteSessionId/cwd/命令指纹;文件损坏(读不了、非 JSON、结构不符)时改名为 `<路径>.corrupt-<时间戳>` 留证,经 `onWarn` 告警后以空表继续;`registryPath` 须为绝对路径(空串取默认路径);
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
- **依赖**:`@deepseek-ai/dsh-jobs` 进 peer + dev(`~0.2.1-rc.5`),peer 标 optional:源码只做类型导入,构建产物不在运行时引用它(`lib/*.js` 中无该包名);`@deepseek-ai/dsh-jobs-local` 只进 dev(测试用真注册表)。

后果:模型发出 send 后可继续工作,回答经完成通知 + `job_output` 取回;面板不受影响(数据源仍是池注册表,PANEL-DESIGN.md 不动)。已知边界:会话正处于释放中(空闲释放刚触发)时 send 要先等释放完成才占住会话,这一小段窗口内同会话的第二个后台 send 能通过前置检查,随后它的 job 以 `already has a prompt in flight` 结束为 `failed`,不会产生第二条连接(2026-11-04:此描述自 D6 释放条 P2-1 修订起成立;此前释放一开始就移出活跃表,第一个 send 不等待直接重连)。

已知差异(2026-11-04 资源审计 P3-1,不修行为,只记录):拆卸引起的 job 结局文案不统一。插件卸载、jobs 服务卸载或属主销毁时轮在途,job 为 `killed`,detail 是 `the agent stopped before finishing…`,读起来像 agent 自己停下;卡在重连窗口时被插件卸载,job 为 `failed: acp-resume: pool already disposed`;被面板/工具 close 或 purge 打断重连窗口,job 为 `failed: …was released before the prompt started`。三者都是安全失败(进程已释放、`done` 已结算),区别只在给模型的说法。

## D19 默认切 kiro v3 引擎 + 插话工具 `acp_chat_steer`(2026-11-04)

问题:kiro-cli 已升到 2.37.1。v2 默认引擎下,会话进行中再发 prompt 会被拒("Prompt already in progress"),模型没有办法在长任务跑到一半时补一句指示;只能 `job_kill` 重来。同时想用上 v3(KAS 引擎)。

依据(全部真机实测,kiro-cli 2.37.1):
- `--agent-engine v3` 启用 KAS 引擎,`initialize` 声明 `sessionCapabilities{list,close,delete,fork}`。
- 私有扩展请求 `_session/steer {sessionId, message}` 在 v2 / v3 都能用:v3 返回 `{queued:true, messageId}`,且回答流里出现 `[STEERING <id>: …]` 归因块。两个引擎的 `initialize` 都**不声明**它,ACP 规范里也没有 steer——所以只能按「方法是否存在」试探,不能按能力声明判断。
- **v2 创建的会话可被 v3 `session/load`,上下文完好**(实测)。这是引擎默认值可以直接切、不会让旧会话作废的前提。

决策:
- **`agentEngine` 配置**:`v1 | v2 | v3`,默认 `v3`。启动子进程时在 args 末尾追加 `--agent-engine <值>`;池的 `specBase` 与 one-shot provider 两处都追加。用户的 `args` 里已含 `--agent-engine`(含 `--agent-engine=v2` 写法)时不追加,以用户显式为准。已知限制:不认这个旗标的 agent 没有关闭追加的开关(本包目前只面向 kiro-cli)。
- **指纹放宽(修订 B12/D16 的重连校验)**:重连时 `command` 仍须严格相等;`args` 比较前**剔除 `--agent-engine` 及其值**(两种写法),其余差异照旧拒绝。理由:会话跨引擎可加载已实证;若某个引擎确实读不了,`session/load` 会被协议级拒绝,自然走 D6 的降级新会话兜底(注记照旧),不需要在指纹层提前拦。注册表记录的 args 含追加后的旗标,旧记录(无旗标)与新配置比较时同样等价。
- **`acp_chat_steer(chatId, message)`**:
  - 连接层 `AcpConnection.steer(message)` 对活连接发 `_session/steer {sessionId, message}`;`-32601 Method not found` 抛 `AcpSteerUnsupportedError`(按类识别,不解析文案);其他错误原样上抛。应答里 `queued` 缺省按 true 处理(请求成功即被接受),`messageId` 有则透传。
  - 池层 `steer(chatId, message)` 要求会话有活连接且有在途轮(`busy`);否则报「没有在途轮,无可插话,改用 send」。未知 chatId 与 send/close 同格式。steer **不占轮、不改 busy**,同一会话可连续多条,先后顺序由 kiro 侧排队,因此不与 D6 的单飞冲突。
  - 工具层标并发安全。成功返回 `queued`(有 `messageId` 一并给出)。说明文案写明:排队的插话在下一个工具/消息边界生效,不打断当前步;要立即停止用 `job_kill` / `acp_chat_close`。agent 不支持时抛「当前 agent 不支持插话」类工具错误,并提示改为等待或停止后重发。
  - 与后台 job 并存:steer 不创建 job、不改 job 状态,在途 job 照常结算;插话在输出流里留下的归因块算作 agent 的回答文本,原样进入 job 输出(形态由 kiro 决定,本包不解析)。
- 不做:不为 steer 增加「自动探测并缓存支持情况」;每次调用直接试,失败即降级文案,避免缓存过期。

后果:`acp_chat_*` 工具从四个变五个;kiro 新建会话默认走 v3 引擎(`--agent-engine v3`),旧会话继续可续;测试 172 → 188(steer 5、engine 7、pool 指纹放宽 3、jobs 并存 1)。未验证:真机 v3 引擎下 `session/prompt` 的流式分块与 v2 的差异(本包的 mock 无法覆盖),留待装机冒烟。

修订(2026-11-05,显式钉模型/档位):
- **新增 `model?` / `effort?` 两个可选 Config 字段**。v3 的 ACP 会话默认 `model=auto`(服务器按任务路由,`effort` 不可控);用户要求能显式钉死。CLI 已支持 spawn 级 `--model <id>` 与 `--effort <level>`,作用于该进程启动的会话;本包一会话一进程,语义干净。schemastery 3.18.5 下不写 `.required()` / `.default()` 的 `z.string()` 即可选,缺省时结果里不出现该键,因此只有用户显式设了才拼旗标,否则保持 `auto`。
- **argv 拼接与 `--agent-engine` 同款**:两条 spawn 路径(池 `specBase` 与 one-shot provider)在用户 `args` 未显式含 `--model` / `--effort`(`--model x` 与 `--model=x` 两种写法都识别)且 Config 有值时追加;用户显式写了则不追加。空串按未设处理。
- **生效语义是 spawn 级**:对既有会话,钉死的模型/档位要等下次重连(新进程)才应用,运行中进程不变——文档与 Config JSDoc 都写明这点,避免用户误以为改配置能即时切活跃会话的模型。
- **指纹排除清单扩为三旗标**:重连指纹比较时剔除的从 `--agent-engine` 扩到 `--agent-engine` / `--model` / `--effort`(各自的分离与 `=` 写法及值)。理由:`auto` 本身就在会话内按任务动态换模型,会话存的是对话不是模型;模型/档位差异不像 `command` 差异那样构成"换了一个 agent"。实现上原 `stripAgentEngine` 泛化为 `stripVolatileFlags`;追加逻辑泛化为 `buildChildArgs(args, {engine, model?, effort?})`。(2026-11-05 精简:`stripAgentEngine` 别名与 `withAgentEngine` / `hasAgentEngineFlag` 两个薄封装为零生产引用的死导出,已删除;生产只用 `buildChildArgs` / `stripVolatileFlags`。engine.spec 的两例改以这两个活函数直接断言,等价覆盖、例数不变。)
- 测试 188 → 266 的其余增量含本轮 7 例(engine helper 2 + 两条 spawn 路径 4 + pool 模型/档位指纹 1;其余为上游其他改动)。变异自检:model/effort 不追加、指纹漏剔、忽略用户已设旗标、空串当有效值、one-shot 路径漏拼、指纹剔除过头——六类故意改坏均被测试抓红。

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
  - `event`:`session-lost`(`session/load` 被协议拒绝,新开远端会话顶替;随后同一次 send 还会记一条 `freshSession: true` 的 `turn`)、`reconnect-failed`(send 在 prompt 发出前失败:load 的非协议类失败、进程起不来、已记录的 agent 指纹与当前配置不符;带上未发出的消息与错误文案)。拆卸引起的中止(`was released before the prompt started`)与池已销毁不记。
- **不记的**:steer(不是轮)、send 在做任何事之前就被拒绝的情形(未知会话、在途、信号已中止)、启动(start)。
- **写入点**:`AcpSessionPool.send` 的轮结算处(紧跟注册表更新,因此 jobs 与同步两种 send 都覆盖,tools.ts 不改)与重连窗口/失败处。写之前复查注册表里该会话还在,与"结算前 purge 不得复活记录"同一条规则,所以 purge 之后不会留下孤儿日志。
- **与 D6 / D17 的边界**:注册表字段与版本不变;单飞、降级判定(只有协议级 load 拒绝才降级)、取消条、空闲释放、释放时序全部不动;日志写失败**只经 `onWarn` 告警,绝不改变轮的结果**(同 D6 "轮结果优先于拆卸失败");`purge` 在删注册表条目后删日志文件,删失败只告警;`close` 保留日志。
- **容量**:单条上限——`message` 8192 字符、`output` 32768 字符(按码点截,不拆代理对,截断时记 `messageTruncated` / `outputTruncated`)、`diagnostic` 与 `error` 2000 字符;每会话保留最近 200 条,文件超过 400 条时用"临时文件 + 原子改名"裁回 200 条(条数在进程内计数,首次写入时读一次文件)。
- **容错**:读逐行解析,不能解析或形状不对的行跳过;进程崩溃留下的半行,下一次追加先补换行;`seq` 取文件中最大可读值 + 1。chatId 作文件名前校验(只允许字母数字与 `._-`,首字符为字母数字),不合法则告警并不读写,防路径逃逸。
- **host 读接口**(`AcpResumePanelService`,与 list/close/purge 同款 source 模式,参数自校验):`turns(chatId, limit?)` → `{ chat, entries, total }`,`entries` 是最近 `limit` 条(默认 50,上限 200)的**预览**(message / output 各至多 120 字,附 `messageMore` / `outputMore` 标志),`chat` 是该会话的注册表行,所以详情页一次调用拿全;`turn(chatId, seq)` → 单条全文。未知会话 `acp-resume/unknown-chat`(同现有错误码),日志里没有该 seq `acp-resume/unknown-turn`(新),参数非法 `gateway/bad-request`。与研究 §3.4 的偏差:研究草图写的是 `detail / turns(before, limit) / turn`;实施时合并 `detail` 进 `turns`(省一次往返),并把分页改成只给 `limit`(加载更早 = 提高 `limit`),因为 5 秒轮询每次整体重取,游标会和裁剪、追加互相竞争。
- **client**:新增页签类型 `acp-resume.chat`(`id: dsh-acp-resume/chat`),`patterns: ['dsh-resource://acp-resume-chat/**']`,`canOpen` 校验地址,不设 `priority`(默认 extension)、不设 `multiple`、不进引导页;正文与 chip 标题各占 `sidebar.right.pane.tab` / `.title` 槽位。同一地址聚焦已有页签,关一个不影响其他,刷新后凭持久化的地址恢复。`ChatDetailSource` 每个 chatId 一个、正文与标题共用,有订阅者才每 5 秒轮询;答 `unknown-chat` 时发布 `gone` 并停轮询。列表卡片 `onClick` 打开详情,释放/删除按钮 `stopPropagation`,标题是真按钮以支持键盘。client 依赖面不变(`inject` 仍是 `slots / locale / sidebarRightTabs`,另有 `connection` 的响应式等待)。
- **隐私**:日志以明文保存发给外部 agent 的消息与回答,和 kiro 自己的会话存储同级;`purge` 随记录一并删除。v2 不提供关闭开关(用户未要求);若需要,加 Config `recordTurns` 即可,是纯增量改动。
- **兼容**:旧注册表、旧会话无日志,详情页显示空历史占位,不迁移;降级回 v1 后日志文件被忽略;新 host 配旧 client 无影响(只多两个没人调的方法),旧 host 配新 client 时详情页显示读取失败条而列表不受影响;`PooledChatInfo` 不变。

后果:池多一个 `TurnLog` 成员与 `chatInfo` / `turnEntries` 两个只读方法;面板 host 半 3 → 5 个 Remote 方法;client 半新增 4 个文件;测试 192 → 259(见 AGENTS.md「期望测试基线」)。未验证:真机 GUI 中官方侧栏对第二个页签类型、chip 标题槽与"同地址聚焦"的实际表现(以官方源码与 jsdom 测试为依据,装机验收清单见 PANEL-DESIGN.md §2.6)。

D15 追注(2026-11-04):v2 增加会话详情页签,见 D18;D15 "只读视图 + 资源操作、不含输入框"的边界不变。

D18 修订(2026-11-05,D21):轮询节奏由固定 5 秒改为自适应(5 秒 ↔ 静默退 30 秒),并要求数据源快照引用稳定;详见 D21。数据/工具语义不变。

## D20 会话归属:元数据 + 视图过滤,不是访问控制(2026-11-05)

问题:面板 / `acp_chat_list` 展示的是 profile 级全局注册表,同一台机器上所有 DSH 会话看到同一份持久会话。用户想知道"哪条是我这个会话开的",但不希望动跨会话续聊的能力(任何会话都能对任何 chat 续聊,是本包的立身特性,D3/D5)。

用户裁定(轻量方案):注册表记录创建会话;面板加过滤;模型工具不设访问限制。

决策:
- **归属是元数据,不是权限边界。** 新增可选 `ownerSessionId` 记录"哪个 DSH 会话开的",仅供显示与视图过滤。池的每个方法、五个模型工具、host 的每个 Remote 方法都照旧服务每一条 chat——不按 owner 拦截任何读写。跨会话续聊不变。
- **采集点(tools.ts)**:`acp_chat_start` 的 execute 里取 `exec.agent?.id` 作为 `ownerSessionId` 传给 `pool.start`。`Agent.id` 即 `SessionId`(`@deepseek-ai/dsh-agent` 契约),与 D17 后台任务的 `owner: exec.agent.id` 同源。无 agent 的上下文(官方 spec setup、无会话的直接调用)不带该字段。只有 `start` 采集;`send`/`list`/`close`/`steer` 不涉及。
- **注册表(pool.ts)**:`RegistryEntry` 与 `PooledChatInfo` 增可选 `ownerSessionId`;`PoolStartOptions` 增该字段(trim,空串视为无)。注册表 **version 不动**;`settledEntry` 用 `...entry` 透传,续聊/重连/结算都保留它。`listChats` 照 `label` 的姿势透出——有才出键,无则省。旧注册表无此字段 = **「来源未知」**,读入不告警、不迁移。
- **host 半(panel.ts)**:零改动。字段随 `PooledChatInfo` 流过 `list` 与 `turns.chat`。**不做服务端过滤**——过滤是纯视图关注,client 自己有会话身份,服务端按 owner 过滤反而会把"看得到但不是我开的"这一信息藏掉,与"全局可见、可溯源"的裁定相悖。
- **client 半(ChatsPanel)**:会话型 seat 的 `inject(sessionId)` 提供当前会话 id(不引官方 client 类型,沿用结构化类型纪律)。头部加过滤切换「全部 / 本会话」,**默认「全部」**(理由见下)。无会话在屏时不提供该切换。每张卡片元信息行标来源:本会话=不标(常态、无需噪音)、其他会话=标「其他会话」、旧记录=标「来源未知」。计数随视角:全部态「共 N 条」,本会话态「本会话 M 条 / 共 N 条」;本会话态为空时显示该计数提示而非"暂无持久会话"空态(chat 存在,只是不属本会话)。文案中英齐全。
- **默认过滤视角取「全部」**:新会话刚打开面板时,「本会话」视角必然为空(它还没开过任何 chat),默认到它会让用户以为"持久会话凭空消失了"。默认「全部」保证面板始终展示真实全貌,用户主动点「本会话」才收窄。这也符合"可见优先、过滤是叠加"的轻量定位。

旧记录语义:`ownerSessionId` 缺失恒为「来源未知」,永不猜测、永不回填。无会话在屏(`currentSessionId` 为 undefined)时,有主的 chat 也无从比对,一律显示为「其他会话」(没有"我"可对照),这是刻意的——避免把别的会话开的 chat 误标成本会话。

后果:注册表多一个可选字段;`PooledChatInfo`/`PanelChat` 各加一字段;ChatsPanel 加过滤态与来源标注;测试 271 → 280(pool +5、client +5)。host 半与注册表 version 不变。已知局限:`ownerSessionId` 只在 `start` 落一次,事后无法为旧 chat 补齐;真机 GUI 中 `inject(sessionId)` 是否在无会话时确为 undefined [未验证],以 jsdom 测试与官方 seat 契约为据,装机冒烟确认。

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

开关:`allowChatJobWait`(默认 `false`,即默认禁止)。设 `true` 时不注册监听器,恢复 `wait` 硬等。无 jobs 服务时本就不注册(与 send 变体的条件化一致)。

后果:新增 `src/job-wait-gate.ts`、`tests/job-wait-gate.spec.ts`(13 例,含经真实 `ToolRuntime` 派发的一例:拒绝时工具本体未跑、结果 `isError` 且以 `Error: job acp-chat-` 开头);测试 295 → 308(评审修订补 stopping 放行一例,重挂载回归并入既有监听用例;send 文案锁定并入 jobs.spec 既有用例)。

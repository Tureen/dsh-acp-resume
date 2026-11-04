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

## D6 池语义(2026-11-04)

- 单飞:每会话同时仅一个 prompt 在途,在途时新 send 拒绝并提示(与官方"一次一个"一致,不做排队);
- 降级:`session/load` 失败 → 新会话,返回固定文案 `remote session lost, started fresh`,由模型决定重述上下文;
- 空闲:`idleTimeoutMs`(默认 600 000)到期关进程,**注册表保留**,下次 send 重连;
- 注册表:进程内串行写,临时文件+原子改名;记录 chatId/remoteSessionId/cwd/命令指纹;
- 取消:send 的工具取消信号 → `session/cancel` + 等结算;
- 环境:沿用官方凭据清洗 + 显式 env 叠加。

## D7 session/load 参数形状(2026-11-03 实测)

kiro-cli 2.29(v2 引擎):`session/load {sessionId, cwd, mcpServers:[]}` 实测可用;`session/list` v2 无(v3 才有)。重连必须回放原 cwd。
后果:注册表存 cwd;发现远端会话列表依赖 kiro 自身(`kiro-cli chat --list-sessions`)。

## D8 测试豁免:真实子进程类 25 例(2026-11-04)

依据:官方测试直读包内 `src/spawn.ts`,npm 分发包不含该模块;相关行为(销毁梯子/环境清洗/进程退出细节)阶段二不修改,由官方仓库测试覆盖。
后果:`spawnSubprocess` 导入失败的 25 例豁免;42 个协议面用例为有效回归面。

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

# 资源释放专项审计(RESOURCE-AUDIT)

审计日期:2026-11-04。对象:开工时的工作树(HEAD `1879ae2` + 未提交的 client 分组改动)。审计期间这批改动已由另一会话提交为 `98f93ed` / `31288bf`;逐文件比对确认 `src/` 与 `31288bf` 完全相同,所以结论也适用于当前 HEAD。

## 方法

- 仓库整体复制到 `/tmp/acp-audit` 后在副本里工作。原仓库只写了本文件,没有 git 写操作,也没改 src/tests。
- 副本基线:`vitest run` 172 绿。加入 26 个探针用例后全量 198 绿;两次全量跑完后用 `ps` 检查,没有残留的 mock 进程。
- 探针分三层:
  - **插件层**:真实 `@deepseek-ai/dsh-subprocess-local`(macOS 上以独立进程组 detached spawn)、真实 `jobs-local`、真实 `AgentRegistry`。子 agent 换成 `tree-agent.ts`:它先 spawn 一个同进程组的孙进程,再运行 mock 服务器,用来模拟 kiro-cli → kiro-cli-chat 的进程树。用 `process.kill(pid, 0)` 和 `ps` 查每个 pid 是否还活着。
  - **池/工具层**:真实池和真实 jobs-local,spawn 换成计数包装。每个句柄记三件事:`stdin.end` 次数(等于进入销毁梯子的次数)、`terminate` 次数、是否已退出。"恰好释放一次"的判定标准是:每个句柄都是 `stdin.end` 1 次且已退出。
  - **真机 kiro**:真实 subprocess-local 拉起 `kiro-cli acp`,只发 `initialize`,不建 kiro 会话。用 `pgrep`/`ps` 查进程树。
- 另外三种计数手段:
  - 计时器:真实计时器外包一层账本,按调用栈过滤出 `src/` 创建的计时器;另做一轮 `vi.useFakeTimers({ shouldAdvanceTime: true })`,用 `vi.getTimerCount()` 计数。
  - abort 监听器:给 `EventTarget.prototype.add/removeEventListener` 打补丁记账。只统计直接调用方在 `src/` 的注册;`once` 监听器触发即算移除。
  - 句柄:`process.getActiveResourcesInfo()` 和 `lsof -p` 统计 pipe/unix fd。
- 探针跑完后,结论写入本报告,副本已删除。

---

## Findings

### P0(确定泄漏/挂死):无

所有探针都没有出现进程残留、job 不落定、计时器或监听器残留。

### P1(特定交错下泄漏):无

审计设计的每条交错都证实子进程最终恰好释放一次(见「已实证无泄漏」)。下面 P2 两条属于"释放偏晚或与新进程重叠",资源最终都回收了,不算泄漏。

### P2-1(已修:2026-11-04,释放时序重排,见 pool.ts release) 空闲/显式释放挡不住紧随其后的 send:新旧两个进程同时挂在同一远端会话上

- **位置**:`src/pool.ts:530`(`release` 在 `await chat.conn.dispose()` 之前就同步执行 `this.live.delete(chatId)`);`src/pool.ts:363`(send 里"等释放完成"的分支)。
- **触发路径**:会话空闲、没有在途轮。这时发生 close,来源可以是空闲计时器到期、`acp_chat_close` 或面板的"释放"按钮。`release` 同步把会话移出 `live`,随后旧进程进入 EOF 收尾窗口:kiro 实测约 2 s,上限 `disposeEofGraceMs + disposeGraceMs`(默认 9 s)。窗口内到达的 send 看到的 `existing` 已经是 `undefined`,会直接走重连:spawn 新进程,对同一个 remoteSessionId 发 `session/load`。`:363` 的等待分支只有在 release 还在 `settleWithin` 等在途轮时才走得到;到那时 `busy` 仍为 true,send 在更前面的单飞检查就被拒了。所以这个分支实际上几乎不可达。
- **实证**:探针 `probe②/overlap`。旧 mock 开启 `MOCK_FLUSH_ON_EOF`(EOF 后 400 ms 才落盘退出),close 不等待就立刻 send。新进程进入 `session/load` 的那一刻,**旧进程仍存活(alive=true),EOF 落盘尚未完成(flush done=false)**。job 结果 completed,两个句柄最终各进梯子 1 次并退出。
- **影响**:
  - 资源不泄漏,但同一 kiro 会话短时间内有两个进程。如果 kiro 在退出时才写最终状态,新连接 load 到的可能是缺最后一轮的旧历史。这是推断,未在真机 kiro 上验证。
  - 面板和 `acp_chat_list` 在旧进程还活着时就显示 released。
  - D17「已知边界」的描述与实际不符。D17 写的是"释放中 send 先等释放完成;第二个后台 send 能过前置检查、随后 job 以 failed 结束"。实测(`probe③/release-race`)是:第一个 send 不等待,直接重连;第二个 send 因 `starting` 占位,在前置检查就被拒为工具错误,不生成 job。全程 spawn 2 次,没有第三条连接。
- **修复建议**:把 `release` 里的 `live.delete` 挪到 `await chat.conn.dispose()` 之后,`closing` 照旧在一开始就设置。改完后:
  - send 会走 `:363` 的既有等待分支,等旧进程退出后再重连;
  - `armIdle` 已有 `closing !== undefined` 守卫,不会重新上计时器;`disposeAll` 对正在关闭的会话拿到的是同一个 promise;
  - `listChats().active` 会如实保持 true,直到进程真正退出;
  - D17 的已知边界描述随之变得准确。
  改动需先按 AGENTS.md 修订 D6 的 close 条。

### P2-2(已修:2026-11-04,等待上限=EOF+2×SIGTERM 宽限并封顶,见 windowGraceMs) `disposeAll` / `close` 对重连窗口的等待上限短于窗口自身的销毁梯子:先返回,子进程后退出

- **位置**:`src/pool.ts:510`(`abortWindow` 用 `settleWithin(window.promise, disposeGraceMs)`);`src/index.ts:172`(插件 fiber 拆卸 await 的就是这个 promise)。
- **触发路径**:send 或 start 正在重连/启动窗口里,例如 `session/load` 迟迟不答。这时插件卸载,或者对该会话调 close。窗口被中止后,`openAcpConnection` 会先跑完整销毁梯子再 reject:EOF 窗口 `disposeEofGraceMs`,然后 SIGTERM,再等 `disposeGraceMs`,再 SIGKILL。池却只等 `disposeGraceMs` 就返回。
- **实证**:探针 `probe①/window`,真实 subprocess-local,agent 忽略 EOF 但响应 SIGTERM:
  - graces 500/500 时:`dispose()` 502 ms 返回,此刻 2/2 个 pid 存活,512 ms 全部退出。
  - **默认 graces 6000/3000 时:`dispose()` 3000 ms 返回,此刻 2/2 个 pid(agent 与孙进程)存活,6007 ms 才全部退出**。job 在子进程退出后以 `failed: acp-resume: pool already disposed` 落定。
  - 如果 agent 连 SIGTERM 也不理,差值最大可到约 6 s(9 s 减 3 s)。
- **影响**:不泄漏。梯子在后台继续跑完;宿主拆 subprocess-local 时会 terminate 并等所有存活句柄(官方 `subprocess-local/src/index.ts:122-150`),进程退出钩子也会 SIGKILL 进程组(同文件 `:92-99`);job 也是在子进程消失之后才落定,符合 `done` 的契约。偏差在两处:
  - 插件 fiber 报告"已拆卸"时子进程还活着。如果是插件重载,新池可能在旧窗口进程退出前就对同一会话发起 load,与 P2-1 是同一类重叠。
  - close 在窗口进程退出前就返回"已释放"。好在 `starting` 占位要等窗口真正结束才清除,期间新 send 会被拒为"in flight",不会多建连接。
- **修复建议**:把 `abortWindow` 的等待上限改为梯子自身的上界,例如 `disposeEofGraceMs + 2 × disposeGraceMs`。D16 要防的是"挂住的 load 卡死拆卸",而中止信号已经能让启动竞速立即结束、转入有界梯子,所以加长上限不会让这个风险回来。注意:`pool.spec.ts` 的两例"bounded time"断言(`< 1500ms`,graces 500/500)需要同步调整。

### P3-1 拆卸引起的 job 结局文案不区分原因

- **位置**:`src/tools.ts:127`、`src/tools.ts:130`。
- **实证**(探针日志):
  - 插件卸载时有在途轮:job 结局为 `killed`,detail 是 "the agent stopped before finishing; the chat may hold a partial turn…",读起来像 agent 自己停了。
  - 插件卸载时在重连窗口:`failed: acp-resume: pool already disposed`。
  - 面板 purge 或 close 时在重连窗口:`failed: …was released before the prompt started`。
- 都是安全失败,只是给模型的信息不一致。如果要改,可以在 `runTurnAsJob` 里识别池已销毁或被释放的情况,统一映射为 `killed` 并写明原因。可选。

### P3-2 `job_kill` 到 job 落定的延迟 = 一次销毁梯子

- **位置**:`src/pool.ts` send 内 aborted 轮的 `await this.close(chatId)`。
- 官方契约要求 `done` 在释放资源之后才 resolve(`packages/jobs/jobs/src/types.ts:158-171`)。本包照此执行:kill 之后,job 会在 `stopping` 状态停留到子进程退出为止。真机 kiro 收到 EOF 后约 2 s 退出(探针 H1);不合作的 agent 最多停留 `disposeEofGraceMs + disposeGraceMs`。这是契约要求的行为,不需要修。

### P3-3 `observeOutcome` 的 `AbortSignal.timeout` 无法提前清除

- **位置**:`src/connection.ts:267`;官方逐字副本 `src/run.ts:390` 里也有同样写法(D11,不改)。
- 观察提前结束后,这个原生计时器还会存活到 `disposeGraceMs` 才触发。它不保活进程(unref),时长有上界,不累积。不需要修。

### P3-4 两处未占位的 await 可能让后发的 send 抢到会话

- **位置**:`src/pool.ts:363`(等 closing)和 `src/pool.ts:368`(先关闭已死进程再重连)。
- 在这两个 await 期间,同会话的第二个后台 send 能通过 `assertSendable`。读码推断:先 await 完的一方占住会话,另一方的 job 以 "already has a prompt in flight" 结束为 failed,不会产生多余连接。与 D17 已知边界同类。`:368` 路径的单 send 已实证无泄漏(`probe②/dead-idle`)。

### P3-5 测试基建:mock 处于 gate/hold 状态时不响应 stdin EOF,测试进程被硬杀会留下孤儿进程(今晨孤儿的可能成因)

- **位置**:
  - `tests/mock-acp-server.ts:212` / `:223`:NEWSESSION / LOAD gate 用 `setTimeout` 轮询等待;
  - `:258`:`MOCK_PROMPT_HOLD` 的 `fs.watch`;
  - `:376` / `:411`:TRAP_SIGTERM / IGNORE_EOF 的 `setInterval`;
  - `tests/helpers/node-spawn.ts`:没有进程组,`:54` 的 SIGKILL 计时器是 unref 的。
- **实证**:探针 `orphan-host.ts` 用 nodeSpawn 拉起 hold 状态下的 mock,然后宿主 `SIGKILL` 自己。3 s 后 mock 仍在运行,**ppid=1**,已手动 kill 并清理临时目录。正常结束的全量测试不会触发这个问题:两次全量跑完都没有孤儿。只有测试进程被外部硬杀(工具超时、`kill -9`)时才会出现。
- **建议**:在 mock 的 stdin `end` 事件上直接 `process.exit`,刻意测试 EOF 行为的三种模式(`MOCK_IGNORE_EOF` / `MOCK_TRAP_SIGTERM` / `MOCK_FLUSH_ON_EOF`)除外。也可以让 nodeSpawn 以 detached 方式启动,并在测试进程的 `exit` 事件里对进程组发 SIGKILL。

### P3-6 测试 helper 的 `waitForExit` 不移除 abort 监听器

- **位置**:`tests/helpers/node-spawn.ts:45`。
- 只影响测试,而且挂在短命的 controller 上,没有实际危害。生产路径 subprocess-local 有配对移除(官方 `managed-owner.ts:50-54`)。监听器账本最初把这些计入 `src/`(调用栈经过 `run.ts:177`),按直接调用方过滤后排除。

---

## 已实证无泄漏

| # | 场景 | 结论 | 探针方法 |
|---|---|---|---|
| 1 | 插件 fiber dispose:2 个长 job 流式中 + 1 个空闲会话(合作型 agent) | 6/6 个 pid(3 个 agent 与 3 个孙进程)在 `dispose()` resolve 前全部退出;两个 job 都是 `killed`;用时 509 ms | 插件层,真实 seam + tree-agent,`process.kill(pid,0)` |
| 2 | 同上,agent 不理 `session/cancel`(`MOCK_IGNORE_CANCEL`) | 6/6 退出,job `killed`,用时 1024 ms。轮靠 settleWithin 到时后关管道、sdk 拒绝挂起请求来结算,不会挂死 | 同上 |
| 3 | jobs 服务 dispose 时有 job 在途 | job `killed`,进程树退出,用时 512 ms | 插件层 + jobs `settled` 事件 |
| 4 | 属主 agent 销毁(`disposeOwned`) | 进程树在属主拆卸 resolve 前退出;job 记录被丢弃(剩 0) | 插件层 + liveAgent |
| 5 | tools 服务卸载时有 job 在途 | 4 个工具全部注销;job 继续跑完(completed);进程留在池里,插件 dispose 时退出 | 插件层 |
| 6 | `job_kill` 打在流式中途,连续 kill 两次 | `killed`;job 落定时句柄已经 `stdin.end`×1 并退出(`done` 晚于释放);cancel 可重复调用 | 计数 spawn + 真实 jobs-local |
| 7 | `job_kill` 打在重连窗口(load gate) | `killed`;start 与 reconnect 两个句柄各进梯子 1 次并退出;会话仍可发送 | 同上 |
| 8 | `job_kill` 打在空闲时(job 已完成) | 返回 `already-finished`;进程不受影响;连续 close 两次只进梯子 1 次 | 同上 |
| 9 | `job_kill` 打在释放中 | `killed`;每个句柄各进梯子 1 次 | 同上 |
| 10 | 空闲进程被外部 SIGKILL 后再 send(processSettled 路径) | 死句柄进梯子 1 次;重连的句柄入池;`disposeAll` 后同样 1 次 | 计数 spawn + tree-agent 记录 pid |
| 11 | pool.send 失败路径:load 内崩溃、initialize 崩溃、协议拒绝后降级新会话(3 个句柄)、窗口内 purge、窗口内 disposeAll、error 轮 | job 全部落定(降级为 completed,其余为 failed);所有句柄各进梯子 1 次并退出 | 计数 spawn |
| 12 | 前置检查拒绝(注册表记录属于另一 agent 命令) | 工具错误;0 个 job,0 次 spawn | 计数 spawn |
| 13 | 计时器:混合全生命周期,跑 3 个池,共 14 个子进程 | `src/` 共创建 33 个 setTimeout,结束时 0 个未清除 | 真实计时器账本(按栈过滤) |
| 14 | 计时器(fake timers) | 3 个会话轮次结算后挂 3 个(空闲计时器);1 个会话在途时 2 个;`disposeAll` 后 0 个 | `vi.useFakeTimers` + `vi.getTimerCount()` |
| 15 | abort 监听器:同一混合生命周期(覆盖启动、轮、observe 三处,以及同步取消、kill、重连、启动失败、error 轮) | `src/` 共注册 25 个,峰值 2,结束时 0 个 | 监听器账本 |
| 16 | ndJsonStream / sdk 连接 | 14 个连接全部关闭(内部 close 信号 `notAborted=0`) | sdk 信号的 WeakRef 账本 |
| 17 | 管道句柄 | `PipeWrap` 前后都是 2;lsof 统计 pipe/unix fd:4 个会话存活时 15 个,`disposeAll` 后回到基线 7 个 | `getActiveResourcesInfo` + `lsof -p` |
| 18 | 注册表文件句柄 | 会话存活期间和 dispose、重建之后,注册表目录下的 fd 都是 0 | `lsof -p`(读码:只用同步 read/write/rename) |
| 19 | 真机 kiro 优雅释放(本包的销毁梯子,eof 6000) | 2061 ms 内 kiro-cli 与 kiro-cli-chat 都退出;没有升级到 terminate;exitCode 0 | 真实 subprocess-local + `pgrep`/`ps` |
| 20 | 真机:宿主进程被 SIGKILL(退出钩子不会运行) | 1919 ms 内整棵树退出(kiro 读到 stdin EOF 后自行退出) | 独立宿主脚本 `kill -9` |
| 21 | 真机:kiro-cli 父进程被 SIGKILL | 910 ms 内 kiro-cli-chat 退出(复核了已知结论) | 同上 |
| 22 | 真机进程组 | kiro-cli-chat 与 kiro-cli 同 pgid,而 subprocess-local 对 `-pid` 发信号、等整组退出,所以 terminate 能覆盖子进程 | `ps -o pgid` |
| 23 | 生产现场(DSH App) | 注册表里 3 个会话,对应的存活进程树不超过 3 棵。`impl-panel-grouping` 空闲 634 s(超过 600 s)后它的树已消失,说明空闲释放在生产生效。系统里没有 ppid=1 的 kiro 或 mock 进程 | `ps` + 只读查看 registry.json |

只读码、未实证的部分:`jobs.start` 在 `run()` 之后不会再抛错(`jobs-local/src/index.ts:240-280`,`recordSessionEvent` 自己捕获异常 `:456-462`),所以不存在"轮已启动、job 却没注册"的孤儿轮。`runTurnAsJob` 外层有 try/catch,`done` 永不 reject。同步模式(无 jobs 服务)的取消路径由第 15 条的同步取消用例覆盖。

---

## 总结论

- **进程**:没有泄漏。所有路径都实证子进程恰好释放一次,包括 start、send、close、remove、disposeAll、空闲超时、job_kill(流式中、窗口中、释放中、空闲时)、属主销毁、jobs 服务卸载、tools 服务卸载、插件卸载、宿主被 SIGKILL;kiro 的两级进程树在优雅释放和 SIGKILL 两种死法下都会退出。时序上有两处偏差,都不是泄漏:
  - P2-1:空闲释放期间到达的 send 会立即重连,新旧两个进程同时挂在同一远端会话上;
  - P2-2:`disposeAll`/`close` 中止重连窗口时只等 `disposeGraceMs`,默认配置下比窗口进程实际退出早约 3 s。
- **任务**:所有 job 都会落定,没有挂死。`cancel` 同步、可重复调用;`done` 在进程释放之后 resolve,永不 reject。send 的所有失败路径都落定为 failed 或 killed,不留进程。唯一的瑕疵是拆卸引起的结局文案不统一(P3-1)。
- **计时器**:没有泄漏。空闲计时器、`settleWithin`、`rangeExitsWithin` 的 arm/clear 全部配对;`disposeAll` 后 fake 计时器为 0,`src/` 计时器账本为 0。唯一不能提前清除的是 `AbortSignal.timeout`,它不保活进程且有时长上限(P3-3)。
- **监听器与流**:没有泄漏。启动、轮、observe 三处 abort 监听器全部配对移除,全程峰值 2,结束时 0;所有 sdk 连接都关闭;pipe fd 回到基线;注册表不持有句柄。

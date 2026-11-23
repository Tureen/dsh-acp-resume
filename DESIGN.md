# dsh-acp-resume 设计(阶段二:持久会话池)

基线:@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3 源码(阶段一已复制,行为一致,42 个协议面用例绿)。

> 修订(2026-11-09,D2):当前基线已升至 `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3`;除 D11 记录的 `permission: ask` 与 ENOENT 行动指引窄例外外，`src/run.ts` 与 npm 包 `src/run.ts` 一致。官方 checkout 固定到 `ff6db9df9f37db545e8b124b9043269f17256a34`（master 的 rc.3 状态）；DSH peer 钉 `~0.2.2-rc.3`、Cordis peer 保持 `~4.1.0`;`engines.dsh` 仅设最低版本 `>=0.2.2-rc.3`，上限策略及 0.3+ 风险以 D2 为准。
目标:为 ACP 外部子代理提供可续聊会话——进程保活、远端会话号落盘、死后 session/load 重连——且与官方 one-shot 链路完全隔离。

## 定型认知(前置调研结论)

1. 内核续聊体系(prepareContinuable → continuation manager)只面向本地 Agent;SubagentStartRequest 无自由字段可传"复用目标"。续聊层必须在本包内自建(官方让 ACP 走 one-shot 分支、社区插件自建工具,同因)。
2. run.ts 的 spawn→initialize→new 段(≈336–557 行)、单轮执行段(561–595)、销毁梯子(disposeAcpChild)边界清晰,可抽连接原语;session/new 返回号捕获点 493–500。
3. 自建模型工具的官方姿势:defineTool(@deepseek-ai/dsh-tools)+ ctx.tools.register(参照 tool-subagent/src/index.ts)。

## 架构

- 保留:one-shot provider(走 ctx.subagents,注册名 acp-resume,行为与官方一致)。
- 新增:持久会话池 + 模型工具(走 ctx.tools):acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close,另有 acp_chat_steer(D19,2026-11-09 修订:原稿为四个)。
- D31：宿主默认发现内置 CLI，自动连接检查与只读状态查询分离。Codex 按安全默认值验证已有登录和模型；Antigravity 只握手，使用 CLI 模型设置并拒绝 ACP 权限请求。工具和面板共享诊断缓存，工具不随就绪状态增减。池仅在新建（含首次供给角色）时选路：显式 `backend` 优先，其次固定的 `defaultBackend`，否则保留顶层 `default` 路由。开启发现时，只有宿主确认找不到顶层配置的 Kiro 可执行文件，才从就绪且在范围内的 Codex、`agy` 中依次选择；没有候选则尝试原命令，保留原有 ENOENT 指引。探测或连接失败不改派，也不锁定后端。已有会话的发送与重连不查就绪门，注册表、D6 与 one-shot 不变。

## 文件改动

| 文件 | 动作 | 要点 |
|---|---|---|
| src/connection.ts | 新增 | AcpConnection:openNew / openLoad(load 参数 {sessionId, cwd, mcpServers:[]},kiro v2 实测可用)/ prompt(官方结算逻辑:流式攒文本、stopReason 映射、权限策略、单飞)/ close(官方销毁梯子) |
| src/run.ts | ~~重构~~ 保持逐字副本(2026-11-09 修订,D11) | 原计划 startAcpRun = openNew + 一轮 prompt + 结算;已撤销,连接原语由池专用的 connection.ts 另行实现,run.ts 不动 |
| src/pool.ts | 新增 | 池:acquire/send/close;空闲计时 idleTimeoutMs(到期关进程、留注册表);注册表 $DSH_HOME/storages/acp-resume/registry.json(原子写;chatId/remoteSessionId/cwd/命令指纹);进程死后 send 自动 openLoad;协议级「会话不存在」类 load 拒绝或当前池实例连续 3 条 `error` 后降级新会话并注明(后者计数仅内存) |
| src/tools.ts | 新增 | 四工具(defineTool);send 返回标注降级信息 |
| src/index.ts | 修改 | name='acp-resume';Config + idleTimeoutMs(默认 600000)/registryPath/toolPrefix;apply 注册 provider+tools |
| tests/mock-acp-server.ts | 扩展 | session/load 分支(内存会话表) |
| tests/pool.spec.ts | 新增 | 同进程两轮/杀进程重连/降级/空闲释放/busy 拒绝/注册表重启恢复 |

## 行为决策

- 每会话单飞:prompt 在途时新 send 拒绝并提示;
- 取消:工具 exec.signal → session/cancel + 等结算;
- 环境凭据:沿用官方清洗 + 显式 env 叠加;
- 降级文案固定:"remote session lost, started fresh";
- 注册表:进程内串行写,原子改名;
- 隔离:不注册 ctx.subagents 之外的名字,不触碰官方 acp provider。

## 验收

1. one-shot 回归:42 个协议面用例不回归(现 `subagent-acp.spec.ts` 共 67 例,含 24 例条件运行的 D8);
2. 池全生命周期(mock)用例绿;
3. 真 kiro-cli 冒烟:建会话→两轮→杀进程→重连记得上文→空闲释放→再连;
4. 装机:pack→desktop profile→GUI 模型调用四工具完成同剧本。

## 风险与对策

- kiro load 对 cwd 敏感 → 注册表回放原 cwd,冒烟前置验证;
- kiro 会话积累 → close 文档提示 --delete-session;
- App 升级 peer 失配 → 钉 DSH `~0.2.2-rc.5`(2026-11-19,D2)、Cordis `~4.1.0`,升级重装+回归;
- 官方未来做 continuable ACP → 注册表结构可平移迁移。

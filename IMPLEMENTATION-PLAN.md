# 实施计划(IMPLEMENTATION-PLAN)

六步严格按序执行;每步有独立验收,不过验收不进下一步。状态:☐ 未开始 / ◐ 进行中 / ☑ 完成。

## 前置就绪清单(2026-11-04 已达成)

- ☑ 独立仓库与骨架(基线 0.2.1-rc.5,构建绿,42 协议面用例绿,首提交 a606019)
- ☑ 设计与决策文档(DESIGN.md / DECISIONS.md / README.md,提交 7dce3e9 起)
- ☑ 实施依赖补齐(@deepseek-ai/dsh-tools、@deepseek-ai/dsh-home-paths,dev + peer)
- ☑ 参考源码 checkout(官方仓库分支 my-subagent-acp @ dsh-v0.2.1-rc.5,只读)

## 步骤

| # | 步骤 | 产出 | 验收 | 状态 |
|---|---|---|---|---|
| 1 | 连接原语抽取 | `src/connection.ts`:`openAcpConnection(openNew/openLoad)` + `prompt`(轮粒度输出/取消/安全诊断)+ `dispose` | connection.spec 六用例绿(含跨进程 load 重连记忆) | ☑ 7b61bf9 |
| 2 | ~~run.ts 重构为薄包装~~ **已评估并撤销(D11)** | run.ts 保持官方原版;connection.ts 为池专用姊妹实现 | 撤销后回归面 48 绿恢复(重构曾致 5 例退化) | ☑ 评估闭环 |
| 3 | mock 扩展 load | 会话表(内存+文件持久)、load 分支、MOCK_REMEMBER / MOCK_SESSION_STORE / MOCK_LOAD_MISSING | 跨进程重连用例绿(随第 1 步交付) | ☑ 7b61bf9 |
| 4 | 会话池 | `src/pool.ts`:start/send/close、空闲计时(可配窗口)、注册表原子落盘、load 重连与降级 | `tests/pool.spec.ts` 6/6 绿(同进程两轮/释放后重连记忆/降级/空闲释放重连/busy 拒绝/跨池实例恢复) | ☑ |
| 5 | 工具与接线 | `src/tools.ts` 四工具 + `index.ts` Config(idleTimeoutMs/registryPath/toolPrefix)与注册 | 工具 schema/行为测试绿;`--dump-config` 可见 | ☐ |
| 6 | 真机与装机验收 | 真 kiro-cli 冒烟剧本 + pack 安装 desktop profile | GUI 中模型经四工具完成:建会话→两轮→杀进程→重连记得上文→空闲释放→再连 | ☐ |

## 冒烟剧本(第 6 步固定内容)

1. `acp_chat_start` → chatId;
2. `acp_chat_send`:"记住暗号 X";
3. 杀进程(手动或超时);
4. `acp_chat_send`:"暗号是什么?" → 应答 X(证明 load 恢复上下文);
5. 空闲释放后再次 send → 仍记得(重连路径复验)。

## 完成后(阶段三展望,另行设计)

装机文档、开源发布(github + npm)、官方 PR 评估(以本实现为参考,推进 Dev Note 中的 continuable ACP 方向)。

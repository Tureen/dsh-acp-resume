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
| 1 | 连接原语抽取 | `src/connection.ts`:`AcpConnection.openNew / openLoad / prompt / close`,素材自 run.ts | tsc 干净;新原语单测(spawn/握手/单轮/销毁,mock)绿 | ☐ |
| 2 | run.ts 重构为薄包装 | `startAcpRun` = openNew + 一轮 + 结算 | **现有 42 例原样绿**(不回归门) | ☐ |
| 3 | mock 扩展 load | mock-acp-server 内存会话表 + load 分支 | load 命中/未命中两用例绿 | ☐ |
| 4 | 会话池 | `src/pool.ts`:acquire/send/close、空闲计时、注册表原子落盘、重连与降级 | `tests/pool.spec.ts` 全绿(同进程两轮/杀进程重连/降级/空闲释放/busy 拒绝/重启恢复) | ☐ |
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

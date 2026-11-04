# AGENTS.md

dsh-acp-resume 是 DeepSeek Harness 的可续聊 ACP 子代理后端:`@deepseek-ai/dsh-subagent-acp@0.2.1-rc.5` 的独立兄弟包,完整保留官方 one-shot(一次性)委派行为,新增持久会话池——进程保活、远端会话号落盘、进程死后经 `session/load` 重连。改架构前读 [DESIGN.md](DESIGN.md);决策按编号引用 [DECISIONS.md](DECISIONS.md);当前进度与验收状态见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 基线与隔离(硬约束)

- 基线钉 `0.2.1-rc.5`,peer 依赖全部 `~0.2.1-rc.5`(D2);DSH App 升级时同步重装 peer 并跑全量回归。
- 本包 provider 注册名 `acp-resume`,永不触碰官方 `acp` provider 与现有 kiro 链路(D1)。
- `src/run.ts` 是官方源码的逐字副本,禁止为消重而重构(D11);`src/connection.ts` 是池专用姊妹实现,约 200 行受控重复是刻意选择,不是待清理债务。
- 42 个官方协议面用例是 one-shot 行为的不回归门槛;真实子进程类 24 例依赖官方 checkout 的 `spawn.ts`(npm 分发包不含),checkout 在场时运行、缺席时自动跳过(D8),跳过属预期,不是待修缺陷。
- 官方源码只读对照:`/Users/Tulane/Developer/open-source-projects/deepseek-harness`,分支 `my-subagent-acp` @ `dsh-v0.2.1-rc.5`。

## Repository layout

```
src/
  index.ts       插件入口:Config(全字段见 README「配置」)+ provider 与工具注册
  run.ts         官方 one-shot 驱动(逐字基线,勿重构,D11)
  connection.ts  连接原语:openNew / openLoad({sessionId, cwd, mcpServers:[]})/ prompt / dispose
  pool.ts        持久会话池:start/send/close、空闲释放、注册表原子落盘、重连与降级
  tools.ts       四个模型工具:acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close
                 (defineTool + ctx.tools.register,不走 ctx.subagents);send 的轮非 completed 时抛工具错误
tests/
  subagent-acp.spec.ts   官方协议面回归(含 42 例协议面门槛)
  connection.spec.ts     连接原语
  pool.spec.ts           池生命周期
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

### 期望测试基线

- 绿色回归面 = 各套件绿例之和,当前 156 绿:官方协议面 `subagent-acp.spec.ts` 67(含恢复的 24 例 D8 豁免)+ `connection.spec.ts` 23 + `pool.spec.ts` 32 + `tools.spec.ts` 12 + `panel.spec.ts` 8 + `client.spec.tsx` 14;新套件落地时在此登记。
- D8 豁免已恢复为条件运行:官方 checkout(`/Users/Tulane/Developer/open-source-projects/deepseek-harness`,可用环境变量 `DSH_OFFICIAL_CHECKOUT` 覆盖)在场时全绿、`pnpm test` 退出码 0;缺席时该 24 例自动跳过,其余仍须全绿。
- 测试同时验证 lib/ 与源码行为前先 `pnpm build`,保证 lib/ 不是陈旧产物。

## Conventions

- ESM(`"type": "module"`)。相对导入写 `.js` 后缀(NodeNext);跨包引用一律用包名。TypeScript `strict` + `noImplicitAny` + `verbatimModuleSyntax` + `isolatedModules`。
- **仅命名导出**:默认导出会丢 loader 元数据(index.ts 头注引官方 postmortem 0001)。
- schemastery `~3.18.5` 无 `.optional()`(实测 `z.string().optional is not a function`)。不加 `.required()` 也不加 `.default()` 的字段本身就是可选(实测缺省时校验通过、结果里不出现该键);需要缺省值时用 `.default(...)`,必填用 `.required()`。
- 模块头 JSDoc:一段话讲清契约与边界,`@module` 标识;公共导出与 Config 字段补简明 JSDoc。
- 注释直接、具体:不重述代码、不写推理过程;命令、路径、报错保留原文。
- 凭据走 Config `env` 显式叠加,父进程环境先经官方清洗逻辑;不在测试、夹具、文档写入真实 key。
- 池语义固定,改动需先修订 D6:每会话单飞(在途时拒绝新 send,不排队);仅协议级 `session/load` 拒绝才降级新会话,注记含固定短语 `remote session lost, started fresh`,其余重连失败报错且注册表不动;空闲释放只关进程、注册表保留;注册表写 = 临时文件 + 原子改名;取消 = 本地立即结算 `aborted` + 尽力 `session/cancel` + 作废连接(error 轮同样作废)。
- kiro 侧会话随 new/load 积累(D10):`acp_chat_close` 的工具说明需提示以 `kiro-cli chat --list-sessions` / `--delete-session` 清理。
- 新决策写进 DECISIONS.md(既有条目就地更新并注日期);修订行为前先查是否触碰既有 D 编号。
- 文档与提交信息用中文;IMPLEMENTATION-PLAN.md 的步骤状态(☐/◐/☑)随对应提交更新。
- 动 `src/` 前先看 `git status` 与 IMPLEMENTATION-PLAN.md:实施步骤可能在途且有未提交改动,勿覆盖。

## Editing these instructions

AGENTS.md 是协作规则的唯一事实源;改规则时同步核对 README.md / DESIGN.md / DECISIONS.md 的对应表述,绿色回归面数字变化时更新「期望测试基线」。

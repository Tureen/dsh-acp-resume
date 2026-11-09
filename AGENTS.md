# AGENTS.md

dsh-acp-resume 是 DeepSeek Harness 的可续聊 ACP 子代理后端:`@deepseek-ai/dsh-subagent-acp@0.2.1-rc.5` 的独立兄弟包,完整保留官方 one-shot(一次性)委派行为,新增持久会话池——进程保活、远端会话号落盘、进程死后经 `session/load` 重连。改架构前读 [DESIGN.md](DESIGN.md);决策按编号引用 [DECISIONS.md](DECISIONS.md);当前进度与验收状态见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 基线与隔离(硬约束)

- 基线钉 `0.2.1-rc.5`,peer 依赖全部 `~0.2.1-rc.5`(D2);DSH App 升级时同步重装 peer 并跑全量回归。
- 本包 provider 注册名 `acp-resume`,永不触碰官方 `acp` provider 与现有 kiro 链路(D1)。
- `src/run.ts` 是官方源码的逐字副本,禁止为消重而重构(D11);`src/connection.ts` 是池专用姊妹实现,约 200 行受控重复是刻意选择,不是待清理债务。
- 42 个官方协议面用例是 one-shot 行为的不回归门槛;真实子进程类 24 例依赖官方 checkout 的 `spawn.ts`(npm 分发包不含),checkout 在场时运行、缺席时自动跳过(D8),跳过属预期,不是待修缺陷。
- 官方源码只读对照:`<官方 checkout>`(默认按 `~/Developer/open-source-projects/deepseek-harness` 探测,可用环境变量 `DSH_OFFICIAL_CHECKOUT` 覆盖),分支 `my-subagent-acp` @ `dsh-v0.2.1-rc.5`。

## Repository layout

```
src/
  index.ts       插件入口:Config(全字段见 README「配置」)+ provider 与工具注册
  run.ts         官方 one-shot 驱动(逐字基线,勿重构,D11)
  connection.ts  连接原语:openNew / openLoad({sessionId, cwd, mcpServers:[]})/ prompt / steer(私有 `_session/steer`)/ dispose
  pool.ts        持久会话池:start/send/steer/close、空闲释放、注册表原子落盘、重连与降级;轮结算与重连事件写按轮日志
  turn-log.ts    按轮日志 `turns/<chatId>.jsonl`(追加、截断、裁剪、容错读、删除;写失败只告警,D18)
  panel.ts       面板 host 半:`acpResume/list|close|purge|turns|turn` 五个 Remote 方法(D15/D18)
  client/        面板浏览器半(tsdown 打成 lib/client.js):ChatsPanel 列表、ChatDetail 详情页签(资源地址 `dsh-resource://acp-resume-chat/<chatId>`)、chats-source / detail-source 数据源
  engine.ts      --agent-engine 旗标:追加(用户已写则不追加)与指纹比较时剔除(D19)
  job-wait-gate.ts  D22:tools/pre-execute 监听逻辑,拒绝对运行中 acp-chat 任务的 job_output wait:true(allowChatJobWait 可关)
  tools.ts       五个模型工具:acp_chat_start / acp_chat_send / acp_chat_list / acp_chat_close / acp_chat_steer
                 (defineTool + ctx.tools.register,不走 ctx.subagents);有 ctx.jobs 时 send 注册
                 acp-chat 后台任务并立即返回 jobId(D17),无 jobs 时同步等待、轮非 completed 抛工具错误
locale/         en.json / zh.json:插件显示元数据(meta.title/description),经 exports 的 ./locale/*.json 暴露
icon.svg        插件图标,由 package.json 顶层 icon 字段声明;locale 与图标都须在 files 里
tests/
  subagent-acp.spec.ts   官方协议面回归(含 42 例协议面门槛)
  connection.spec.ts     连接原语
  pool.spec.ts           池生命周期
  jobs.spec.ts           后台任务模式 send(真 jobs-local 注册表)与 send 变体随 ctx.jobs 切换
  steer.spec.ts          acp_chat_steer:插话快乐路 / 不支持降级 / 无在途轮拒绝
  engine.spec.ts         --agent-engine 辅助函数与两条 spawn 路径的 argv
  job-wait-gate.spec.ts  D22 门:decideJobWait 纯函数、allowChatJobWait 开关、真实 ToolRuntime 派发
  turn-log.spec.ts       按轮日志单元(追加/读/截断/容错/裁剪/删除/写失败)
  panel.spec.ts          面板 host 半 Remote 方法;client.spec.tsx 面板浏览器半(jsdom)
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

- 绿色回归面 = 各套件绿例之和,当前 311 绿:官方协议面 `subagent-acp.spec.ts` 67(含恢复的 24 例 D8 豁免)+ `connection.spec.ts` 24 + `pool.spec.ts` 57 + `tools.spec.ts` 13 + `jobs.spec.ts` 12 + `panel.spec.ts` 16 + `client.spec.tsx` 70 + `steer.spec.ts` 5 + `engine.spec.ts` 16 + `turn-log.spec.ts` 18 + `job-wait-gate.spec.ts` 13;新套件落地时在此登记。
- D8 豁免已恢复为条件运行:官方 checkout(默认按 `~/Developer/open-source-projects/deepseek-harness` 探测,可用环境变量 `DSH_OFFICIAL_CHECKOUT` 覆盖)在场时全绿、`pnpm test` 退出码 0;缺席时该 24 例自动跳过,其余仍须全绿。
- 测试同时验证 lib/ 与源码行为前先 `pnpm build`,保证 lib/ 不是陈旧产物。

## Conventions

- ESM(`"type": "module"`)。相对导入写 `.js` 后缀(NodeNext);跨包引用一律用包名。TypeScript `strict` + `noImplicitAny` + `verbatimModuleSyntax` + `isolatedModules`。
- **仅命名导出**:默认导出会丢 loader 元数据(index.ts 头注引官方 postmortem 0001)。
- schemastery `~3.18.5` 无 `.optional()`(实测 `z.string().optional is not a function`)。不加 `.required()` 也不加 `.default()` 的字段本身就是可选(实测缺省时校验通过、结果里不出现该键);需要缺省值时用 `.default(...)`,必填用 `.required()`。
- 模块头 JSDoc:一段话讲清契约与边界,`@module` 标识;公共导出与 Config 字段补简明 JSDoc。
- 注释直接、具体:不重述代码、不写推理过程;命令、路径、报错保留原文。
- 凭据走 Config `env` 显式叠加,父进程环境先经官方清洗逻辑;不在测试、夹具、文档写入真实 key。
- send 的后台任务模式见 D17:单飞前置检查在 `jobs.start` 之前;job 的取消走 D6 取消条;无 jobs 服务时保持同步语义。
- 池语义固定,改动需先修订 D6:每会话单飞(在途时拒绝新 send,不排队);仅协议级 `session/load` 拒绝才降级新会话,注记含固定短语 `remote session lost, started fresh`,其余重连失败报错且注册表不动;空闲释放只关进程、注册表保留;注册表写 = 临时文件 + 原子改名;取消 = 本地立即结算 `aborted` + 尽力 `session/cancel` + 作废连接(error 轮同样作废)。
- 按轮日志(D18)是诊断镜像不是状态:写失败只经 `onWarn` 告警、绝不改变轮结果;写前复查注册表里会话还在(purge 后不得复活);`purge` 连日志文件一起删;steer 不记。注册表结构不因日志而改。
- 面板详情页签是资源地址页签(`dsh-resource://acp-resume-chat/<chatId>`),不注册 resource provider;身份只能放地址里(官方不持久化导航参数)。
- kiro 侧会话随 new/load 积累(D10):`acp_chat_close` 的工具说明需提示以 `kiro-cli chat --list-sessions` / `--delete-session` 清理。
- 新决策写进 DECISIONS.md(既有条目就地更新并注日期);修订行为前先查是否触碰既有 D 编号。
- 文档与提交信息用中文;IMPLEMENTATION-PLAN.md 的步骤状态(☐/◐/☑)随对应提交更新。
- 动 `src/` 前先看 `git status` 与 IMPLEMENTATION-PLAN.md:实施步骤可能在途且有未提交改动,勿覆盖。

## Editing these instructions

AGENTS.md 是协作规则的唯一事实源;改规则时同步核对 README.md / DESIGN.md / DECISIONS.md 的对应表述,绿色回归面数字变化时更新「期望测试基线」。

# 开发经验(dsh-acp-resume)

> 给后续开发(人和 agent)。按主题索引;每条链到证据;只写「违反会怎样」。决策的来龙去脉见 [DECISIONS.md](../DECISIONS.md),本文只记**别踩的坑、违反的后果、以及现在靠什么防**。

---

## 一、宿主(DSH rc.5 / Cordis / typert)的约束

> **术语速览**:**DSH**（DeepSeek Harness）是桌面/CLI 宿主框架；**ACP**（Agent Client Protocol）是宿主与外部 CLI 代理通信的 JSON-RPC 协议；**Cordis** 是其依赖注入与插件生命周期容器，每个插件挂在一个 **fiber**（插件作用域实例）上，按 `ctx.inject(['svc'], cb)` 声明依赖服务；**schemastery** 是 Cordis 的配置 schema 库，`.volatile()` 标记的字段支持原位热更新而不重载插件；**profile**（`cordis.patch.yml`）是用户的插件配置文件；**typert / SRC**（Service Remote Call）是宿主与浏览器侧栏之间的 RPC 反射层，`@Remote` 把宿主服务方法暴露给前端。

1. **schemastery 字典内部字段不能标 `volatile`,只有固定顶层路径上的字段或字典整体可以**。
   - **违反会怎样**:把 `backends.*.model` 或 `backends.*.effort` 标成 `.volatile()`,插件加载或校验即抛 `ValidationError: $.backends.*.model volatile fields require a fixed object path without an enclosing volatile field`,整个配置 schema 无法初始化。
   - **根因**:schemastery 要求 `volatile` 绑定在固定的对象路径上,不支持通配字典子项,也不允许嵌套在另一个 `volatile` 字段内部。
   - **现在靠什么防**:需要按后端热更新的配置拆成顶层字典 `backendDefaults: z.dict(...).default({}).volatile()`(此时 `isVolatilePath` 对 `['backendDefaults', '<id>', 'model' | 'effort']` 返回 `true`),静态 `backends.*` 保持普通字段;由 `tests/live-settings.spec.ts` 端到端回归锁住。
   - **证据**:D42、D48、`src/index.ts`、`tests/live-settings.spec.ts:141-219`、本机探针日志 `/tmp/acp-defaults.v7tWlG/dict-model.log` 与 `dict-effort.log`。

2. **schemastery 3.18.5 与 3.19.0 均没有 `.optional()`**。
   - **违反会怎样**:按 Zod 习惯写 `z.string().optional()`,运行期直接 `TypeError: ...optional is not a function` 导致插件无法加载。
   - **根因**:schemastery 的可选语义是不调用 `.required()` / `.default()` 即默认可选(缺省时结果对象里不含该键)。
   - **现在靠什么防**:`AGENTS.md` 编码约定 + `src/index.ts` 与 `src/dispatcher-preset.ts` 全量 schema 均按此写法,由 `tests/live-settings.spec.ts` 与 `tests/dispatcher-preset.spec.ts` 覆盖加载。
   - **证据**:D42（27 项两版对比探针）、`AGENTS.md`「Conventions」。

3. **`dsh-settings` 的 `mutate()` 只认 `volatile` 字段;绕过它调 `configEditor.edit()` 写普通字段必重载主插件、杀光在途会话**。
   - **违反会怎样**:对非 `volatile` 路径调 `ctx.settings.mutate` 立即抛 `Config field "..." is not volatile`;若改调底层 `@deepseek-ai/dsh-config-editor` 的 `edit()` 写普通字段,落盘后会同步触发 `reconcileProfilePatches`,主插件被卸载重装、持久会话池被 `disposeAll()` 销毁、所有在途轮被中止(`{"samePool":false,"disposals":1,"inFlightAfterSave":false,"turn":"aborted"}`)。此外,`ConfigEditor` 写回 `cordis.patch.yml` 会重建整行 `config` 并重新序列化,清掉行内注释与原键序。
   - **根因**:DSH 宿主把非 `volatile` 字段视为影响插件依赖图的静态配置,写盘后强制整行重建;YAML 写回走的是对象序列化而非 AST 局部补丁。
   - **现在靠什么防**:所有侧栏热改字段必须是 `volatile`,需要重注册的消费者拆到独立子作用域(不与 ACP 会话池共享 fiber);首次写回前弹窗确认注释/排版会变化(D45);`tests/live-settings.spec.ts` 挂真在途轮断言 `samePool === true` 且 `disposeAll` 零调用。
   - **证据**:D45（附真实 diff）、D48、`tests/live-settings.spec.ts:61-219`、探针日志 `/tmp/acp-defaults.v7tWlG/ordinary-named-model.log`。

4. **宿主 `@Remote` 装饰器裸写永远被识别成 unary(单次请求/响应),`async *` 生成器也不例外**。
   - **违反会怎样**:在 `async *watch(...)` 上只写 `@Remote`,浏览器经 Gateway 订阅实时输出时被当成普通单次 RPC 调用,流载体不工作,无法持续推送帧或响应取消。
   - **根因**:rc.5 的 SRC 反射不从 JS 函数是否为 `AsyncGeneratorFunction` 推断流模式,必须由元数据显式声明 `{ mode: 'stream' }`。
   - **现在靠什么防**:`src/panel.ts` 显式写 `@Remote({ mode: 'stream' })`;`tests/panel.spec.ts` 反射断言 `remoteMethods(panel)` 中 `watch.mode === 'stream'`;`tests/live-gateway.spec.ts` 起真实 rc.5 Gateway + WebSocket 端到端验证双帧消费与取消清理。
   - **证据**:D46、`src/panel.ts:267`、`tests/panel.spec.ts:291`、`tests/live-gateway.spec.ts:19-94`。

5. **Cordis 服务只能在 `inject` 过该服务的子作用域上读取,不能从父作用域 `scope.get()`**。
   - **违反会怎样**:在 `scope.inject(['remote'], ...)` 之外从父 `scope.get('remote')` 打开流,DSH 客户端运行期直接抛 `cannot get property "remote.acpResume" without inject`,详情页实时输出区始终显示「实时输出不可用」(0.7.2–0.7.4 实发事故)。
   - **根因**:DSH 客户端对 Cordis 上下文加了严格的注入守卫,只允许已声明注入该服务的作用域访问其属性。
   - **现在靠什么防**:在 `scope.inject(['remote'], async remoteScope => ...)` 内完成 `$mount` 后把 `remote` 引用捕获到闭包变量 `watchRemote`,注销时置 `undefined`,打开流时只读 `watchRemote`;因裸 Cordis 单测无法复现该守卫,用结构性单测锁住源码不得出现 `scope.get('remote')`。
   - **证据**:提交 `a9232eb`、`src/client/index.ts:139-151`、`tests/client.spec.tsx` 中 `the live opener reads \`remote\` only from the value captured inside its inject scope (pins the DSH "without inject" fix)`。

6. **插件入口只用命名导出,禁止 `export default`**。
   - **违反会怎样**:Cordis loader 读取不到插件的 `name`、`Config`、`inject` 等静态元数据,导致插件无法按预期配置或激活。
   - **根因**:官方 loader 约定从模块命名空间读取导出字段,默认导出会覆盖/丢失元数据结构。
   - **现在靠什么防**:`AGENTS.md` 明确禁用默认导出,`src/index.ts`、`src/dispatcher-preset.ts`、`src/client/index.ts` 全部命名导出,并由 loader 夹具测试覆盖。
   - **证据**:`AGENTS.md`「Conventions」、`src/index.ts` 头注。

---

## 二、官方组件:以类型声明为准

> 本插件右侧栏复用宿主组件库 `@deepseek-ai/dsh-client-ui-primitives`。**不要凭名字或主流 UI 库直觉猜 props**,动手前直接读 `node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/*.d.ts` 与对应 `src/` 实现。

1. **`useClipboardCopy(text)` 返回 `{ copied, onCopy }`,不是 `{ copied, copy }`**。
   - **违反会怎样**:按直觉解构 `copy` 绑定 `onClick={promptCopy.copy}`,运行期事件处理器为 `undefined`,点击复制静默失效;更糟的是测试里若顺手 mock 成 `copy: () => {}`,单测反而会全绿掩盖缺陷。
   - **根因**:官方接口 `ClipboardCopyState` 的回调名固定为 `onCopy`。
   - **现在靠什么防**:`src/client/ChatDetail.tsx` 走 `promptCopy.onCopy` / `replyCopy.onCopy`;合并修复 `501fcda` 已清理 `tests/client.spec.tsx` 中形状错误的旧 mock(`tests/profile-settings.spec.tsx` 曾留有一个未消费到的旧占位,已随本文档一并对齐)。
   - **证据**:`node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/use-clipboard-copy.d.ts:2-7`、提交 `501fcda`、`src/client/ChatDetail.tsx:142-169`。

2. **`StateDot` 与 `TextShimmer` 没有自定义的繁杂状态开关——`StateDot` 只认五态 `state` + `appearance`,`TextShimmer` 只有 `active?: boolean`**。
   - **违反会怎样**:给 `TextShimmer` 传 `running`/`disabled` 或给 `StateDot` 传未定义状态名,TypeScript 报错或静默忽略,导致离屏停动画、释放态圆点样式失效。
   - **根因**:`StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'`,释放态靠 `appearance="step"` 区分;`TextShimmer` 仅凭 `active` 控制 `data-shimmer` 与遮罩层挂载。
   - **现在靠什么防**:`src/client/ChatsPanel.tsx` 用 `STATE_DOT` 映射表收口 6 态到官方 5 态 + `appearance`,并由 `tests/client.spec.tsx` 映射单测守住;`ChatDetail.tsx` 离屏时显式传 `<TextShimmer active={liveVisible}>`。
   - **证据**:`node_modules/@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx:9,44`、`TextShimmer.tsx:9-46`、`src/client/ChatsPanel.tsx:172-198`、提交 `45b0faf`。

3. **`@deepseek-ai/dsh-client-ui-primitives` 不导出 `Select` 组件**。
   - **违反会怎样**:在表单里盲目 `import { Select } from '@deepseek-ai/dsh-client-ui-primitives'`,构建或运行期立即报导出不存在。
   - **根因**:官方原语库只提供 `Menu`、`Switch`、`Input`、`SegmentedControl` 等,没有封装表单 `<select>`。
   - **现在靠什么防**:下拉选择统一用带 `--dsw-*` token 样式的原生 `<select>`(`ProfileSettings.tsx` / `ChatSettings.tsx`)或官方 `Menu`(操作菜单),所有导入通过 `src/client/panel-chrome.tsx` 集中再导出。
   - **证据**:D47 Step 2(`0ee28e5`)、D48(`6f8f0ce`)、`src/client/panel-chrome.tsx:20-49`。

4. **`DisclosureRow` 在 `expandOnRowClick` 为 `true` 时整行就是按钮,没有独立的带 `aria-label` 的 `<button>`**。
   - **违反会怎样**:测试按 `getByRole('button', { name: '更早的 4 条记录' })` 精确查询,在真实组件上找不到元素(因为整行 `<div role="button">` 的可访问名由内部标题 + `collapsedContent` 拼出,包含时间跨度与异常数)。
   - **根因**:`DisclosureRow.tsx:90-113` 在 `rowExpands = expandable && expandOnRowClick` 时把外层 `<div data-disclosure-row>` 设为 `role="button"`,而内层领航图标退化为无 `aria-label` 的 `<span>`。
   - **现在靠什么防**:测试一律用正则匹配可访问名(如 `/^更早的 4 条记录/`),且 `tests/client.spec.tsx` 的 `DisclosureRow` mock 同步还原 `expandOnRowClick` 分支。
   - **证据**:提交 `501fcda`、`node_modules/@deepseek-ai/dsh-client-ui-primitives/src/DisclosureRow.tsx:64-118`、`tests/client.spec.tsx:59-80`。

5. **`UserMessageBubble` 自带 `white-space: pre-wrap`,不能包裹 `MarkdownText`**。
   - **违反会怎样**:把 `MarkdownText` 塞进 `UserMessageBubble` 后,Markdown 渲染出的段落、列表、代码块之间的换行与缩进被 `pre-wrap` 原样撑开,出现大片空白与排版错乱。
   - **根因**:`UserMessageBubble.module.css:9` 声明了 `white-space: pre-wrap`,面向的是纯文本用户输入气泡而非富文本 HTML 树。
   - **现在靠什么防**:详情页指令块改用带 `background: var(--dsw-specific-bubble)` 的普通容器包裹 `DetailMarkdown`。
   - **证据**:`node_modules/@deepseek-ai/dsh-client-ui-primitives/src/UserMessageBubble.module.css:9`、D47 Step 6/7(`c1e7dae`、`13af7c9`)、`src/client/ChatDetail.tsx`。

6. **`MarkdownText` 的 `variant="compact"` 会把正文颜色压成次级灰(`--dsw-alias-label-secondary`),不适合做主阅读区**。
   - **违反会怎样**:在详情页轮次回复里直接用 `variant="compact"`,正文对比度明显偏暗,看起来像辅助说明而非主回复内容。
   - **根因**:`MarkdownText.module.css:124,489` 把 compact 变体设计为弱化注记样式,将文字与列表色调降到 `--dsw-alias-label-secondary`。
   - **现在靠什么防**:`src/client/detail-markdown.tsx` 固定传 `variant="body"` + `omitHtml={true}`,紧凑字号与段距通过外层 `.acp-detail-md`(`MarkdownCompactStyle`)覆盖。
   - **证据**:D47 Step 6(`c1e7dae`)、`src/client/detail-markdown.tsx:11-16`、`src/client/panel-chrome.tsx:220-235`、`MarkdownText.module.css:124,489`。

---

## 三、我们自己的硬约束,以及为什么是硬的

> 这里不抄写 `AGENTS.md` 的规则清单,只写**一旦破坏会引发什么故障**,让后来者知道为什么不能「顺手优化」。

1. **独立包与 `acp-resume` provider 命名隔离——不能碰官方 `acp` provider**。
   - **违反会怎样**:改名成官方包或覆盖 `provider: acp`,会直接劫持用户现有的官方 kiro 委派链路,并把每次宿主升级变成高风险的源码 rebase。
   - **根因**:DSH 按 provider 名称路由子代理激活,同名即覆盖。
   - **现在靠什么防**:包身份与 `providerName` 固定为 `acp-resume`,与官方 `acp` 共存。
   - **证据**:D1、D13、`AGENTS.md`「基线与隔离」。

2. **`src/run.ts` 保持官方逐字基线,禁止为消重而与 `src/connection.ts` 合并重构**。
   - **违反会怎样**:实施第 2 步尝试把 `startAcpRun` 重构为 `openAcpConnection` 的薄包装,当场造成 **5 例官方回归测试变红**——哪怕语义看似等价,官方用例对启动失败前缀(`subagent-acp: Subagent failure ...`)和错误分类做逐字断言。
   - **根因**:one-shot(一次性委派)与持久池对取消、进程归属和错误包装的边界不同,强行 DRY 会把池层的变动传导到官方契约面。
   - **现在靠什么防**:允许两文件保留约 200 行受控重复;`src/run.ts` 仅允许 D11 明载的两处窄例外(`permission: ask` 与 `ENOENT` 指引);`scripts/release.mjs` 的 `preflight` 机械检查 `src/run.ts` 相对基线未改动。
   - **证据**:D11、`scripts/release.mjs`、42 例官方协议面测试(`tests/subagent-acp.spec.ts`)。

3. **DSH peer 依赖必须与已装 App 版本对齐,且 D8 的 24 例真实子进程测试不得当作坏测试删掉**。
   - **违反会怎样**:peer 错版有真实先例——误装 `0.1.0-rc.6` 导致整个 provider 行静默无法激活;而忽略在 CI 里因缺官方 checkout 自动跳过的 24 例真实子进程测试,会让子进程 EOF/SIGTERM/SIGKILL 销毁梯子与环境清洗的退化漏到生产。
   - **根因**:npm 分发包不含官方的 `packages/subprocess/subprocess-local/src/spawn.ts`,CI 无法运行这 24 例,只能靠本地官方 checkout 兜底。
   - **现在靠什么防**:App 升级时同步重装全套 `@deepseek-ai/dsh-*` peer 并跑回归;发版门槛 `pnpm release:skipped` 强制在本机补跑这 24 例。
   - **证据**:D2、D8、`scripts/release.mjs`。

4. **池语义红线(单飞 / 窄降级 / 原子写盘 / 取消与出错作废连接 / 展示态不落盘)**。
   - **违反会怎样**:
     - 不在首个 `await` 前占位单飞:重连窗口内两个并发 `send` 会起两条子进程并覆盖丢弃其中一条(D14 P0 实发)。
     - 对所有 `session/load` 拒绝无条件降级新会话:一次临时的鉴权失败、限流或 `-32603` 内部错误就会把用户几十分钟的远端上下文永久作废(D6 2026-11-18 收窄)。
     - 释放刚开始就移出活跃表:旧进程尚在 EOF 收尾窗口时新 `send` 会立刻拉起第二个进程同时 load 同一远端会话(D6 P2-1 修订)。
     - 取消或 `error` 轮不作废连接:ACP 更新帧不带轮次编号,取消轮迟到的流式块会直接污染下一轮回答(D14)。
     - 往 `registry.json` 塞 UI 展示字段(如在途状态、重连覆盖、最新摘要):会破坏跨版本兼容并把临时诊断态固化为持久化负担(D6 / D47 / D48)。
   - **根因**:ACP 外部子进程是有状态、单通道、弱事务边界的长生命进程。
   - **现在靠什么防**:任何池语义改动前先修订 D6;注册表写采用「串行写 + 临时文件原子改名 + 先落盘再改内存」;发版审计用 `git diff <prev-tag> -- src/pool.ts | grep -E 'RegistryEntry|writeRegistry'` 核查注册表结构零漂移;`tests/pool.spec.ts` 97 例全量覆盖。
   - **证据**:D6、D14、D16、D48、`tests/pool.spec.ts`。

5. **按轮日志(`turns/<chatId>.jsonl`)是诊断镜像,绝不能当成强一致状态源**。
   - **违反会怎样**:若写日志失败向上抛错,一个明明已由外部 agent 完成的业务轮会被判失败;若写日志前不复查会话仍在注册表里,已被 `purge` 的会话在结算瞬间会写出孤儿日志文件;若前端把「在途轮结束刷新后必然读到日志」当成不变量(D47 设计稿 §5.1 原假设),在写盘失败或被删除时详情页就会死等或错误展开上一轮历史。
   - **根因**:日志落盘刻意与业务轮结果解耦,且 `purge` 与在途结算存在并发竞态。
   - **现在靠什么防**:写失败只经 `onWarn` 告警、不改轮结局;写前复查注册表存在性;详情页以本轮 `startedAt` 精确匹配交接,3 秒未匹配保留末帧并提示缺记录,绝不借用最近一条顶替。
   - **证据**:D18、D47 Step 9、`src/pool.ts`、`src/turn-log.ts`、`src/client/ChatDetail.tsx`。

6. **面板接口按读写分校验档次:读按存在性,写按 owner（当前展示的 DSH 主会话 seat 身份）**。
   - **违反会怎样**:D46 初版把 D44 的写操作 `ownedChat(chatId, sessionId)` 防串改校验套在了只读流 `watch` 上,导致同一详情页可以正常浏览其他主会话创建的 chat 历史(`turns`/`turn`),点开「实时输出」却被拒(0.7.4 实发)。
   - **根因**:把只读观察与破坏性/状态修改操作混用同一条归属门控。
   - **现在靠什么防**:只读接口(`turns`、`turn`、`watch`)统一走 `knownChat(chatId)`;写接口及配套选项查询(`close`、`purge`、`chatOptions`、`setChatModel`、`setChatEffort`)走 `ownedChat(chatId, sessionId)`。由 `tests/panel.spec.ts` 跨会话订阅用例守住。
   - **证据**:0.7.4、提交 `7a1ce33`、D44 2026-11-27 修订、`src/panel.ts:267-269`、`tests/panel.spec.ts:262-285`。

---

## 四、测试:哪些 bug 在测试里复现不出来,怎么守

> **术语速览**:**jsdom** 是 Node 里的纯 JS DOM 模拟环境,Vitest 用它跑 React 组件单测,没有真实浏览器的布局引擎、GPU 合成器与 DSH 客户端外壳。

1. **回归用例必须做对照实验:临时把 bug 还原回去,新用例必须变红;单测复现不出来的,改结构性断言并说实话**。
   - **违反会怎样**:写一条「看着测到了」的测试却从没见过它红,实际上是在裸测试环境里自说自话,真机一升级同名 bug 立刻回归。
   - **根因**:单元测试是宿主的替身——至少有三类真实故障在单测里天然复现不出来:① 裸 Cordis 允许父作用域 `get('remote')`,复现不了 DSH 客户端的 `without inject` 守卫;② jsdom 没有真实 Chromium/Electron 的 Metal/Skia 光栅化管线,复现不了 GPU 瓦片闪白;③ mock `dsh-client-ui-primitives` 时,假组件不会暴露真实组件的 DOM 角色或 CSS 冲突。
   - **现在靠什么防**:能复现的必做红/绿对照;复现不出来的(如 `without inject` 与 D49 分层)在源码或样式层面加结构性断言,并在 `it(...)` 用例名和注释里诚实标明「复现不了什么、锁的是什么结构」。
   - **证据**:提交 `a9232eb`、`45b0faf`、D49、`tests/client.spec.tsx` 中 `pins the DSH "without inject" fix`。

2. **mock 的 `getSnapshot()` 每次返回新对象,会把 `useSyncExternalStore` 打进无限重渲染循环**。
   - **违反会怎样**:测试挂载组件后直接卡死或抛 `Maximum update depth exceeded`。
   - **根因**:React 的 `useSyncExternalStore` 用 `Object.is` 对比连续两次 `getSnapshot()` 返回值;每次调用都现场拼 `{ status: 'ready', ... }` 会让 React 认为外部 store 每帧都在变。
   - **现在靠什么防**:测试辅助工厂(如 `tests/client.spec.tsx` 的 `source`、`tests/profile-settings.spec.tsx` 的 `form`)必须把快照存成稳定引用变量,只在状态真正改变时替换引用。
   - **证据**:0.7.5/0.7.6 测试改造、`tests/client.spec.tsx:167-172`、`tests/profile-settings.spec.tsx:62-79`。

3. **`mock-acp-server` 只在进程启动时读一次 `MOCK_SESSION_STORE`,并发存活进程会互相覆盖会话表**。
   - **违反会怎样**:先启动进程 A(持有旧内存 `sessions` 表)并让它保持存活或在途,期间启动并关闭进程 B(写入新会话号),之后进程 A 触发保存时把自己的旧 `sessions` 整张覆写回磁盘,进程 B 的会话凭空消失,后续 `session/load` 误报 `session not found`。
   - **根因**:`tests/mock-acp-server.ts:229` 只在 `makeAgent()` 启动时 `const sessions = loadTable()` 一次,`saveTable()` 直接全量 `writeFileSync` 覆盖整个 JSON 文件。
   - **现在靠什么防**:需要跨进程重连的用例按顺序先完成需落盘重连的会话创建与释放(如 `tests/live-settings.spec.ts:165-167` 先 `start` + `close` `releasedChat`,再 `start` `activeChat`),避免多个活 mock 子进程交叉写同一 `MOCK_SESSION_STORE`。
   - **证据**:提交 `6f8f0ce`、`tests/mock-acp-server.ts:221-229`、`tests/live-settings.spec.ts:165-167`。

4. **面板测试里裸调 `screen.getByRole('status')` 会撞上常驻读屏元素;且 `data-*` 容器与 `role="status"` 不一定在同一层级**。
   - **违反会怎样**:面板加上新的常驻状态提示(如空状态、条件告警条、表单反馈条)后,原本只断言局部文案的 `getByRole('status')` 直接抛 `Found multiple elements with the role "status"`;或者对着带 `data-*` 的外层容器断言 `getAttribute('role') === 'status'` 失败,因为 `role="status"` 挂在内部子 `<span>` 上。
   - **根因**:右侧栏是多区块拼装页,多个子组件都合法地拥有 `role="status"` 读屏节点,DOM 包裹结构也会随视觉重构调整。
   - **现在靠什么防**:定位反馈条先用 `within(目标区域)` 缩小范围,或直接按具体文本 / `aria-label` 查询;写 `data-*` 断言前核对组件真实 JSX 层级。
   - **证据**:0.7.5/0.7.6 测试提交(`6f8f0ce`、`45b0faf`)、`src/client/ChatDetail.tsx:254-258`、`tests/profile-settings.spec.tsx:192`。

5. **测试交接的两半规矩:实施者修完夹具后**不重跑、只报告**;接手人合并前**必须自己重跑**。**
   - **违反会怎样**:规矩的任何一半被省掉都会出事。实施者若修完就地反复重跑,机器负载飙升、还容易为了变绿而改断言;接手人若信了「已修复」不复跑,就会把没修好的测试带进发版——0.7.5 那次 `client.spec.tsx` 的 D48 用例,实施者报告「mock 已修」,接手人复跑发现 `Maximum update depth` 没了但换成了 `Found multiple elements with the role "status"`,`section` 变量取错了层级,仍要再修一次。
   - **根因**:两半规矩针对的是两种不同的失败模式——前半防「反复重跑掩盖问题」,后半防「报告不等于事实」。
   - **现在靠什么防**:实施者改完 `src/` 或 `tests/` 后(哪怕只改一行 mock)**不重跑同一文件**,把改动、根因判断、未复验的事实写进汇报;接手人在合并或发版前**逐个复跑**涉及的测试文件(一次一个,看负载),以自己的结果为准。两边的实际命令与通过条数都写进记录。
   - **证据**:0.7.5(`6f8f0ce`)与 0.7.6(`45b0faf`)的协作复盘;本机用户级 skill `release-dsh-plugin` §2「子代理说留给 CI 复验的,复验它」。

---

## 五、并行开发与合并

> 这两天共做了四次多路并行开发与合并(例如 D47 Step 3–5 与 Step 6–9 并行、D46 与 D47/D48 并行),以下七条全部来自实操返工:

1. **用独立 git worktree（共享同一 `.git` 对象的独立工作目录）+ 软链主仓 `node_modules`,不要在 worktree 里跑 `pnpm build`**。
   - **违反会怎样**:共用工作区会互相踩脏文件;在 worktree 里独立装依赖耗时占盘;多路同时 `pnpm build` 容易把旧 `lib/` 产物带入不匹配的源码校验。
   - **根因**:依赖树只读可共享,编译产物 `lib/` 是与当前分支源码强绑定的派生文件。
   - **现在靠什么防**:各路按独立 worktree 隔离,软链主仓 `node_modules`,合并回 `main` 后再统一构建与回归。
   - **证据**:D47 两路并行分支(`agy-step3-5` 与 `codex-step6-9`)。

2. **`src/client/locales.ts` 事先按功能前缀分键位**。
   - **违反会怎样**:两路都在中英文字典末尾追加无前缀短键,合并必出冲突且极易漏掉 `zh`/`en` 其中一侧。
   - **根因**:中英文字典是两个集中大对象,末尾追加天然撞行。
   - **现在靠什么防**:各路按功能前缀分区(如 `profileBackend*`、`team*`、`detail*`),并由 `tests/client.spec.tsx` 的 `keeps zh and en locale dictionaries complete with identical keys and non-empty strings` 兜底检查双语键集一致。
   - **证据**:`src/client/locales.ts`、`tests/client.spec.tsx:2899`。

3. **合并后必须跑 `tsc`(类型检查),不能只看 Vitest 绿了就放行**。
   - **违反会怎样**:合并后对象字面量出现重复键(如 `vi.mock` 里出现两个 `DisclosureRow`、两个 `IconChevronDownOutlineRegular`)或文件顶部出现重复 `import`(如两处导入 `panel-time.ts`),Vitest 的转译器可能静默采用后者并让测试蒙混过关,直到打包或发版才爆。
   - **根因**:esbuild/tsx 转译单文件不做全量重复键与符号冲突检查,只有 `tsc` 的严格模式能抓出来。
   - **现在靠什么防**:每次合并完成后必跑 `tsc --noEmit`(或 `pnpm build`),消灭所有重复键与重复 import。
   - **证据**:提交 `501fcda`（修复 `tests/client.spec.tsx` 重复 `panel-time` 导入与重复 mock 键）。

4. **两路各自写了一版组件 mock 时,去重以官方类型声明为准,绝不让 mock 迁就错误测试**。
   - **违反会怎样**:保留了形状错误的 mock(如把 `useClipboardCopy` mock 成 `copy`,或把 `DisclosureRow` mock 成独立 `aria-label` 按钮),测试虽然绿了,代码在真实宿主里却是坏的。
   - **根因**:并行两路各自补最小 mock 时容易凭印象写假签名。
   - **现在靠什么防**:合并去重时对照 `node_modules/@deepseek-ai/dsh-client-ui-primitives` 真实类型与实现,删掉假签名并修正依赖假签名的旧断言。
   - **证据**:提交 `501fcda`。

5. **大测试文件冲突合并后,人工或脚本核对一次括号平衡**。
   - **违反会怎样**:3000 行的 `tests/client.spec.tsx` 在合并块删减时少删或多删一个 `}` / `})`,导致半个文件里的 `describe` 嵌套错位甚至静默吞掉用例数。
   - **根因**:git 冲突块在重复 `it(...)` 边界上经常发生错行匹配。
   - **现在靠什么防**:合并测试文件后核对括号平衡与预期测试总数(同时对照 `AGENTS.md` 基线)。
   - **证据**:提交 `501fcda`、`d333b73`。

6. **解冲突时基线不能取任何一边(`ours`/`theirs`),必须以 `main` 为底只叠加对方的真正增量,最后按实测改**。
   - **违反会怎样**:直接取某一边会把另一路刚合入 `main` 的改动(如 `AGENTS.md` 基线、公共组件调整、D46 钩子)悄悄冲掉。
   - **根因**:并行分支的共同祖先落后于当前 `main`。
   - **现在靠什么防**:以当前 `main` 为底、逐块抽出对方增量叠加,合完按实测结果更新基线数字(如 `d333b73` 按合并后实测更新为 742)。
   - **证据**:提交 `501fcda`、`d333b73`。

7. **变基过的分支不要依赖 `fixup`/`autosquash`,合并后的修复用独立提交**。
   - **违反会怎样**:在已经变基或交错合入的分支历史里做 `fixup!` / `autosquash`,容易把提交错塞进错误的基准或引发二次大冲突(例如 `a6a7bb5` 留下孤立 `fixup!` 提交)。
   - **根因**:变基改写了 commit 哈希与上下文锚点。
   - **现在靠什么防**:合并后的修补一律用清晰描述根因的独立常规提交(如 `501fcda`、`a9232eb`),不强行重写已合入历史。
   - **证据**:提交 `a6a7bb5`、`501fcda`、`a9232eb`。

---

## 六、发布

> 确定性发版步骤全部固化在 `scripts/release.mjs` 的八道门槛(`token` → `preflight` → `ci` → `skipped` → `tag` → `npm` → `verify` → `index`),红了就停、绝不重跑或挪 tag。**完整事故记录与发版前人工判断清单见用户级 skill `release-dsh-plugin`（`~/.agents/skills/release-dsh-plugin/SKILL.md`）**,此处只列六条脚本已堵死的硬坑:

1. **Shell 管道会吞掉上游命令的退出码**。
   - **违反会怎样**:写 `pnpm test | tail -n 20; echo $?` 时,`$?` 取到的是 `tail` 的退出码 `0`,前段测试挂了也被误判为通过。
   - **根因**:POSIX shell 默认只返回管道最末命令的退出码(除非显式 `set -o pipefail`)。
   - **现在靠什么防**:发布检查统一进 `scripts/release.mjs` 用 `execFileSync` 直接拿退出码,不手敲带管道的临时命令。
   - **证据**:`scripts/release.mjs`、`ca11b54`。

2. **`verify` 的 `RELEASE_MARKERS` / `RELEASE_ABSENT` 必须写构建/压缩后的产物形态,且支持同文件多条数组**。
   - **违反会怎样**:按 TypeScript 源码里的类型名、注释或未编译写法设标志,解包 tarball 后匹配不到假红;或同一文件设多条检查时 JSON 重复键互相覆盖,漏检前几条。
   - **根因**:npm tarball 里只含 `tsc` 输出的 `lib/*.js`,不含 TS 语法与源码注释;JSON 对象同 key 后覆盖前。
   - **现在靠什么防**:对照 `lib/` 真实编译产物写标志;提交 `f3fad81` 已支持 `{"lib/x.js": ["needle1", "needle2"]}` 数组写法。
   - **证据**:提交 `f3fad81`、`scripts/release.mjs:18-20`。

3. **CI 核对与打 tag 必须比对完整 40 位 commit sha,绝不用短 sha**。
   - **违反会怎样**:用短 sha 前缀匹配或仅看「最新一次 CI 绿了」,可能把旧提交的绿灯当成本次 `HEAD` 的绿灯,把没过 CI 的提交打出 tag 发上 npm。
   - **根因**:短 sha 或分支级状态无法唯一锚定当前 `HEAD`。
   - **现在靠什么防**:`scripts/release.mjs` 的 `ci` 与 `tag` 门槛均强制比对 `git rev-parse HEAD` 的完整 40 位 sha 且结论为 `success`。
   - **证据**:提交 `ca11b54`、`scripts/release.mjs`。

4. **不要读 `/proc/loadavg` 查机器负载——那是 Linux 专属,macOS 上直接 `ENOENT`**。
   - **违反会怎样**:`pnpm release:skipped` 在 macOS 开发机开跑前读取 `/proc/loadavg` 直接崩掉。
   - **根因**:macOS 没有 Linux 的 procfs。
   - **现在靠什么防**:改用 Node 标准库 `os.loadavg()`(`node:os`),跨平台可用。
   - **证据**:提交 `57a057b`、`scripts/release.mjs:23`。

5. **GitHub Actions 的 `/actions/runs/{id}/jobs` 返回对象里没有 `logs_url` 字段**。
   - **违反会怎样**:读 `job.logs_url` 拿到 `undefined`,CI 红了脚本拉不到失败日志,发版者两眼一抹黑。
   - **根因**:GitHub Jobs API 只返回 `job.id`,日志端点是固定模板 `/repos/{owner}/{repo}/actions/jobs/{job.id}/logs`。
   - **现在靠什么防**:`scripts/release.mjs:69-75` 按 `job.id` 显式拼装日志 URL。
   - **证据**:提交 `ca11b54`、`scripts/release.mjs:69-75`。

6. **绝不先打 tag 再等 CI**。
   - **违反会怎样**:tag 推出去触发发布或被外部抓取后 CI 才爆红,被迫删 tag 重打(挪 tag),直接破坏版本不可变性与下游缓存一致性。
   - **根因**:tag 一经推送即产生外部副作用。
   - **现在靠什么防**:`scripts/release.mjs` 的 `tag <ver>` 门槛硬性要求精确完整 sha 的 CI 已为 `success` 才允许创建标签。
   - **证据**:提交 `ca11b54`、`scripts/release.mjs`。

---

## 七、调试手法

1. **探针先于派工:动手前先用最小脚本验证关键假设,不成立立刻停下报告**。
   - **违反会怎样**:直接按设计稿或直觉派工写完几百行代码与测试,集成时才发现宿主机制不支持,整批返工。两天内至少发生过四次「任务书前提不成立」被探针提前拦住的案例:① `@Remote` 裸写不认流(D46);② `backends.*.model` 不能标 `volatile`(D48);③ `configEditor.edit` 写普通字段会重建池杀在途轮(D48);④ D47 设计稿 §5.1「刷新必读到日志」与 §5.4「自动订阅实时流」与 D18/D46 硬约束冲突。
   - **根因**:对外部宿主/协议边界的纸面推演远不如 30 行真机探针可靠。
   - **现在靠什么防**:任务书模板把「先验证前提、不成立即停下报告」列为第 0 步;高风险假设(schemastery、Gateway 流、CLI 协议行为)一律先跑独立探针(如 `/tmp/acp-defaults.v7tWlG/probe.mjs`)留证再写生产代码。
   - **证据**:D34、D40、D46、D47 Step 9、D48、`/tmp/acp-defaults.v7tWlG/probe.mjs`。

2. **先逐字读错误原文,绝不盲猜**。
   - **违反会怎样**:跳过报错栈与原始消息凭经验盲猜十几分钟(例如曾以为是 Cordis/ESM 路径解析问题,实际报错原文就是 jsdom 下 `import.meta.url` 不是 `file:` scheme 导致 `fileURLToPath` 抛错)。
   - **根因**:猜测会让人不断修改无关代码,把简单环境差异放大成复杂迷案。
   - **现在靠什么防**:遇到异常先读完整 `name`、`message`、`cause` 与堆栈第一行;在 jsdom 环境下读本地文件时注意 `import.meta.url` 行为(见 `a9232eb` 注释)。
   - **证据**:提交 `a9232eb`、`tests/client.spec.tsx`（`pins the DSH "without inject" fix` 注释）。

3. **复杂 UI/渲染缺陷拿像素级证据,不凭肉眼印象下结论**。
   - **违反会怎样**:把 7.8 Hz 的 GPU 合成器瓦片闪白误判成「5 秒轮询重排」或「1 秒计时重渲染」,白改一堆数据源或 React memo 却完全治不了闪烁。
   - **根因**:人眼看不清 33–133 ms 的单帧脉冲,也分不清布局跳动与光栅瓦片丢弃。
   - **现在靠什么防**:录屏逐帧拆解 + 统计暗像素占比 + 比对跨帧像素坐标与不闪区域的 DOM 合成层对应关系。
   - **证据**:D49、`/tmp/acp-flicker/ANALYSIS.md`。

4. **用对照实验(含变异实验)验证因果,不只靠「读代码觉得对」**。
   - **违反会怎样**:以为某处校验或测试护住了边界,实际分支压根没走到或被另一处兜底掩盖。
   - **根因**:静态阅读无法验证运行时分支可达性与测试的真杀伤力。
   - **现在靠什么防**:D16 六维评审、D19 旗标校验、D48 热更新对比均用对照/变异实验——故意改坏生产代码确认测试变红,或同一探针跑 `ordinary` vs `volatile` 两组看实际输出差异。
   - **证据**:D16、D19（2026-11-05 六类变异自检）、D48、`/tmp/acp-defaults.v7tWlG/ordinary-named-model.log`。

5. **查宿主与组件行为时直接读 `lib/index.js` 或 `src/` 实现,不要只读 `.d.ts` 类型声明**。
   - **违反会怎样**:`.d.ts` 只声明参数类型,不暴露运行期副作用与 DOM 结构——只看类型会踩中:① `DisclosureRow` 在 `expandOnRowClick` 时删掉内层 `<button>` 改为整行 `<div role="button">`;② `dsh-settings` 的 `isVolatilePath` 行为;③ `dsh-subprocess-local` 的 `resolveExecutable` 把无执行权限、同名目录、目录不可读全部吞并报成 `SUBPROCESS_EXECUTABLE_NOT_FOUND`(曾导致 D31 文档与真实行为相反)。
   - **根因**:类型签名是契约下界,不是实现全貌。
   - **现在靠什么防**:遇到边界行为直接核对 `node_modules/@deepseek-ai/*` 的编译产物或源码实现。
   - **证据**:D31（2026-11-25 修订「找不到」的实际范围）、D42、提交 `501fcda`、`node_modules/@deepseek-ai/dsh-client-ui-primitives/src/DisclosureRow.tsx:64-118`。

---

## 八、渲染与性能

> **术语速览**:**ScrollingContentsLayer** 是 Chromium 滚动容器内部用于光栅化的图层;浏览器把大面积滚动内容切成固定像素尺寸的 **GPU 瓦片（Raster Tile）** 分块绘制,再由合成器拼装上屏。

1. **不要把 `position: sticky` 头部、高频重绘动画、二级 sticky 子元素和长滚动正文塞进同一个滚动容器**。
   - **违反会怎样**:在 macOS Electron/Chromium 桌面端,当详情页有在途轮、历史长 Markdown 轮展开且页面向下滚动时,正文区与下方历史卡片出现约 **7.8 次/秒(3.334 秒内 26 次,6–10 Hz)** 的整块闪白;同时 `padding: 16` 的滚动容器配 `sticky top: 0` 会在头部上方漏出 16px 滚动残影,且 `<header>` 的 `zIndex: 1` 会被代码块 `.bannerWrap` 的 `z-index: 6` 盖住。
   - **关键像素证据**(录屏 `video_20261127_104055.mp4`,101 帧):
     - 在 `f044 (1.467s)`、`f073 (2.434s)`、`f075 (2.500s)` 跨 1 秒以上的三帧中,正文首行「`只改归因，没放宽身份检查...`」均被**同一 Y 像素行的笔直水平线从字符正中切开**(上半截清晰、下半截及下方全白)——React 重渲染或卸载不可能把单行字横向切半,这是 GPU 瓦片网格边界丢弃的直接指纹;
     - 所有闪白帧中,独立合成层(sticky `<header>`、代码块 sticky `.bannerWrap`、`overflow-x: auto` 表格)全程清晰不闪,而共享同一 ScrollingContentsLayer 的正文与下方卡片同毫秒齐闪齐回。
   - **根因(推断:精确触发源待真机 DevTools `Paint flashing` + `Layer borders` 最终确认)**:`StateDot` 用 `stroke-dasharray/dashoffset` 做 60fps 无停顿主线程 SVG 重绘,`TextShimmer` 叠 32Hz `mask-image` 步进动画,若展开实时输出再叠 150ms `scrollTop` 写入,在无绘制隔离的单滚动容器内与两级 `position: sticky` 共存,持续冲击同一 ScrollingContentsLayer 瓦片失效。
   - **现在靠什么防**:
     1. 参照官方 `TextPreview.module.css` 拆分布局:外层 `<section>` 改为 `overflow: hidden` 非滚动 flex 列,`<header>` 移出滚动区成固定块,正文移入独立 `<div data-detail-scroll>`(`flex: 1; minHeight: 0; overflowY: auto; isolation: isolate`);
     2. `<RunningWorkspace>` 加 `contain: 'layout paint'`,并以滚动容器为 `root` 挂 `IntersectionObserver`,滚出视口或页签隐藏(`tab.visible === false`)时标 `data-detail-offscreen` 暂停内部动画、`TextShimmer` 传 `active={false}`、暂停离屏 `scrollTop` 写入;
     3. 在 `.acp-detail-md` 中取消代码块 `.bannerWrap` 的二级 sticky(`position: static; z-index: auto`);
     4. **边界说明**:jsdom 测不到真实 GPU 瓦片重绘,自动化单测锁住分层 DOM、CSS 规则与 `IntersectionObserver` 逻辑,最终消除闪白效果**待真机录屏确认**。
   - **证据**:D49、提交 `45b0faf`、`/tmp/acp-flicker/ANALYSIS.md`、`src/client/ChatDetail.tsx:220-258,452-476`、`src/client/panel-chrome.tsx:228-229`、`tests/client.spec.tsx`。

2. **在途态轮询内容未变时不要为了「推进时钟」每 5 秒发布新快照引用**。
   - **违反会怎样**:即使后端返回的数据逐字段相同,每 5 秒也会触发整个列表/详情/工作流树全量重渲染,并把 `LiveElapsed` 的 `useEffect([now, startedAt])` 本地 1 秒定时器每 5 秒重置一次,徒增重绘抖动。
   - **根因**:`detail-source.ts` / `chats-source.ts` / `workflows-source.ts` 早先在引入 `LiveElapsed` 独立时钟前,曾靠 `!hasRunning` 跳过相等比较来刷新显示时长。
   - **现在靠什么防**:有在途任务且内容未变时**保持快轮询间隔(5 秒,不退避到 30 秒),但复用原快照引用、不通知 React 订阅者**;由 `tests/client.spec.tsx` 三条 D49 用例锁住引用相等与快轮询不退避。
   - **证据**:D49、提交 `45b0faf`、`src/client/detail-source.ts`、`src/client/chats-source.ts`、`src/client/workflows-source.ts`、`tests/client.spec.tsx:727-744,1128-1147,2359-2379`。

---

## 附:事故年表

> 按事件提炼自 [DECISIONS.md](../DECISIONS.md) 与提交历史,一行一条,链到证据。

- **2026-11-03｜错版 peer 致插件失活**:误装 `0.1.0-rc.6` 导致 provider 行无法激活,确立 peer 紧跟 App 版本基线(D2)。
- **2026-11-04｜`run.ts` 消重重构回归 5 例**:把 `startAcpRun` 改为薄包装后官方协议面测试当场红 5 例,当场撤销,确立双实现并存(D11)。
- **2026-11-04｜硬依赖 `ctx.tools` 拖垮官方测试**:插件入口直接读 `ctx.tools` 致无工具服务的测试上下文整体失败,改为响应式 `ctx.inject(['tools'], ...)`(D13 / D16)。
- **2026-11-04｜试用前评审抓出 P0 并发泄漏与取消污染**:`busy` 放在 `await` 之后致并发重连建双连接;`cancelled` 不复位污染后续轮;取消轮迟到块污染下轮(D14)。
- **2026-11-04｜六维评审抓出盲降级与无界拆卸**:所有 load 失败都降级覆盖注册表、释放初移出活跃表致新旧双进程同 load、挂起 load 卡死 `disposeAll`,全部收紧(D6 / D16)。
- **2026-11-09｜网络切换暴露「能 load 一用就崩」死循环**:4 个 kiro 会话可 `session/load` 但 8 秒必断,无限重试,补齐内存连续 3 次 `error` 后主动新会话恢复(D6 2026-11-09 修订)。
- **2026-11-18｜过宽 load 降级误弃上下文**:三引擎审查指出任何协议级拒绝都降级会把暂时性错误变丢会话,收窄为仅明确「会话不存在」才降级(D6 2026-11-18 修订)。
- **2026-11-19｜Codex 取消竞态致 `turn/interrupt` 永不发出**:取消早于 `turn/start` 回复时未知 `turnId` 直接返回,补齐回复到达后补发中断及 300ms 延迟回归(D2 2026-11-19 修订)。
- **2026-11-25｜Kiro v3 刚建会话 `effortLevel` 延迟就绪且非法值静默成功**:真机探针发现新建/重连后约 40–240ms 才补出 `effortLevel`,且非法值回成功不报错,改为配置期校验 + 按回复核对有限重试(D34)。
- **2026-11-25｜宿主 `resolveExecutable` 吞掉权限错误**:核对实现发现无执行权限/同名目录均报成找不到,与原设计假设相反,据此修正 D31 文档与改派说明(D31 2026-11-25 修订)。
- **2026-11-26｜撤销误拦 `wait_agent`**:漏读官方 `wait-agent.ts` 的 inbox 提前唤醒逻辑,错把 `job_output` 的 600s 阻塞假设套到 `wait_agent`,0.7.1 撤销拦截(D22 2026-11-26 修订、提交 `2c66d7b`)。
- **2026-11-26｜独立 `skill` 开关发布 15 分钟即撤并**:仅开技能加载不开只读文件会导致无法读 `references`,0.6.0 合并进 `readOnlyFs`(D37 2026-11-26 修订、提交 `4af44ab`)。
- **2026-11-26｜agy 1.5.13 探针推翻 `effortLevel` 复用假设**:实测 `effortLevel` 报 `-32602`,须走 `thought_level`(四档、无 `max`),且跨进程 `session/load` 会回到默认 `high` 须重连重设(D40、提交 `caa7546`)。
- **2026-11-26｜发版脚本现敲累计 7 类错**:管道吞退出码、短 sha 误判、缺 `logs_url`、先打 tag 再等 CI、Linux 专属 `/proc/loadavg`、单键覆盖多条标志,沉淀为 `scripts/release.mjs` 与 skill(提交 `ca11b54`、`57a057b`、`f3fad81`)。
- **2026-11-26｜D46 裸 `@Remote` 被识别为 unary**:SRC 反射不从 `async *` 推断流模式,改为 `@Remote({ mode: 'stream' })` 并补真实 Gateway 端到端测试(D46、提交 `8f0d65c`)。
- **2026-11-26｜D47 两路合并暴露重复 mock/导入与 `DisclosureRow` 假按钮**:Vitest 未拦截的重复键与 `DisclosureRow` 整行即按钮行为经 `tsc` 与真组件核对修净(D47、提交 `501fcda`)。
- **2026-11-27｜只读 `watch` 误套写操作 owner 校验**:详情页能看跨主会话历史却看不到实时输出,0.7.4 改回仅按存在性校验(D44 修订、提交 `7a1ce33`)。
- **2026-11-27｜父作用域 `scope.get('remote')` 触发 DSH `without inject` 拦截**:真机详情页始终显示「实时输出不可用」,裸 Cordis 单测未复现,0.7.5 改为子作用域捕获 + 结构性断言守门(提交 `a9232eb`)。
- **2026-11-27｜探针证伪 `backends.*.model` 标 `volatile` 与 `configEditor.edit` 热改**:证实字典子项不可标 `volatile`、写普通字段必销毁池杀在途轮,改走顶层 `backendDefaults` 字典(D48、提交 `6f8f0ce`)。
- **2026-11-27｜详情页单滚动容器触发约 7.8 Hz GPU 瓦片闪白与顶缝漏字**:录屏逐帧抓出跨秒同像素行水平半字裁切,0.7.6 拆分隔离滚动区、离屏停动画并稳定在途快照,待真机复核(D49、提交 `45b0faf`)。

# 持久会话面板 v2:穿透式详情——方案研究与设计提案

状态:研究稿,待用户裁定后进入实施(2026-11-04)。
输入:PANEL-DESIGN.md(v1 已上线,§2.5 把"轮次历史展开"留给 v2)、DECISIONS.md D6/D15/D17、`src/pool.ts`、`src/panel.ts`、`src/client/*`。

引用约定:
- 不带前缀的 `packages/...:行号` 相对官方只读 checkout `/Users/Tulane/Developer/open-source-projects/deepseek-harness` 根目录(分支 `my-subagent-acp` @ `dsh-v0.2.1-rc.5`,本次 `git describe` 确认)。
- `dsh-kiro:` 前缀指 `dat-lequoc/dsh-kiro` 在 `/tmp` 的浅克隆(commit `c9a397f`,2026-10-24)。
- 本仓库文件写 `本仓库 src/...`。
- 每条结论标 **[读码]**(读源码得出)、**[实测]**(本次跑过)或 **[推断]**(由读码推出,未运行验证)。

---

## 0. 结论先行

- 官方右侧栏做"列表 → 每项一个详情页"有现成的标准做法:**用 `dsh-resource://` 资源地址开页签**。地址本身带着条目身份(文件路径、子会话 id、轮次序号);同一地址再开一次会聚焦已有页签;关一个页签只结束它自己的生命周期;页面刷新后布局会恢复,地址也跟着恢复。先例有 changes-review、subagentchat、plan、文件预览。
- v1 当时以"过重"否掉"每会话一个资源页",否的是把**列表**做成资源页。对**详情**来说,资源页签恰好是官方正解。而且它不需要注册 resource provider:changes-review 只占用地址、不注册 provider,数据由自己的 store 拉取(§1.2)。这条变体的实际成本只有一个页签定义加一个正文组件。
- 数据层是主要工作量。注册表只有计数和摘要,没有逐轮内容。提案:注册表保持不动,每个会话旁边新增一个只追加的**轮次日志**(JSONL),在轮结算时写入。这不触碰 D6 的注册表原子写、单飞和降级语义。
- 推荐方案 A:卡片点击 → `tab.actions.openResource('dsh-resource://acp-resume-chat/<chatId>')` → 详情页签。页签显示会话状态、诊断、轮次历史(摘要列表,展开时按需取全文)以及释放/删除操作。估计 3.5–4 人日。

---

## 1. 官方模式盘点

### 1.1 母版→详情的底层机制:页签类型的两个字段

`SidebarRightTabDefinition`(`packages/client/ui-sidebar-right/src/client/tab-registry.ts:94-139`)里有两个字段决定一个页签类型怎样"一项一页":

| 字段 | 语义 | 地址 / 页签身份 | 依据 |
|---|---|---|---|
| `patterns`(给出) | **资源类型**:认领 `dsh-resource://` 地址的 glob;含 `:` 的模式匹配整串地址 | `contentId` = 地址本身。同一地址重复打开就是同一个页签,打开天然幂等 | `tab-registry.ts:110-119`、`:142-153`(`contentId` 注释:"Two opens of the same address are the same tab") [读码] |
| `patterns`(省略) | **页类型**:按 kind 打开,不认领任何地址 | 地址由侧栏自拼为 `sidebar://<kind>` | `contract/seed.ts:38-47` [读码] |
| `multiple: true` | 只对页类型有意义:每次 `openTab` 生成独立内容 | 地址变成 `sidebar://<kind>/<randomUUID>`,每次打开都是新页签,**没有去重** | `tab-registry.ts:105-106`;`service.ts:406` [读码] |
| `multiple` 省略 | 页类型在每个窗格内只开一页 | 同窗格去重 | `service.ts:445-447`;`contract/slots.ts:129-130` [读码] |

去重规则(`service.ts:443-447`):资源页签默认在**所有窗格**里找同一个 `(kind, contentId)` 并聚焦它,除非调用方传 `revealIfOpened: false`;页页签只在目标窗格内去重。[读码]

**生命周期**:Tab 域给每条页签记录一个 occurrence,其中有一个 `AbortSignal`。`sync` 在每次布局提交后对账:记录消失(被关掉)就 abort 并丢弃对应的 occurrence,其他记录不受影响(`tab-domain.ts:97-111`)。`signal` 只在记录消失或插件卸载时中止,收起侧栏、切换会话都不会触发(`contract/slots.ts:182-183`)。切到别的页签会卸载正文,但内容不丢(`tab-domain.ts:1-8` 头注)。[读码]

**刷新后恢复**:侧栏把布局写进 localStorage `dsh.sidebar-right.v1.<sessionId>`(`ui-sidebar-right/src/client/persistence.ts:7`)。每个页签只存 `id / kind / contentId / title` 四个字段(`persistence.ts:20`)。**导航参数(`params`)不持久化**(`ui-sidebar-right/README.zh.md:74`)。所以身份写进地址的资源页签,刷新后能自己恢复;靠 `params` 传身份的页类型,刷新后就丢了。[读码]

> 注:`docs/subsystems/sidebar-right.zh.md:152` 仍写着"布局状态只在内存里",与 README:74 和 `persistence.ts` 矛盾。以代码为准,这句文档已过时。[读码]

**打开入口**:正文通过 `useTabInfo()` 拿到 `tab.actions`。其中 `openResource / openTab / close` 作用于这个页签所在的会话(`contract/slots.ts:142-163`)。新页签默认落在当前页签所在的窗格(`tab-domain.ts:168-176`);`preferNewPane` 会在空间允许时分栏;`replaceTab: true` 原地替换当前页签(`contract/slots.ts:124-133`)。[读码]

**无类型兜底**:页签类型被注销后(例如插件被关掉),残留的记录渲染官方的"nothing can view this"提示,不会白屏(`contract/slots.ts:52-57`)。[读码]

### 1.2 模式一:资源地址页签,不注册 provider(changes-review 式)

- **先例**:`ui-deliverables` 的 changes-review。定义里 `patterns: ['dsh-resource://changes-review/**']`,用 `canOpen` 校验地址,`title(address)` 从地址解析出轮号(`packages/client/ui-deliverables/src/client/review-definition.ts:38-50`)。地址把会话、事件序号、轮号编进路径(`ui-deliverables/src/changes.ts:143-165`)。入口卡片调用 `ctx.sidebarRight.openResource(address, { params: { index } })`,`index` 指定先显示哪个文件(`ui-deliverables/src/client/index.ts:76-78`)。
- **没有 resource provider**:`ui-deliverables` 的 `inject` 不含 `resources`(`index.ts:43`),全仓搜 `resources.register` 只命中 workspace-files、ui-plan、ui-subagent。changes-review 的数据由插件自己的 `ChangesSummaryStore / ChangesDiffStore` 按需加载(`index.ts:51-52,89-97`;`ReviewTab.tsx:91-104`)。地址只用来当身份。[读码]
- **页签内的分层视图**:一个页签对应一轮,里面用文件选择菜单(`Menu`)切换"当前看哪个文件",再加分栏/换行开关(`ReviewTab.tsx:113-152`)。这些视图选择存在**按页签分桶的 slot store** 里(`review-store.ts:22-25` 的 `byTab`),页签的 `signal` abort 时清掉对应的桶(`ReviewTab.tsx:86-90`)。每次导航到这个页签,`navigation.revision` 加一,正文据此应用新的 `params.index`(`ReviewTab.tsx:81-85`)。[读码]
- **优点**:没有资源模型的开销;刷新、去重、多实例全都免费获得;隐藏的页签不轮询(数据跟着正文挂载走)。
- **缺点**:同一份数据被两个组件同时显示时要自己共享缓存(changes-review 用插件级 store 解决);切页签卸载正文后,组件内状态会丢(用 slot store 解决)。

### 1.3 模式二:资源地址页签 + resource provider(subagentchat / plan 式)

- **先例 subagentchat**(和本需求同构:一个外部会话一个页签):
  - 地址是 `dsh-resource://subagentchat/session/<child>?parent=&mode=`,有成对的拼装和解析函数(`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:20-89`)。
  - provider 的 `open` 先产出一帧引用,然后挂起等待 abort,`finally` 里释放(`:102-118`)。
  - 页签定义用 `patterns` + `canOpen` + `title`,标题动态取子会话的 label(`:182-194`)。
  - 正文用 `useResource(tab.contentId)` 读取(`:155-169`)。
  - 入口"在侧栏打开"调用 `openResource(address, { kind, preferNewPane: true })`(`ui-subagent/src/client/index.ts:64-68`)。
  - 注册包在 `ctx.inject(['resources', 'sidebarRightTabs'], ...)` 里(`index.ts:58-60`)。[读码]
- **先例 plan**:provider 从会话历史里读出不可变的 plan Markdown,失败以 `ok:false` 帧表达(`packages/client/ui-plan/src/client/plan-resource.ts:37-82`)。页签定义见 `ui-plan/src/client/index.ts:64-69`;正文与标题槽用 `useResource(tab.navigation.address)` 读取(`PlanPreview.tsx:18-54`)。[读码]
- **资源模型的契约**:
  - 一个协议恰好一个 provider(`packages/client/resources/src/client/resources.ts:82-98`)。
  - 第一个持有者打开流,最后一个释放时中止流(`resources.ts:158-168`)。
  - **侧栏在每条已开页签的整个存续期都钉住它的地址**(`ui-sidebar-right/src/client/index.ts:127`;`tab-domain.ts:107-111`),所以页签隐藏后流仍然在跑。
  - 流只推元数据,不推载荷(`.agents/notes/implemented/architecture/2026-09-05-client-resource-model.zh.md` "帧"一节)。[读码]
- **优点**:多个组件(正文、标题槽、将来的其他席位)共享一条流;`useResource` 是每个 slot 组件都有的全局标准 prop,不用自己做注入。
- **缺点(对本需求)**:页签只要开着就一直被钉住,provider 的轮询在页签隐藏时也不停。我们的数据源是 host 轮询,不是推送,开 N 个详情页签就有 N 路常驻轮询。provider 拿不到"页签是否可见"的信息(`ResourceOpenContext` 只有 `signal`,`resources/src/client/contract.ts:65-68`)。另外还要多 inject 一个 `resources` 服务。[读码+推断]

### 1.4 模式三:多实例页类型(`multiple: true` / `params`,terminal、schedule 式)

- **terminal**:`multiple: true`,每次打开都是新实例(`packages/client/ui-sidebar-terminal/src/client/index.ts:71-74`)。终端本来就要求"同一类东西开多个互相独立"。[读码]
- **scheduleTask**:页类型,不声明 `patterns`,身份经 `openTab(kind, { params: { sessionId, id } })` 传入(`packages/client/ui-schedule/src/client/definition.ts:1-41`;`index.ts:197-199,224-226`)。因为 params 不持久化,它额外写了 223 行的 `TaskTabBindings`,把"页签 id → 任务"另外存进 localStorage,刷新后从这里恢复(`ui-schedule/src/client/task-tab-bindings.ts:1-20`;`index.ts:148-154`;`ScheduleTaskTab.tsx:95-108`)。它的头注直接写明了原因:"The contentId cannot serve as this key because every tab of one page kind records the same one"(`task-tab-bindings.ts:9-11`)。[读码]
- **优点**:地址语法完全不用自己定。
- **缺点(对本需求)**:不加 `multiple` 时一个窗格只能开一个详情;加了 `multiple`,点同一张卡两次会开两个重复页签(`service.ts:406` 每次生成新 UUID)。两种情况都要自己补"刷新恢复"。在可选方案里它最重。

### 1.5 模式四:页签内主从切换(plugin-manager / schedule 主页式)

- **plugin-manager**(主栏页面):用一个 slot store 保存 `view` 联合类型(`list | more | package | item | row`)(`packages/client/ui-plugin-manager/src/client/navigation-store.ts:4-31`)。详情顶部有共享的"面包屑返回"按钮 `DetailTop`(`PluginManagerPage.tsx:504-525`),各详情页传入 `crumbLabel={t('backToList')}` 和 `onBack`(`:614-629`、`:652-672`)。[读码]
- **schedule 任务主页**(主栏):列表和右侧详情并排,选中项用组件 `useState` 保存(`ui-schedule/src/client/TaskManagerPage.tsx:45-53`),选中后渲染 `<TaskDetail>`(`:204-206`)。**同一个 `TaskDetail` 组件**也用在侧栏的 scheduleTask 页签里(`ScheduleTaskTab.tsx:1-8,25`)。所以官方的分工是:主栏页面内部做主从切换,侧栏里一个详情一个页签。[读码]
- **优点**:不新增注册;改动只在 `ChatsPanel` 内。
- **缺点**:侧栏宽度窄,列表和详情只能二选一显示;一次只能看一个会话;切页签或刷新后详情丢失(除非另外存);官方侧栏页签里**没有**这种先例。

### 1.6 模式五:Modal

在官方 `packages/client` 里,`Modal` 只用于确认、登录、安装结果这类短暂对话(例:`ui-schedule/src/client/TaskDetail.tsx:904` 删除确认;`ui-plugin-manager/src/client/PluginManagerPage.tsx:1048,1079` 安装结果)。没有找到用 Modal 承载详情浏览的先例。v1 已经用它做删除确认(本仓库 `src/client/ChatsPanel.tsx`),v2 继续这样用,不拿它做详情。[读码]

### 1.7 导航与返回的惯例

- **侧栏没有内容导航栈**:`ui-sidebar-right/README.zh.md:149`("没有内容导航栈……编辑器式的已访问内容前进/后退尚未构建");`docs/subsystems/sidebar-right.zh.md:160`。[读码]
- **侧栏惯例是"并存"**,详情是新页签,和列表页签并排:
  - 文件树行调用 `tabActions.openResource(...)`,在同窗格开文件页签,树页签保留(`packages/client/ui-sidebar-files/src/client/FilesBody.tsx:187`)。
  - changes-review 的"打开文件"同理(`ReviewTab.tsx:143-145`)。
  - subagentchat 用 `preferNewPane: true` 在旁边分栏打开(`ui-subagent/src/client/index.ts:64-68`)。
  - "返回"就是点列表页签的 chip。`replaceTab: true` 只有引导页使用("引导页让位给它打开的页",`ui-sidebar-right/README.zh.md:123`)。[读码]
- **主栏页面惯例是"页内面包屑返回"**(§1.5 plugin-manager)。
- **详情对象被删除后自行关闭**:scheduleTask 删除成功后调用 `tab.actions.close()`(`ScheduleTaskTab.tsx:133`;头注 `:10-12`)。[读码]

### 1.8 官方文档与 notes 补充

- `.agents/notes/implemented/architecture/2026-09-05-client-resource-model.zh.md`:说明资源模型为什么"只认地址"。页签记录只能存可序列化数据(地址 + 参数),开启方不能把数据交给正文,所以"组件必须只凭地址找到数据"(Problem 节)。该文也记录了被否决的方案"每 tab 一个流 hook / 框架代管 fetch"(Alternatives 节)。这正是本提案把 chatId 编进地址的理由。[读码]
- `docs/subsystems/sidebar-right.zh.md:36-51`(页签类型注册与路由)、`:76-113`(导航与 `useTabInfo`)、`:141-147`(内置类型清单,含 subagentchat)。[读码]
- `.agents/notes/` 里没有专门讨论"列表 → 详情"的 note;`docs/` 下另有 `docs/subsystems/client-resources.zh.md`,内容与资源模型 note 一致。[读码]

### 1.9 盘点汇总

| 方式 | 官方先例 | 刷新恢复 | 重复点击 | 多会话并看 | 隐藏时开销 | 本包新增成本 |
|---|---|---|---|---|---|---|
| 资源地址页签,无 provider | changes-review | 免费 | 聚焦已有 | 可 | 无 | 定义 + 正文 + 数据源 |
| 资源地址页签 + provider | subagentchat、plan、文件 | 免费 | 聚焦已有 | 可 | 钉住期间流常驻 | 上项 + provider + inject `resources` |
| 页类型 `multiple` / `params` | terminal、scheduleTask | 要自建绑定 | 重复开页 | 可 | 无 | 上项 + localStorage 绑定 |
| 页签内主从切换 | 主栏 plugin-manager、schedule | 要自存 | — | 不可 | 无 | 仅 ChatsPanel |
| Modal | 无(只用于确认) | 否 | — | 不可 | 无 | — |

---

## 2. 第三方示例:dat-lequoc/dsh-kiro

本次能联网:`web_fetch` 能读 GitHub 页面,`git clone --depth 1` 成功,commit `c9a397f`,与 PANEL-DESIGN §3.6 引用的版本一致。GitHub REST API 无响应,所以以克隆内容为准。[实测]

- 它的浏览器半只有一个文件 `client/index.cjs`(1185 行),手写 CJS,用 `React.createElement`。它只注册两个槽位:`settings.section`(设置页 Kiro 区)和 `conversation.input.right`(额度小标)(`dsh-kiro: client/index.cjs:1155-1160,1170-1179`)。[读码]
- 全文搜 `sidebarRight|resources.register|openResource|openTab`,0 次命中。它**不用右侧栏,也不用资源模型**。[实测]
- 账号区是**扁平列表**。每行显示名称、认证方式、区域、状态,行内放"使用 / 重连 / 移除"三个按钮,没有点进单个账号的详情(`dsh-kiro: client/index.cjs:1014-1043`)。唯一的"二级视图"是登录方式选择,用自绘的 overlay + `role="dialog"` 模态实现,开关状态存在组件 `useState` 里(`:554`、`:1126-1139`)。[读码]
- **结论**:dsh-kiro 没有列表 → 详情交互,对 v2 没有可借鉴的穿透模式。它和 v1 一样是"卡片 + 行内操作"。

---

## 3. v2 方案提案

### 3.1 候选

| 候选 | 形态 | 结论 |
|---|---|---|
| **A. 详情资源页签,无 provider**(changes-review 式) | 新页签类型 `acp-resume.chat`,地址 `dsh-resource://acp-resume-chat/<chatId>`;卡片点击 → `tab.actions.openResource(address)`;正文挂载期间轮询 host 的 `detail` | **推荐** |
| B. 详情资源页签 + resource provider(subagentchat 式) | 同 A,另注册 `acp-resume-chat` 协议的 provider,正文和标题槽通过 `useResource` 共享 | 备选。等将来需要多个席位共享同一会话数据(例如会话区工具行也要显示该会话状态)再升级;A → B 的升级不改地址 |
| C. 页签内主从切换(plugin-manager 式) | `ChatsPanel` 内部 `view: list \| detail(chatId)`,详情顶部放"← 返回列表" | 不推荐:侧栏没有先例,不能并看,刷新后丢失。只适合"想零注册快速试水"的情况 |

**为什么 A 优于 B**:本包的数据源是 host 轮询(通道 B 的 `rpc.call` 没有事件推送,PANEL-DESIGN §3.6.1)。用 B,开着的详情页签在隐藏时也会被侧栏钉住、持续轮询(§1.3)。用 A,轮询跟着正文挂载走,和 v1 `ChatsSource` 的"有订阅者才轮询"策略一致(本仓库 `src/client/chats-source.ts` 头注)。A 少一个服务依赖,刷新、去重、并看能力和 B 完全相同。[推断]

**重新评估 v1 的"资源页过重"**:v1 的比选(PANEL-DESIGN §2.1)否掉的是"把每会话一个资源页当作**唯一形态**"。那种做法没有总览,用户得先知道 chatId 才能打开。v2 保留 v1 列表页签作为母版,只把**详情**做成资源页签。这正是官方 files→text、changes 卡片→review、子智能体目录→subagentchat 的分工。去掉 provider 之后,资源页签的注册成本是一个约 15 行的定义加一个正文槽位。"过重"的理由对详情不成立。

### 3.2 交互规格(方案 A)

**入口**
- v1 卡片整体可点(标题区做成按钮,`aria-label="查看 chat-xxxx 详情"`),也可以单独加一个"详情"按钮。点击调用 `tab.actions.openResource(chatAddress(chatId))`:默认落在列表所在的窗格;如果该会话的详情页签已经开着(任意窗格),就聚焦它(§1.1 去重)。
- 不加引导页入口(`guide`)。详情只能从列表进入,和 changes-review、subagentchat 一样。
- 次要入口(v3):模型工具输出里的 chatId 做成链接,需要会话区席位配合,超出 v2。

**页签 chip**:`title(address)` 返回 `chat-<前 8 位>`(打开时固定,`tab-registry.ts:131-136`)。v2 另外注册 `sidebar.right.pane.tab.title` 槽位,显示 label 或首轮摘要,官方先例是 PlanTitle(`PlanPreview.tsx:47-54`)。

**返回**:不做页内返回。列表页签与详情页签并存,点列表 chip 回到列表(§1.7 侧栏惯例)。

**详情页内容清单**

| 区块 | 内容 | 版本 |
|---|---|---|
| 头部 | label(或 chatId 短号)+ 完整 chatId(可复制);状态:活跃 / 已释放 / 进行中;轮数;最后活跃(相对时间 + 绝对时间 tooltip);刷新按钮 | v2 |
| 会话事实 | cwd;完整 remoteSessionId;agent 指纹(`command + args`);**指纹与当前配置是否一致**(不一致时显示警告:下次 send 会被 `assertSameAgent` 拒绝,本仓库 `src/pool.ts` `assertSameAgent`) | v2 |
| 操作 | 释放(活跃时可用)、删除(二次确认,复用 v1 Modal);删除成功后 `tab.actions.close()` 自动关掉本页签(§1.7 scheduleTask 先例) | v2 |
| 进行中轮 | 有在途轮时置顶一行:消息首行 + 开始时间 +"进行中"标记 | v2 |
| 轮次历史 | 新到旧排列。每行:`#序号`、时间、结局标签(completed / aborted / error / max-tokens / refusal / send-failed)、降级徽章(`freshSession`)、消息首行。点行展开:完整消息、完整回答、诊断行。默认加载最近 20 轮,底部"加载更早" | v2 |
| 诊断汇总 | 头部下方:最近一次非 completed 轮的结局与诊断首行;最近一次降级的时间 | v2 |
| 早于 v2 的轮次 | 注册表 `turnCount` 大于日志里 completed 轮数时,显示"更早的 N 轮未记录(v2 之前)" | v2 |
| 进行中轮的流式文本 | 需要池在内存里缓存在途输出,再经 detail 透出 | v3 |
| 思考、工具调用、计划 | connection 目前把这些丢弃(本仓库 `src/connection.ts` 第 304-305 行注释),要先改 connection 的记录面 | v3 |
| jobId 关联 | 与 `job_output` 互链;要让 tools 把 jobId 透给 pool | v3 |
| 面板内取消在途轮 / 发消息 | 与 v1 §2.5 相同:不做。发消息只走工具;取消入口仍在 GUI 全局停止 / `job_kill` | 不做 |
| 搜索、过滤、导出 | — | v3 |

**展开状态**:v2 用组件 state。代价是切到别的页签再切回来时,展开的行会合上(正文被卸载,§1.1)。如果用户觉得这点不便,v2.1 改成按页签分桶的 slot store,照 changes-review `review-store.ts:22-25` 和 `ReviewTab.tsx:86-90`。`@deepseek-ai/dsh-client-store` 在官方共享基线模块里(PANEL-DESIGN §3.6.2 白名单),可以直接 import。

### 3.3 数据层:按轮持久化(提案为 D18)

**为什么不把轮次写进注册表**:注册表每次写都是"整文件重写 + 原子改名"(本仓库 `src/pool.ts` `ChatRegistry.write`)。把轮次内容塞进去,每轮重写的数据量会随历史线性增长;损坏留证(`setAside`)的影响范围也会从"会话索引"扩大到"全部历史"。官方 schedule 的投递历史虽然放在同一文档里,也专门做了裁剪,理由正是"an unbounded array would grow that document with every acknowledgment"(`packages/schedule/schedule/src/delivery-history.ts:21-25`)。[读码]

**设计草图**

```
$DSH_HOME/storages/acp-resume/
  registry.json              # 不变:version 1,字段不增(D6 原子写不动)
  turns/
    chat-<uuid>.jsonl        # 新:每个会话一份只追加的轮次日志
```

- 位置:`dirname(registryPath)/turns/`。自定义 `registryPath` 时日志跟着走。
- 每行一条结算后的轮记录:

```ts
interface TurnRecord {
  v: 1
  seq: number                  // 本会话内从 1 递增,含非 completed 轮
  startedAt: number            // 进入 prompt 的时刻
  settledAt: number
  message: string              // 截断上限 8 KiB(UTF-8),超出时 messageTruncated: true
  output: string               // 截断上限 32 KiB,超出时 outputTruncated: true
  stopReason: string           // completed / aborted / error / max-tokens / refusal / … / 'send-failed'
  diagnostic?: string
  freshSession: boolean
  remoteSessionId: string      // 降级后会变,便于对照 kiro 侧会话
  error?: string               // 仅 send-failed:重连失败等在 prompt 之前的报错(连接层的安全文案)
}
```

- **写入时机**:在 `pool.send` 结算处,紧接着现有的 `registry.upsert(settledEntry(...))` 追加一行(`appendFileSync`,单写者,与注册表相同)。重连失败或在 prompt 之前被拒的 send 也追加一条 `send-failed` 记录,这是诊断里最有用的一类。
- **与 D6 的边界**(实施时写进 D18):
  - 日志写失败只走 `onWarn`,绝不改变本轮结果。这与 D6"轮结果优先于拆卸失败"同理。
  - 重连失败**不改注册表**的语义不变。`send-failed` 记录写在另一个文件里,不违反 D6。
  - 轮进行中被 purge:沿用 `send` 结算处"重读注册表,条目没了就不复活"的检查。条目没了就不追加,避免 purge 之后留下残余日志。
  - `close`(释放)保留日志;`remove`(purge)删除注册表条目后 `unlink` 日志,删除失败只告警。
  - 单飞、降级判定、取消条款全部不动。`turnCount` 仍只在 completed 时加一(注册表是 v1 卡片的权威来源)。
- **D17 后台模式**:日志在 pool 层写,同步和后台两种 send 都覆盖,tools 层不用改。jobs 的 256 KiB 输出环(D17)和本日志互相独立:前者给模型读,后者给面板看。
- **保留上限**:每个会话保留最近 200 条。追加后如果行数超过 400,就用"临时文件 + 原子改名"压回 200 条,做法同 schedule `appendDelivery` 只在写路径裁剪(`delivery-history.ts:30-49`)。上限 v2 先写成常量,有需求再进 Config。
- **容错读取**:逐行解析,跳过不能解析的行(进程崩溃可能留下半行),并记一次告警。
- **池新增的只读面**:
  - `listChats()` 的每行加 `inFlight: boolean` 和 `agentMatches: boolean`(由现有 `assertSameAgent` 的判定改成布尔值)。
  - 新增 `chatDetail(chatId)`,返回注册表投影、在途轮 `{ message 首行, startedAt }`、轮摘要页。
  - 新增 `turn(chatId, seq)`,返回单轮全文。
  - 在途轮的消息和开始时间只存在内存里(`LiveChat` 加两个字段),不落盘。
- **隐私**:日志以明文保存用户发给外部 agent 的消息和回答,和 kiro 自己的会话存储同级。在 README「配置」和 D18 里写明。是否加 `recordTurns: false` 开关,请用户定(§5 待决 2)。

### 3.4 Host 与 Client 的文件级改动清单

**Host 半(node)**

| 文件 | 改动 | 估计 |
|---|---|---|
| `src/turn-log.ts`(新) | `TurnLog` 类:append / page(before, limit)/ get(seq)/ remove / compact;截断与容错解析 | ~150 行 |
| `src/pool.ts` | 构造时创建 `TurnLog`;`send` 在结算和失败路径追加记录;`remove` 后删日志;`LiveChat` 记录在途消息;新增 `chatDetail` / `turn`;`PooledChatInfo` 加 `inFlight`、`agentMatches` | +60–80 行 |
| `src/panel.ts` | 新增 `@Remote detail(chatId)`、`@Remote turns(chatId, before, limit)`、`@Remote turn(chatId, seq)`。参数都是简单标识符,并自行校验类型:SRC 模式缺参会传 `undefined`(PANEL-DESIGN §3.6.1);`limit` 限制在 1–50 | +50 行 |
| `src/tools.ts` | **不改**。`acp_chat_list` 是否显示 `inFlight`,留作 v3 再议 | 0 |
| `tests/turn-log.spec.ts`(新) | 追加、分页、截断、半行容错、压缩、删除 | ~10 例 |
| `tests/pool.spec.ts` | 各结局都写日志;`send-failed` 记录;purge 不复活;日志写失败不影响轮结果 | +5 例 |
| `tests/panel.spec.ts` | 三个新方法的映射和参数校验(未知 chatId、非法 `limit`) | +4 例 |

**Client 半(浏览器)**

| 文件 | 改动 | 估计 |
|---|---|---|
| `src/client/chat-address.ts`(新) | `chatAddress(chatId)` / `parseChatAddress(address)`,写法照 `ui-subagent/.../sidebar-chat/index.tsx:51-89`;协议 host 用 `acp-resume-chat`(URL 解析器会把 host 转成小写,`resources.ts:56-67`) | ~35 行 |
| `src/client/detail-source.ts`(新) | 每个 chatId 一个数据源。规则同 v1 `ChatsSource`:有订阅者时每 5 秒拉一次 `detail`,丢弃过期响应;`loadOlder` / `loadTurn` 按需拉取;close / purge 之后刷新 | ~140 行 |
| `src/client/ChatDetail.tsx`(新) | 详情正文:头部、会话事实、操作、进行中轮、轮次历史(可展开行)、诊断汇总;删除确认复用 Modal;删除成功后 `tab.actions.close()` | ~260 行 |
| `src/client/ChatDetailTitle.tsx`(新) | chip 标题槽:label 或首轮摘要 | ~25 行 |
| `src/client/ChatsPanel.tsx` | 卡片加"查看详情"入口,调用 `useTabInfo().tab.actions.openResource(chatAddress(id))`;props 增加框架注入的 `useTabInfo` | +20 行 |
| `src/client/face.ts` | `PanelChat` 加 `inFlight?`、`agentMatches?`(可选,兼容旧 host);新增 `ChatDetailSnapshot`、`TurnSummary`、`TurnFull`;结构化重述所需的 `useTabInfo` 形状 | +60 行 |
| `src/client/index.ts` | 在同一个 `connection` 作用域内:注册第二个页签类型 `{ id: 'dsh-acp-resume/chat', kind: 'acp-resume.chat', patterns: ['dsh-resource://acp-resume-chat/**'], canOpen, title }`(不设 `priority`,默认就是 `extension`,`tab-registry.ts:58-59`);再按新 id 注册 `sidebar.right.pane.tab` 和 `.title` 两个槽位。`inject` 不变,方案 A 不需要 `resources` | +35 行 |
| `src/client/locales.ts` | 详情页的中英文案 | +40 行 |
| `tests/client.spec.tsx` / `tests/detail.spec.tsx`(新) | 地址往返;详情渲染(空历史、早于 v2 的提示、展开、各结局标签、指纹警告);删除后关页签;卡片入口调用 `openResource`;数据源轮询启停 | ~14 例 |

**文档**:DECISIONS 新增 D18(轮次日志),修订 D15(v2 详情页签);PANEL-DESIGN.md 新增 v2 章节,改写 §2.5 的"留 v2";README「模型工具」表和「开发」测试计数;AGENTS.md 期望基线与 layout;IMPLEMENTATION-PLAN 步骤。

**工作量**:数据层 1 天;host 方法 0.5 天;client 1.5–2 天;文档与装机验收 0.5 天;合计 **3.5–4 人日**。新增约 33 例测试,绿色回归面从当前 172 涨到约 205。[推断]

> 回归基线说明:任务描述写的是 168 绿,对应提交 `16dacd0`。本次实跑 `vitest run` 得到 **172 passed / 7 files** [实测]。多出的 4 例来自研究期间由另一会话提交的 `98f93ed`(已释放会话折叠分组,client 14→18 例)与版本提交 `31288bf`(0.1.6)。v2 的 `ChatsPanel.tsx` 改动以这一版(含折叠分组)为基础。

### 3.5 方案 C(页签内主从切换)的改动量,供对照

只改 `ChatsPanel.tsx`(加 `view` 状态和返回按钮)和 `ChatDetail.tsx`。数据层改动与 A 相同,host 改动相同。client 少了地址、定义、标题槽,约省 0.5 天。代价见 §1.5。数据层是两方案共享的大头,所以 C 省下的量有限。

---

## 4. 与 v1 的兼容路径(渐进上线)

**分步落地**:每一步单独提交,各自保持全绿,各自可以发版。

1. **数据层(静默)**:加 `turn-log.ts` 和 pool 写日志,UI 不变。装机后日志开始积累,用户看不到变化。
2. **Host 方法**:`detail / turns / turn` 上线。v1 client 不调用这些方法,无影响。
3. **详情页签类型**:注册定义和正文,暂不加入口。可以在 devtools 里手动 `openResource` 冒烟。
4. **列表入口**:卡片加"查看详情"。到这一步用户才看得到 v2。

**兼容性**

- **注册表**:`version: 1` 和字段集都不变。降级到 v1 后,日志文件被忽略,注册表照常读写。[推断]
- **旧会话**:没有日志,详情页显示空历史和"更早的 N 轮未记录",不迁移。这与 v1 对旧注册表缺 `title`/`turnCount` 的处理一致(PANEL-DESIGN §3.3)。
- **列表 DTO**:`inFlight`、`agentMatches` 都是可选字段,client 缺省时按 v1 方式显示。
- **新旧半边版本错配**:如果升级后没重启,浏览器半是新的,host 是旧的(元数据按进程缓存,PANEL-DESIGN §3.6.2)。这时 `acpResume/detail` 会返回网关错误,详情页显示错误条,不影响列表。README 升级步骤 6(重启 App)已经覆盖这种情况。
- **残留页签**:插件关掉后,localStorage 里还留着详情页签记录。侧栏会对这些页签显示官方的"无法查看"提示(`contract/slots.ts:52-57`),重新启用插件后恢复。会话被 purge 后,残留页签的 `detail` 返回 `acp-resume/unknown-chat`,详情页显示"该会话已删除"和"关闭页签"按钮。
- **D 编号**:新增 D18;D15 就地追加"v2 修订"并注日期;D6 和 D17 不改。实施时如果发现必须改 D6 条款(按当前设计不需要),先停下来报告。

---

## 5. 待用户裁定

1. **形态**:方案 A(详情资源页签,推荐)/ B(加 provider)/ C(页签内切换)。
2. **轮次日志**:是否默认开启;是否需要 `recordTurns` 开关;保留上限 200 轮、单轮回答 32 KiB 是否合适。
3. **详情入口**:整张卡片可点,还是单独一个"详情"按钮,还是两者都要。
4. **展开状态**:v2 先用组件 state(切页签后合上),还是直接上按页签分桶的 store。
5. **在途流式文本**(进行中轮实时显示回答)要不要从 v3 提到 v2。要的话,池需要在内存里缓存在途输出,约多 0.5 天。

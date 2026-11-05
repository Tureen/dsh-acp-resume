# D15 持久会话面板(右侧栏)设计与交互

状态:v1 已实施上线;**v2「穿透式详情」已实施(D18,§2.6),待装机验收**。决策链:D3(内核续聊不适用外部)→ D14(评审)→ 用户需求(目录可见、会话级聚合)→ 方案比选(本文件 §1)。

## 1. 背景与方案比选

需求:持久会话在 GUI 有可见性——**按会话聚合**(一个会话一条,续聊不累加;新会话才新增)。

| 备选 | 结论 | 原因 |
|---|---|---|
| A. 轮即 activation(进官方子智能体目录) | 否 | 官方目录条目单位是 child,外部后端每次 `startExternal` 新建 child——同一会话十轮显示"10 个子智能体",语义误导(用户判定不可接受) |
| 偏门. provider 跨轮复用 run id 使目录合并 | 否 | 违反 `SubagentRun.id` 唯一性契约,官方升级随时失效 |
| 官方 child 复用通道(保留 childId / prepareContinuable) | 不可用 | 查证原文:`reserved child ids require a local backend`——child 复用硬绑本地后端,外部后端被排除(D3 同源边界) |
| **B. 自绘右侧栏面板(本设计)** | **采纳** | 语义完全正确;右侧栏是公开扩展面(官方 ui-subagent 侧栏聊天同位示例;第三方带 UI 先例:dat-lequoc/dsh-kiro 的 Settings→Kiro) |

官方依据:`sidebarRightTabs` 注册服务 + `sidebar.right.pane.tab` 槽位 + `dsh.client` 浏览器半声明(packages/client/AGENTS.md 新插件包 checklist)。

## 2. 交互设计

### 2.1 入口与形态

- 位置:**右侧栏新页签**,名"持久会话"(图标:对话气泡+链接);所有模式可见(与工具全局性一致)。
- 形态(v1):**右侧栏页签(向导入口形态,由用户在每个会话首次打开;2026-11-04 用户裁定)**(v1 不把**列表**做成资源页;v2 的**详情**页签正是资源型,见 §2.6)。

### 2.2 页签内容

**空态**(无任何会话):

> 暂无持久会话
> 让模型调用 `acp_chat_start` 创建;之后的每一轮对话都在这里可见。

**会话卡片列表**(每会话一张卡,按最后活跃倒序):

```
┌───────────────────────────────────────────┐
│ ● chat-a1b2c3d4            [释放] [删除]  │
│ 首轮摘要(最多 40 字,截断加省略号)…        │
│ ● 活跃 · 12 轮 · 3 分钟前                  │
│ cwd /tmp · 远端 4fb07582                   │
└───────────────────────────────────────────┘
┌───────────────────────────────────────────┐
│ ○ chat-e5f6a7b8            [释放] [删除]  │
│ …                                          │
│ ○ 已释放(下次发送自动重连)· 5 轮 · 1 小时前 │
└───────────────────────────────────────────┘
```

卡片字段:状态点(● 活跃=进程在 / ○ 已释放)、chatId(前 8 位)、首轮摘要、轮数、相对时间、cwd、远端会话号(前 8 位)。

**页签头部**:标题 + 手动刷新按钮。

### 2.3 操作与确认

| 操作 | 行为 | 确认 |
|---|---|---|
| 释放(Reload 图标) | `pool.close`:释放进程,记录保留 | 无需确认(无损,可重连) |
| 删除(垃圾桶) | `pool.remove`:释放进程**并删记录**,不可再连 | **二次确认弹窗**(引用 chatId,说明不可恢复) |
| 刷新 | 立即拉取 | — |

### 2.4 刷新策略

- 页签打开时拉取;打开期间轮询;任意操作完成后即时刷新;
- 不做事件推送(v1 从简;池状态变更频率低,轮询成本可忽略)。
- **轮询降本(D21,2026-11-05)**:快照引用稳定——内容未变的轮询复用上一次的快照对象,`useSyncExternalStore` 不触发重绘(修复每 5 秒一次的整树重绘脉冲);节奏自适应——默认 5 秒,连续 3 次无变化退到 30 秒,任何内容变化或面板操作恢复 5 秒;host 的 `turns` 读按文件 `mtime:size` 缓存已解析结果,文件没变不重读也不换引用。

### 2.5 明确不做(v1 边界)

- **面板内发消息**:不设输入框。发消息是模型工具(`acp_chat_send`)的领地,双入口会让状态与日志两套真相;面板是只读视图 + 资源操作。
- ~~轮次历史展开(每轮问答明细)~~:**v2 已做(§2.6)**——数据源是注册表旁的按轮日志,注册表不动。
- 仍不做(v2 之后):在途轮的实时文本、详情页签之间的跨页签导航栈、面板内发消息/取消。
- 取消在途轮:取消入口仍是 GUI 全局停止(经工具信号链路,D14)。

## 2.6 v2:穿透式详情页签(D18)

状态:已实施(2026-11-04);排版经上线反馈于 2026-11-05 重做(见本节末「排版规范」)。研究与方案比选见 [PANEL-DETAIL-RESEARCH.md](PANEL-DETAIL-RESEARCH.md);五项裁定:详情用资源地址页签且不注册 provider / 轮次自落日志 / 整卡点击打开 / 展开状态用组件内状态 / 在途实时文本留 v3。

### 入口与形态

- **整张卡片可点**:点卡片任意处,在列表所在窗格打开该会话的详情页签。释放、删除按钮阻止冒泡,不触发打开;标题处是一个真按钮(键盘与读屏的入口,`查看 chat-xxxx 详情`)。
- 详情页签的类型是**资源类型**:`kind: 'acp-resume.chat'`,`patterns: ['dsh-resource://acp-resume-chat/**']`,地址 `dsh-resource://acp-resume-chat/<chatId>`。同一会话再点 = 聚焦已开页签;不同会话各开各的,关一个不影响其他;刷新页面后布局里的地址自行恢复(官方不持久化导航参数,身份必须在地址里)。
- 不注册 resource provider、不加引导页入口、不声明 `multiple`:轮询跟着正文挂载走(页签隐藏即停),`inject` 不增加 `resources`。
- 返回:详情与列表页签并存,点列表页签的 chip 回到列表(官方侧栏惯例,无页内返回)。

### 详情页内容

- 头部(区一):状态点(`StateDot`:活跃=done / 已释放=idle)+ label(无则 `chat-` 前 8 位,有 label 时短号作副标题)为唯一主标题,右侧 刷新 / 释放 / 删除;删除成功后自动关闭本页签;释放对已释放会话置灰。
- 会话元信息(区二):两行次要文字——状态 · 轮数 · 相对时间;`cwd` · 远端会话号前 8 位;首轮摘要(title)单独一行。完整 chatId 在标题的悬停提示里。
- 轮次记录(区三,新到旧):每条一张卡片。卡顶一行把 `#序号`、结局、`新会话`、相对时间降为元信息,其中结局用 `Tag` 状态色徽章(已完成=success / 出错=danger / 超出长度·拒答=warning / 已取消=neutral,其余原样 neutral),`新会话`=info 徽章。卡身是问与答两块,各带 `问 / 答` 小标签,折叠态显示**首个非空行**预览(至多 100 字,单行省略号);有更多内容时显示「还有内容,展开查看」提示。右上角一个明确的 chevron 展开控件(`▾/▴`,带 `aria-expanded` 与「展开/收起第 N 条」无障碍名),展开后 message 与 output 各进一个保留换行、可滚动(max-height 320)的等宽区域;预览被截断时才向 host 取全文并缓存。出错轮的诊断默认折叠在「查看诊断」开关后。展开状态只在组件内,页签切走再切回会合上。
- 重连事件(区三内,与轮次视觉区分):不进轮次卡片样式,改用左侧告警色竖条(`border-left`)+ `连接` 徽章,无展开控件、无问答结构。`远端会话已丢失,已新开会话`(session/load 被协议拒)、`重连失败:<原因>` + 未能发送的那条消息。
- 记录只显示最近 50 条;超出时显示 `显示最近 N / 共 M 条` 与「加载更早的记录」(每次 +50,上限 200)。日志本身只留最近 200 条。
- 空日志占位:`暂无轮次记录(此前的轮次没有被记录)`——旧会话与升级前的轮次不迁移。
- 会话已被删除(host 答 `acp-resume/unknown-chat`):显示「该会话已删除」与「关闭页签」,停止轮询。

### 数据与通道

- 日志 `turns/<chatId>.jsonl` 与注册表同父目录;每行一条:轮(message / output / stopReason / startedAt / at / freshSession / diagnostic)或重连事件。steer 不是轮,不记。写失败只经 `onWarn` 告警,不影响轮结果;purge 连文件一起删。细则见 D18。
- host 新增两个 Remote 方法(与 `list/close/purge` 同款,source 模式):`acpResume/turns {chatId, limit?}` 返回会话行 + 最近 `limit` 条预览 + 日志总数;`acpResume/turn {chatId, seq}` 返回单条全文。未知会话 `acp-resume/unknown-chat`;未知条目 `acp-resume/unknown-turn`;参数非法 `gateway/bad-request`。
- client:`ChatDetailSource` 每个 chatId 一个,正文与 chip 标题共用,有订阅者才每 5 秒轮询。

### 排版规范(2026-11-05 重做,对号上线反馈)

反馈原话:「内容过于紧凑、没有排版、没有主次重点、内容显示不够精炼、想看完整内容也没有展开能力」。真机截图确认展开**功能是好的**,问题只在排版——不可发现 + 无层级。三条决定:

1. **分区与呼吸感**:页面分头部 / 元信息条 / 轮次主体三区,根 `gap:16`、`padding:16`,轮次卡片间 `gap:10`、卡内 `padding:12`;底色用 `--dsw-alias-bg-layer-1`(页面)/ `layer-2`(卡片)/ `layer-1`(卡内全文区)分层,不写死颜色。替代旧版 `gap:6-8` 全程贴死、无分区。
2. **主次层级**:主标题 16px/600;问答正文 13px,问为主色(`label-primary`)、答为次色(`label-secondary`);`#序号`、时间、cwd、远端号一律降到 11-12px `label-tertiary`;结局与状态用 `Tag`/`StateDot` 徽章承载语义色,不再把「#3 · 已取消 · 新会话 · 9 分钟前」串成一行同权重文字。重连事件用左竖条 + `连接` 徽章与轮次卡片明确区分。
3. **精炼 + 可发现的展开**:preview 从「前 120 字」改为「首个非空行(至多 100 字)」,答同理。展开入口放在阅读动线末尾(2026-11-05 反馈「右上角小控件看不出能点」后再调):展开 affordance 只有两个:卡片底部一条整行主按钮「展开查看全文 · 共 N 行」(点击展开、同位置原地变「收起」),以及可点的轮次头部整行(`role=button`、`aria-expanded`、键盘可达,以 pointer 光标 + hover 底色为暗示)。不设右上角角标 chevron(2026-11-05 反馈:两个展开信号并存反而困惑,已彻底移除)。无更多内容的轮次不显示底部按钮。展开后问答各进可滚动、保留换行的全文区;诊断默认折叠在独立开关后。

仅用 `--dsw-alias-*` 变量与 ui-primitives 现有组件(`Button`/`Modal`/`Tag`/`StateDot`,均在 `0.2.1-rc.5` 导出);不引入新依赖、不写死颜色。host 的 preview 仍是前 120 字,client 侧再取首行,`src/panel.ts` 未动。

### 会话归属与过滤(D20,2026-11-05)

面板/list 展示的是 profile 级全局注册表,同机所有 DSH 会话看同一份。为可溯源,`acp_chat_start` 把创建它的 DSH 会话记为 `ownerSessionId`(取 `exec.agent?.id`,与 D17 job owner 同源),随注册表与 `PooledChatInfo`/`PanelChat` 流到面板。这是**元数据,不是访问控制**:池、五个工具、host Remote 方法照旧服务每一条 chat,跨会话续聊不变(D20)。

- **列表头部过滤**:切换「全部 / 本会话」,**默认「全部」**(新会话打开面板时「本会话」必为空,默认到它会让用户误以为记录消失)。无会话在屏时不提供该切换。计数随视角:全部「共 N 条」、本会话「本会话 M 条 / 共 N 条」;本会话为空时显示该计数而非"暂无持久会话"空态。
- **卡片来源标注**:本会话不标(常态);其他会话标「其他会话」;旧记录(无 owner)标「来源未知」。无会话在屏时有主 chat 一律显示为「其他会话」(无"我"可比对)。
- **不做服务端过滤**:过滤是纯视图,client 自带会话身份;host 不按 owner 拦截,保持"全局可见、可溯源"。旧注册表无 owner = 来源未知,读入不告警、不迁移。

### v3 留白

在途轮实时文本;思考/工具调用/计划(connection 目前丢弃);与 job 互链(jobId);搜索/导出;详情之间的导航栈。

## 3. 技术设计

### 3.1 双面结构

```
dsh-acp-resume
├─ node 半(现有插件扩展)
│   ├─ 现有:池 + 四工具 + one-shot provider
│   ├─ sidebarRightTabs 注册(经 ctx.inject 响应式注册,同 D13 修订后模式(D16 第 9 条);服务晚到/重载均正确,缺服务的上下文跳过)
│   └─ 面板数据 remote:list / close / remove(参照 dat-lequoc 的 settings-remote 模式)
└─ client 半(新增,./client 导出)
    └─ 页签组件:slots 注入 sidebar.right.pane.tab;挂载时拉取 + 轮询;操作回写后刷新
```

### 3.2 数据通道

host → client 经 remote 三个方法(只读为主):
`list(): PooledChatInfo[]`(含摘要/轮数)、`close(chatId): void`、`remove(chatId): void`。
client 不直接读注册表文件;单一事实源在池。

### 3.3 注册表增强(v1 兼容,可选字段)

`title`(首轮摘要:该 chat 第一条 **completed** 轮的消息文本,截断 40 字)、`turnCount`(仅 **completed** 轮结算后递增;aborted/error 轮不计)。两字段均为可选、version 不动。
旧注册表无这两个字段 → 面板显示占位("—"),不迁移。增强作为独立前置改动先行落地(带回归),面板实施不再触碰 pool.ts。

### 3.4 包与构建

- package.json:`exports` 增 `./client`;`dsh.client` manifest(platform web);`files` 增 `lib/client.js`;
- 构建:tsdown `clientBundle`(照 packages/client 模板);
- 装机通道不变(bundle 层已挂载,浏览器半随 `dsh.client` 声明被发现)。

### 3.5 交互文案(中文,与产品一致)

空态/状态/按钮文案以 §2.2 为准;确认弹窗:"删除 chat-a1b2c3d4?将释放进程并删除本地记录,之后无法重连该会话。[取消] [删除]"。

## 4. 文件计划与验收

| 文件 | 动作 |
|---|---|
| `src/panel.ts`(node 半) | sidebarRightTabs 注册 + remote 三方法 |
| `src/client.tsx`(client 半) | 页签与卡片组件 |
| `package.json` / 构建 | client 导出与 dsh.client manifest |
| `tests/panel.spec.ts` | remote 方法对池的映射(含确认语义:remove 后 list 无该条) |
| `tests/client.spec.tsx` | 组件渲染(空态/卡片/确认弹窗,jsdom) |

v2(D18)新增:

| 文件 | 动作 |
|---|---|
| `src/turn-log.ts` | 新:按轮日志(追加、读、截断、裁剪、删除,写失败只告警) |
| `src/pool.ts` | 轮结算与重连事件写日志;`remove` 删日志;`chatInfo` / `turnEntries` |
| `src/panel.ts` | 新增 `turns` / `turn` 两个 Remote 方法 |
| `src/client/chat-address.ts` `detail-source.ts` `ChatDetail.tsx` | 新:地址、每会话数据源、详情正文与 chip 标题 |
| `src/client/ChatsPanel.tsx` `index.ts` `face.ts` `locales.ts` | 整卡点击;注册详情页签类型与两个槽位;类型与中英文案 |
| `tests/turn-log.spec.ts` | 新 |
| `tests/pool.spec.ts` `panel.spec.ts` `steer.spec.ts` `client.spec.tsx` | 日志读写与事件、两个新方法、steer 不入日志、详情渲染与接线 |

v2 验收(装机后 GUI,待做):
1. 点任一卡片打开详情页签;再点同一张卡只聚焦;点另一张开第二个页签;关一个不影响另一个;
2. 模型对会话 send 之后,详情里出现新的一轮(问/答预览、结局、相对时间),点开是全文;
3. session/load 失败的场景出现重连事件;
4. 释放、删除在详情页里与列表一致,删除后页签自动关闭;
5. 刷新页面后详情页签还在并能恢复;
6. 点卡片上的释放/删除不会打开详情。

验收:装机后 GUI——
1. 右侧栏出现"持久会话"页签;空态正确;
2. 模型 `acp_chat_start` 后卡片出现(摘要/轮数随 send 增长;**续聊轮次不新增卡片**);
3. 释放/删除操作与 `acp_chat_list` 结果一致;
4. 插件关闭(GUID 插件页开关)后页签消失。

## 3.6 技术补强(spike 定稿)

2026-11-04 spike。依据全部取自官方只读 checkout `/Users/Tulane/Developer/open-source-projects/deepseek-harness`(分支 `my-subagent-acp` @ `dsh-v0.2.1-rc.5`),下文 `file:line` 均相对该仓库根;另引第三方先例 `dat-lequoc/dsh-kiro`(commit `c9a397f`,标注 `dsh-kiro:`)。每条结论标明 **[实测]**(在 `/tmp` 下跑过探针,不在本仓库)、**[读码]**(读源码得出)或 **[未验证]**(待装机确认)。

### 3.6.0 对 §3.1–§3.5 的修正(以本节为准)

- **`sidebarRightTabs` 是浏览器端服务,不在 node 半。** 官方页签插件都在 client 半 inject 它并注册(`packages/client/ui-sidebar-terminal/src/client/index.ts:23,71-74`;服务声明见 `packages/client/ui-sidebar-right/src/client/index.ts:92`)。node 半只负责暴露 list/close/purge 三个远程方法。[读码]
- **远程方法名 `remove` 改为 `purge`。** 若走 `ctx.remote` 通道,`remove` 与客户端命名空间服务自带的 `remove()` 方法冲突,挂载直接报错(`packages/api/gateway/src/client/index.ts:642-645,707`)。[实测] 即使本设计推荐的通道 B 不受此限,也统一用 `purge`,与 `acp_chat_close` 的 `purge` 参数同名,并给日后切换到通道 A 留余地。池内方法仍是 `pool.remove()`,只改线上名。
- **dat-lequoc/dsh-kiro 不是 remote 先例。** 它的设置页走 `webServer.register({ kind: 'prefix', path: '/kiro/api' })` 裸 HTTP 路由加浏览器 `fetch`(`dsh-kiro: src/web.ts:518-524`、`client/index.cjs:323-330`)。该路由不经过 `/api` 的浏览器信任围栏(`packages/host/webserver/src/index.ts:366-373` 注册时无任何鉴权;对照 `/api` 围栏 `packages/client/connection/src/api-request-trust.ts:1-13`)。本设计不照抄,只借它的打包形态作参考。[读码]
- **"常驻单页签"没有直接机制。** `SidebarRightTabDefinition` 没有"自动打开"字段,页签类型的入口是向导页的 `guide` 条目,由用户按会话打开(`packages/client/ui-sidebar-right/src/client/tab-registry.ts:94-136`)。v1 落地为:注册一个页面型页签(不带 `patterns`,不设 `multiple`,每个窗格一页)+ 一个向导条目。§2.1 的"常驻"语义需用户确认是否接受。[读码]
- **官方 `clientBundle` 预设不能直接引用。** 它导入了 monorepo 内部脚本(`packages/client/tsdown.client.ts:21-25`),独立仓库需自写等效配置(见 3.6.3)。[读码]

### 3.6.1 未知一:host→client 方法通道

**结论:GO。** 第三方 host 插件让一个 Cordis Service 继承 `TypertRemoteService` 并给方法加 `@Remote`,官方 Gateway 的源码回退(SRC 模式)就会认领 `<namespace>/<method>` 端点,不需要 Typert 生成器,也不需要改官方的集中装配。浏览器侧有两条调用路,推荐 B。

**Host 侧依据**

- 官方注册姿势(`remote.workspaceFiles` 的 host 侧):`class WorkspaceFiles extends TypertRemoteService`,构造时 `super(ctx, 'workspaceFiles')`,方法加 `@Remote`(`packages/api/workspace-files/src/index.ts:183,200,233`)。`TypertRemoteService` 在构造时把 service key 绑定为 wire namespace(`packages/typert/protocol/src/index.ts:246-260`)。[读码]
- 官方生成产物(`./typert`、`./remote`)只在严格模式下需要。没有产物时,Gateway 扫描所有带 `typertRemote` 绑定和 `@Remote` 标记的活 Service 认领端点(`packages/api/gateway/src/index.ts:363-368` claimsEndpoint、`384-399` collectSrcClaims),从方法源码读参数名生成描述(`861-872` resolveDescriptor、`874-899` resolveSrcDescriptor、`1569-1600` methodParameterNames)。loader 文档也写明"受限的无描述符源码回退仍由 Gateway 负责"(`packages/typert/loader/README.zh.md:49`)。[读码]
- 有新 Service 注册时认领缓存会清空(`packages/api/gateway/src/index.ts:239`),插件晚于 Gateway 激活也能被认领。[读码+实测]
- 线路:Gateway 拦截 Connection 的 `/api` 通道(`packages/api/gateway/src/index.ts:243`),载荷必须恰好是 `{ args: {...} }`(`1258-1264`)。[实测]
- 访问控制:owner Peer(本机 GUI 用户)直接放行;非 owner 走 `remoteAccess.decide`(`packages/api/gateway/src/index.ts:787-808`),未登记的动作默认拒绝(`packages/api/remote-access/src/index.ts:46` 的 `no-allow`)。[实测]
- 参数名坑:SRC 模式按参数名匹配 lookup,已注册的名字有 `agent`、`session`、`workspaceFileScope`(`packages/core/agent/src/index.ts:259`、`packages/core/session/src/index.ts:1080`、`packages/api/workspace-files/src/index.ts:204`)。参数名避开它们,用 `chatId`。[读码]
- 缺参不报错:SRC 参数允许 `undefined`(`packages/api/gateway/src/index.ts:1626-1631`),`close({})` 会以 `chatId === undefined` 进入方法体。业务方法必须自己校验。多传字段会报 `gateway/arguments-invalid`。[实测]

**浏览器侧两条路**

- **B(推荐):直接 `ctx.connection.rpc.call('/api', 'acpResume/<m>', { args })`。** `connection` 是浏览器端公开 Cordis 服务(`packages/client/connection/src/client/index.ts:143-157,330`),`rpc.call` 的签名见 `packages/client/connection/src/rpc.ts:295-310`。浏览器传输与桌面端自定义传输都经这一个接口(`client/index.ts:227` 的 `transport?.rpc ?? createWebConnectionRpc(...)`),因此不像 dsh-kiro 那样依赖页面能直连 HTTP。返回 `{ ok, value } | { ok: false, error }`;传输层失败时直接 throw(`packages/client/connection/src/client/rpc.ts:58-60`)。代价:官方业务包无人直接调用 `rpc.call`(只有 gateway 自身,`packages/api/gateway/src/client/index.ts:458`),属于越过 `ctx.remote` 的基础设施边;但只依赖两个公开约定:`rpc.call` 和 `{ args }` 信封。
- **A(备选):`ctx.remote.$mount(手写 contribution)`。** 官方 contribution 由 `@deepseek-ai/dsh-api-remotes/client` 集中挂载(`packages/api/remotes/src/client/index.ts:185-198`),但 `$mount` 本身是公开方法(`packages/api/gateway/src/client/index.ts:214-222`)。客户端要求每个参数都带 `mode: 'strict'` 的 codec(`803-818`),`src-json` 会被拒;手写一个带 `typeSymbol` 和 `create` 的 strict codec 能通过挂载,挂载和调用时 `create` 都不会被调用。[实测] 换来的是 `RemoteResult` 统一错误与卸载时自动取消在途调用;风险是伪造的 strict 元数据可能在官方升级后被实际执行,且方法名受命名空间保留字限制(`remove`、`has`、`ctx`、`name` 等,`763` 与 `664-707`)。

**实测记录**(`/tmp/spike-probe`,用本仓库的 tsc 5.9 编译,`target ES2023`,标准 TC39 装饰器,未开 `experimentalDecorators`;加载官方 checkout 已构建的 `vendor/cordis`、`typert/registry`、`api/remote-access`、`api/gateway` 的 lib):
- `typertGateway.invoke` 调 `acpResume/list|close|remove` 均返回预期值;非 owner 得到 `remote-access/denied (no-allow)`;多余字段得到 `gateway/arguments-invalid`。
- 模拟 Connection 拦截:Service 注册前 `claims('acpResume/list') = false`,注册后为 `true`;`dispatch('acpResume/list', { args: {} })` 得到 `{"ok":true,"value":[...]}`;方法体内 throw 的 `TypeError` 得到 `{"ok":false,"error":{"code":"gateway/internal",...}}`;方法返回 `undefined` 时线上为 `{"ok":true}`(没有 value 键)。
- 浏览器 Gateway(`lib/client.node.js`)用手写 contribution 挂载:`remove` 被拒(namespace 冲突),`src-json` 参数被拒,strict 桩通过;线上实际发出 `["/api","acpResume/purge",{"args":{"chatId":"chat-a"}}]`,与通道 B 的报文一字不差。

**最小代码形状**

node 半(`src/panel.ts`):

```ts
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AcpSessionPool, PooledChatInfo } from './pool.js'

/** wire namespace = Cordis service key;端点为 acpResume/list|close|purge */
export class AcpResumePanelService extends TypertRemoteService {
  constructor(ctx: Context, private readonly pool: AcpSessionPool) {
    super(ctx, 'acpResume')
  }

  @Remote
  list(): readonly PooledChatInfo[] {
    return this.pool.listChats()
  }

  @Remote
  async close(chatId: string): Promise<null> {
    await this.pool.close(requireChatId(chatId))
    return null
  }

  @Remote
  async purge(chatId: string): Promise<null> {
    await this.pool.remove(requireChatId(chatId))
    return null
  }
}

function requireChatId(value: unknown): string {
  // SRC 模式缺参时传 undefined(gateway/src/index.ts:1626-1631),必须在这里校验
  if (typeof value !== 'string' || value === '') {
    throw new RemoteError('gateway/bad-request', 'chatId must be a non-empty string', {})
  }
  return value
}
```

- 参数必须是简单标识符,不能解构、不能有默认值、不能用 rest,否则 `gateway/signature-invalid`(`packages/api/gateway/src/index.ts:1592-1611`)。tsc 编译后方法源码保留 `close(chatId) {`,已实测。
- 接线(`src/index.ts`):池只在 tools 作用域里创建,面板服务跟它同处:在现有 `ctx.inject(['tools'], scope => { pool ??= ...; registerChatTools(...) })` 回调里追加 `new AcpResumePanelService(scope, pool)`,服务随 tools 作用域撤销。在 inject 回调内直接 `new` Service 的生命周期行为 [未验证],实施时以 `tests/panel.spec.ts` 覆盖;不行就改为 `scope.plugin({ name: 'acp-resume-panel', apply: c => { new AcpResumePanelService(c, pool) } })`(插件内构造已实测)。
- receiver 是 `extend({ invocation })` 派生出的对象(`packages/api/gateway/src/index.ts:841`),`this.pool` 经原型链可读。[读码,探针用的是闭包,未直接测 `this.pool`]
- package.json:`@deepseek-ai/dsh-typert-protocol` 加进 `peerDependencies` 与 `devDependencies`,版本 `~0.2.1-rc.5`(npm `next` 标签已发布,自身 peer cordis,`packages/typert/protocol/package.json:40-48`)。理由:现有 peer(cordis、dsh-subagent 等)不在 profile 的 `node_modules`,运行时由 App 的 profile 解析拦截提供(`packages/boot/app-boot/src/profile-resolution/resolver.ts:1`;0.1.3 装机已跑通,D16)。typert-protocol 是否同样由 App 提供 [未验证];若装机时报找不到,改放 `dependencies`(标记靠稳定字符串属性跨副本可读,`packages/typert/protocol/src/index.ts:220`、架构 note `2026-08-02-typert-remote-method-calls.zh.md:92`)。

client 半调用(通道 B):

```ts
type RpcResult = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string } }
interface PanelConnection { rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult> } }

async function callPanel<T>(connection: PanelConnection, method: 'list' | 'close' | 'purge',
  args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const result = await connection.rpc.call('/api', `acpResume/${method}`, { args }, signal) // 传输失败会 throw
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value as T
}
```

### 3.6.2 未知二:`dsh.client` manifest 与 externals

**结论:GO。** manifest 只有四个字段,我们只需 `platform`(可加 informational 的 `inject`),不需要 `external`。

- **字段全集**:`platform`(必填字符串)、`inject?`、`external?`(字符串数组)、`immediately?`(布尔)(校验 `packages/client/modules/src/client/manifest.ts:173-193`;类型 `packages/util/package-manifest/src/types.ts:81-94`)。[读码]
- **发现规则**:host 从 Loader 已挂载的行找到包的 `package.json`,`platform !== 'web'` 就不算 client 行;声明了却没有 `exports["./client"]` 时,启动即抛错(`packages/client/modules/src/index.ts:844-879`,第 868 行)。`./client` 必须是字符串,或带字符串 `default` 的对象(`196-206`);文件缺失时抛 `MissingClientBundleError`(`979-991`)。client 行挂在 host 行上,所以现有 bundle 装机通道不变,插件关闭后 client 行随之消失(满足 §4 验收 4,[读码推断])。包元数据按进程永久缓存(`844-856`),升级后必须重启 App(README 升级步骤 6 已有)。
- **`inject`**:只作提示信息,不决定激活顺序(`packages/client/AGENTS.md:148`);图里不存在的包名会被静默跳过(`packages/client/modules/src/client/system.ts:273-276`)。
- **externals 白名单**:每个动态 bundle 隐式共享这些基线模块:`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`(`packages/client/web/src/platform.ts:8-15`)。React 和 ui-primitives 能直接 import,不要写进 `external`(`packages/client/AGENTS.md:82`)。`external` 只留给基础设施(`:83`),功能插件不得借它拿别的插件的值(`:40`),基线以外的第三方库各自打包私有副本(`:84`)。
- **`./client` 导出形状**:只导出 `apply`、`inject`(有配置时加 `Config`)(`packages/client/AGENTS.md:38`)。官方产物末尾即 `exports.apply = apply; exports.inject = inject;`(`packages/client/ui-deliverables/lib/client.js` 尾部)。
- 跨包协作一律走 Cordis 服务(`connection`、`slots`、`sidebarRightTabs`)。官方包的类型只用 `import type`,构建时被擦除,不产生模块请求(`packages/util/package-manifest/src/types.ts:91`)。

package.json 片段:

```jsonc
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["cordis.patch.yml", "lib/*.js", "lib/client.js.map", "lib/types/**/*.d.ts"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] }
  }
}
```

client 半最小导出(`src/client/index.tsx`,注册写法照 `ui-sidebar-terminal/src/client/index.ts:71-74,94-98`):

```tsx
const PANEL_ID = 'dsh-acp-resume'          // 页签实现 id = slot key
const PANEL_KIND = 'acp-resume.chats'
export const inject = ['slots', 'sidebarRightTabs', 'connection']
export function apply(ctx: PanelContext): void {   // PanelContext:本地结构化类型
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PANEL_ID, kind: PANEL_KIND, title: () => '持久会话',
    guide: [{ id: 'open', order: 90, title: () => '持久会话' }],
  }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: PANEL_ID,
      inject: () => ({ list: s => callPanel(ctx.connection, 'list', {}, s),
                       close: id => callPanel(ctx.connection, 'close', { chatId: id }),
                       purge: id => callPanel(ctx.connection, 'purge', { chatId: id }) }) },
    ChatsPanel)))
}
```

- `sidebar.right.pane.tab` 是按 key 分发、按会话作用域的 slot(`packages/client/ui-sidebar-right/src/client/contract/slots.ts:59-64`),inject 回调收到 `sessionId`。面板数据是全局的,忽略该参数即可。
- 类型:v1 在本仓库写局部结构类型(`PanelContext`、`PanelConnection`),不依赖官方 client 包的 `.d.ts`。官方 client 包在 npm 有 `0.2.1-rc.5`(`next` 标签),但它们的类型依赖链能否在独立仓库完整解析 [未验证]。

### 3.6.3 未知三:构建模板

**结论:GO。** 官方产物是单个 CJS 工厂脚本 `lib/client.js`(外加 `.map`),由 tsdown 产出。独立仓库用下面的自写配置能产出同构文件。[实测]

- **官方配置**:`ui-deliverables` 只调用 `clientBundle(import.meta.dirname, ['lib/types/index.js'])`(`packages/client/ui-deliverables/tsdown.config.ts:1-3`)。`ui-sidebar-documentpreview` 在同一预设上加了 PDF/Excel worker 插件(`packages/client/ui-sidebar-documentpreview/tsdown.config.ts`)。预设核心是 `clientConfig`(`packages/client/tsdown.client.ts:499-672`):`format: 'cjs'`、`platform: 'browser'`(`515-516`);基线模块 `neverBundle`,其余全部 `alwaysBundle`(`523-531`);`@deepseek-ai/*` 纯度门(`567-578`);`banner`/`intro`/`footer` 包成 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`(`663-669`);入口文件名 `client.js`(`650`)。tsdown 版本 `0.22.2`(根 `package.json:281`,本机 node_modules 同版本)。JSX 用 `react-jsx`(`tsconfig.base.client.json:7`)。
- **产物形态**:`packages/client/ui-deliverables/lib/client.js` 以 `window.__ModuleLoader__.load({ id, factory: (require) => { var module = { exports: {} }; ...` 开头,外部依赖写成 `require("react/jsx-runtime")` 这类调用,结尾 `return module.exports; } });`。宿主按 `id` 注册工厂(`packages/client/modules/src/client/manifest.ts:355-368`)。
- **实测**:在 `/tmp/spike-build` 用官方 checkout 的 tsdown 0.22.2 和下面的配置,构建一个含 JSX 与 `useState` 的 `src/client.tsx`,产物 1.53 kB,结构与官方产物一致:CJS 工厂包装,`require("react")`、`require("react/jsx-runtime")`,末尾 `exports.apply/inject`。
- 打包器在构建时不解析 externals,react 只为类型检查和测试需要安装。

`tsdown.config.ts`(独立仓库版):

```ts
// 镜像官方 PLATFORM_MODULES(packages/client/web/src/platform.ts:8-15);升级 DSH 时核对
const SHARED = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'])
const ID = 'dsh-acp-resume' // 必须等于 package.json name(宿主按包名注册工厂)
export default {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2024',
  dts: false, sourcemap: true, clean: false,           // clean:false,不能删掉 tsc 产出的 node 半
  deps: { neverBundle: (s: string) => SHARED.has(s), alwaysBundle: (s: string) => !SHARED.has(s) },
  define: { 'process.env.NODE_ENV': '"production"' },
  outputOptions: {
    entryFileNames: 'client.js', chunkFileNames: 'client.[name].js',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    banner: (chunk: { isEntry: boolean; fileName: string }) =>
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
  },
}
```

配套改动:

- devDependencies:`tsdown@^0.22.2`、`react@^18.2.0`、`@types/react`;client 测试另加 `jsdom`、`@testing-library/react`(官方用 `^16.3.3`,`packages/client/ui-sidebar-terminal/package.json` devDependencies)。
- 脚本:`"build": "tsc -p tsconfig.json && tsdown"`。`prepack` 必须同步改为 `rm -rf lib && tsc -p tsconfig.json && tsdown`:现有 `prepack` 先清空 `lib/` 再只跑 tsc,会把 `client.js` 删掉,打出缺浏览器半的包,宿主启动时报 `MissingClientBundleError`。
- tsconfig 拆分:node 半的 `tsconfig.json` 当前 `include: ["src/**/*.ts"]`,要 `exclude: ["src/client/**"]`(client 需要 DOM lib,node 半用的是 `types: ["node"]`)。新增 `tsconfig.client.json`(`jsx: "react-jsx"`、`lib: ["ES2024","DOM"]`、`noEmit`、`include: ["src/client/**"]`),只用于类型检查。tsdown 是否会读到根 `tsconfig.json` 的设置并改变 JSX 处理 [未验证]:探针目录里没有 tsconfig。首次构建时检查 `lib/client.js` 里是 `require("react/jsx-runtime")`,而不是裸的 `React.createElement`。
- 不要用动态 `import()` 拆 chunk。若要拆,`require.async` 改写需要官方的 `asyncChunkRequirePlugin`(`packages/client/tsdown.client.ts:446-479`),否则会留下宿主不支持的同步 `require("./client.x.js")`(`packages/client/AGENTS.md:87`)。v1 保持单文件。
- 不能用 CSS Modules:官方用 lightningcss 插件内联(`packages/client/tsdown.client.ts:580-603`),自写配置没有这一步。v1 用组件内 `<style>` 或行内样式,颜色取 `--dsw-*` 变量。

### 3.6.4 go/no-go

| 未知 | 判定 | 依据强度 | 装机时必须确认的残余点 |
|---|---|---|---|
| 1. 方法通道 | **GO**(host:TypertRemoteService + `@Remote`,SRC 认领;client:通道 B) | host 认领、`{args}` 信封、owner/非 owner、浏览器侧报文:均已实测 | ① App 运行时能解析 peer `@deepseek-ai/dsh-typert-protocol`;② 桌面端 client 存在 `ctx.connection.rpc`;③ 真 App 里完整往返一次 `acpResume/list` |
| 2. manifest / externals | **GO**(`platform: 'web'` + `./client` 字符串导出;无需 `external`) | 读码(校验函数、发现规则、白名单常量) | 升级后重启 App,client 行才出现(元数据缓存) |
| 3. 构建 | **GO**(自写 tsdown 0.22.2 配置,单个 CJS 工厂 `lib/client.js`) | 实测产物与官方同构 | 本仓库 tsconfig 下 JSX 编译结果;`prepack` 带上 tsdown |

替代路径(仅在残余点失败时启用):

- 残余点 ①(peer 解析不到):把 `@deepseek-ai/dsh-typert-protocol` 移进 `dependencies`。标记跨副本可读(`packages/typert/protocol/src/index.ts:220`);但它的 `Service` 基类来自它解析到的 cordis,所以要确认 pnpm 把 peer cordis 链到与宿主同一份。
- 残余点 ②(client 没有 `connection` 服务):改用通道 A(`ctx.remote.$mount` + 手写 strict 桩,已实测可挂载),inject 改为 `['remote', ...]`。
- 通道 A、B 都不通时的兜底:照 dsh-kiro 注册 `webServer` 裸路由加 `fetch`。该路由没有 `/api` 信任围栏,必须自己校验 `Host`/`Origin` 只放行本机来源,并且 `purge` 只接受 POST;只在桌面端页面能直连 HTTP 时有效。
- 构建兜底:照 `dsh-kiro: client/index.cjs:1-5,1142-1185` 手写 CJS 工厂(用 `React.createElement`,不经打包器)。可用,但失去 TSX 和类型检查。

# D15 持久会话面板(右侧栏)设计与交互

状态:已定稿,待实施。决策链:D3(内核续聊不适用外部)→ D14(评审)→ 用户需求(目录可见、会话级聚合)→ 方案比选(本文件 §1)。

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
- 形态:**常驻单页签**(不做每会话一个资源页;资源型有官方样例但对本需求过重)。

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

- 页签打开时拉取;打开期间每 5 秒轮询;任意操作完成后即时刷新;
- 不做事件推送(v1 从简;池状态变更频率低,轮询成本可忽略)。

### 2.5 明确不做(v1 边界)

- **面板内发消息**:不设输入框。发消息是模型工具(`acp_chat_send`)的领地,双入口会让状态与日志两套真相;面板是只读视图 + 资源操作。
- 轮次历史展开(每轮问答明细):留 v2(数据源需按轮落注册表,当前注册表只存计数与摘要)。
- 取消在途轮:取消入口仍是 GUI 全局停止(经工具信号链路,D14)。

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

验收:装机后 GUI——
1. 右侧栏出现"持久会话"页签;空态正确;
2. 模型 `acp_chat_start` 后卡片出现(摘要/轮数随 send 增长;**续聊轮次不新增卡片**);
3. 释放/删除操作与 `acp_chat_list` 结果一致;
4. 插件关闭(GUID 插件页开关)后页签消失。

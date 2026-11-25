# 实施计划(IMPLEMENTATION-PLAN)

六步严格按序执行;每步有独立验收,不过验收不进下一步。状态:☐ 未开始 / ◐ 进行中 / ☑ 完成。

## 前置就绪清单(2026-11-04 已达成)

- ☑ 独立仓库与骨架(首建基线 0.2.1-rc.5,构建绿,42 协议面用例绿,首提交 a606019;当前 D2 基线见 `dsh-v0.2.2-rc.3` / master pin `ff6db9df9f37db545e8b124b9043269f17256a34`)
- ☑ 设计与决策文档(DESIGN.md / DECISIONS.md / README.md,提交 7dce3e9 起)
- ☑ 实施依赖补齐(@deepseek-ai/dsh-tools、@deepseek-ai/dsh-home-paths,dev + peer)
- ☑ 参考源码 checkout(官方仓库 master pin `ff6db9df9f37db545e8b124b9043269f17256a34`，0.2.2-rc.3 状态,只读;D8 的 24 个真实子进程用例在该基线运行)

## 步骤

| # | 步骤 | 产出 | 验收 | 状态 |
|---|---|---|---|---|
| 1 | 连接原语抽取 | `src/connection.ts`:`openAcpConnection(openNew/openLoad)` + `prompt`(轮粒度输出/取消/安全诊断)+ `dispose` | connection.spec 六用例绿(含跨进程 load 重连记忆) | ☑ 7b61bf9 |
| 2 | ~~run.ts 重构为薄包装~~ **已评估并撤销(D11)** | run.ts 保持官方原版;connection.ts 为池专用姊妹实现 | 撤销后回归面 48 绿恢复(重构曾致 5 例退化) | ☑ 评估闭环 |
| 3 | mock 扩展 load | 会话表(内存+文件持久)、load 分支、MOCK_REMEMBER / MOCK_SESSION_STORE / MOCK_LOAD_MISSING | 跨进程重连用例绿(随第 1 步交付) | ☑ 7b61bf9 |
| 4 | 会话池 | `src/pool.ts`:start/send/close、空闲计时(可配窗口)、注册表原子落盘、load 重连与降级、连续 3 条 `error` 后下次 send 主动新开会话(计数仅内存) | `tests/pool.spec.ts` 60 例绿(含同进程两轮/释放后重连记忆/协议降级/连续失败恢复/空闲释放重连/busy 拒绝/跨池实例恢复) | ☑ |
| 5 | 工具与接线 | `src/tools.ts` 四工具(acp_chat_start/send/list/close)+ `index.ts`(name→acp-resume、Config 四新字段、池构造与 effect 清理) | 全量 54 绿/25 豁免;工具注册经 ctx.get('tools') 条件化,无 tools 服务上下文零扰动 | ☑ 4157a6e |
| 6 | 真机与装机验收 | 真 kiro-cli 冒烟剧本 + pack 安装 desktop profile | GUI 中模型经四工具完成:建会话→两轮→杀进程→重连记得上文→空闲释放→再连 | ☐(0.1.2 已装机待走剧本) |
| 7 | 持久会话面板(D15) | 双面包:node 半 sidebarRightTabs+remote、client 半页签组件;注册表增 title/turnCount | PANEL-DESIGN.md §4 验收清单全过(含"续聊不新增卡片") | ☐ |
| 8 | 禁止 acp-chat 阻塞等待(D22) | `src/job-wait-gate.ts`(`tools/pre-execute` 拒绝运行中 acp-chat 的 `job_output wait:true`)+ `allowChatJobWait` 开关 + `tests/job-wait-gate.spec.ts` | 新套件 13 例全绿 + 全量回归 308 绿 | ☑ ae52f90 |
| 9 | `permission: ask` + 启动指引(D23) | `permission: ask` 将 ACP 权限请求转给宿主用户确认，ENOENT 返回安全行动指引，四份用户文档增加新手配方 | one-shot 与持久工具 ask 放行、拒绝、无服务 fail-closed、取消清理，以及两入口 ENOENT 指引回归；全量 321 绿 | ☑ |
| 10 | D24 多后端命名空间 | 配置/工具面/池/注册表/面板 + 测试 | 343 绿；0.1.20 单后端工具定义夹具逐字节一致；双后端 argv 路由、非默认重连与并发单飞均已验证 | ☑ |
| 11 | D20 可见性语义 | 工具和侧栏按 owner 严格发现；操作面保持 chatId 直达 | 工具严格过滤/headless 回退/跨会话操作，侧栏 seat 会话过滤与 owner 标识均已验证 | ☑ |
| 13 | D27 工作区角色(第一轮) | `team-config.ts` 配置层、`roster.ts` 花名册、池自动供给、send/close/list 的 role、Config `workflow` | `team.spec.ts` 13 例全绿；`workflow: false` 时工具定义与 0.2.7 逐字节一致 | ☑ |
| 14 | D27 `acp_workflow` 引擎(第二轮) | `workflow-engine.ts`:parallel 部分容错 / `{stepId}` 顺序注入 / merge 两模式;`acp_workflow` 工具(后台 job 或同步);steer 的 role | `workflow.spec.ts` 10 例全绿 | ☑ |
| 12 | D25 Codex app-server 适配器 | `connection-codex.ts` 连接层、池协议路由与 Config、`mock-codex-server.ts`、`codex-approval.ts`(ask 桥)与四份文档 | mock 联调全绿(见 AGENTS.md 基线)；ACP 路径与单后端工具定义不回归；**真机 Codex 探针待做** | ☑(mock) |
| 15 | D31 后端诊断与新会话路由 | 兼容表、启动发现与验证、Codex 与 Antigravity 零配置、状态工具/面板 | 初版夹具覆盖版本边界、Codex 登录与旧线程模型、`agy 1.5.14` 零配置及建会话认证错误；Desktop 已验证 Codex 升级和折叠栏入口 | ◐ agy 零配置待 Desktop 实测;2026-11-25 发版前收尾已完成(改派回执写明、D6/D24/D26/D27 修订、「找不到」判定如实描述、预中止断言修复,全量 579 绿) |
| 16 | D31 PR #1 首轮兼容性修订 | 已配置的未知版本告警但可试、老会话按 D6 续聊、单次失败不锁后端、工具注册稳定，保留显式选择与固定默认 | 首轮全量 547 例通过、D8 因缺少官方源码夹具跳过 24 例；第二轮收窄自动回退并隔离测试环境 | ◐ D8 与 Desktop 实测待补 |
| 17 | D31 PR #1 二轮审阅修订 | 仍默认开启发现；仅顶层 Kiro 可执行文件明确找不到时回退到 Codex、`agy`，不因版本、握手或认证问题改派；显式选择和旧会话不变 | 覆盖旧配置升级、瞬时失败不改派、角色供给及建会话 ENOENT 固定指引；隔离 PATH 后全量 553 例通过，24 例按 D8 跳过 | ◐ 自动化通过，D8 与 Desktop 实测待补 |
| 18 | D32 Dispatcher 的团队上下文 | 角色蓝图 `summary`、首次播种前置英文团队上下文(无 seeding 不加轮)、`acp_team_list`、persona 三句、示例模板 | `team.spec` 覆盖 summary 解析、上下文文本、无 seeding 零轮、三态与 headless、真池回显;`workflow: false` 工具面不变;全量 585 绿 | ☑ |
| 19 | D33 开关拆分 | Config `roles`(默认 true)管 role 参数、`acp_team_list`、团队上下文与列表角色末行;`workflow` 只管 `acp_workflow` 与模板末行;`roles: false` + `workflow: true` 加载报错;persona、报错出路、注入措辞随之调整 | `tools.spec` 四种组合各断言工具名、`role` 参数与列表末行，另测配置冲突与无团队文件时的出路;`roles: false, workflow: false` 工具面与 D27 之前逐字节一致;全量 591 绿 | ☑ |
| 20 | D35 能力查询与面板开关 | 连接级共享能力读取、三处关闭态、工作流只读历史与旧宿主兼容 | 本机按文件单次验证 panel 23/23、client 110/110；全量回归留给 CI | ☑ |
| 21 | D36 与 D31 回执修订 | Dispatcher 动态团队提示、工作流成员改派说明、工具描述与实际开关对齐 | workflow、jobs、team 及 client 单文件通过；真实提示词夹具补注入、tools 等待条件修订后的运行结果待 CI | ◐ |

## 冒烟剧本(第 6 步固定内容)

1. `acp_chat_start` → chatId;
2. `acp_chat_send`:"记住暗号 X";
3. 杀进程(手动或超时);
4. `acp_chat_send`:"暗号是什么?" → 应答 X(证明 load 恢复上下文);
5. 空闲释放后再次 send → 仍记得(重连路径复验)。

## 完成后(阶段三展望,另行设计)

装机文档、开源发布(github + npm)、官方 PR 评估(以本实现为参考,推进 Dev Note 中的 continuable ACP 方向)。

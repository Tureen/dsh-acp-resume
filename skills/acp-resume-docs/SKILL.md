---
name: acp-resume-docs
description: 用户询问 dsh-acp-resume 怎么配置、怎么派工和续聊、插件报错怎么办，或需要设置 ACP Dispatcher、角色、模板工作流和 Kiro、Codex、agy 后端时，加载本使用文档。
---

# ACP Resume 使用文档

加载本文只授权读取说明。修改用户的 profile、团队文件或会话状态，需要用户明确要求。

## 先查什么

1. 问当前能派给谁，先看本 Agent 的工具清单与后端状态工具的只读结果。工具名可能有自定义前缀。
2. 不确定配置项时，先读当前安装的 `node_modules/dsh-acp-resume/lib/index.js` 中的 `Config`；Dispatcher 的 schema 在同包 `lib/dispatcher-preset.js`。以安装位置为准。
3. 再按下表读对应参考页，路径相对于 skill 回执中的 Base directory；最后才引用同包 README。查不到运行时状态或对应版本时，明确写「未核实」。

## 配置速查

右侧栏 → ACP 会话 → 设置可即时保存默认后端、各后端缺省模型与思考强度（`backendDefaults`）、角色与工作流、等待与未验证版本开关、空闲与探测超时，以及 Dispatcher 工具和规则，无需重启 DSH。其余静态配置仍需改 profile 并重启 DSH。

- 在 `~/.dsh/profiles/<name>/cordis.patch.yml` 顶层写 `- id:`。覆盖主行 `subagent-acp-resume` 时，整个 `config` 会替换，须保留顶层 `command` 和仍需使用的参数。
- 独立行 `acp-dispatcher-settings` 的 `config.dispatcherTools` 有六项。默认 `readOnlyFs: false`；`web: true`、`present: true`、`todo: true`、`askUser: true`、`compaction: true`。开启只读文件也开启 skill 加载。
- 同一行的 `config.dispatcherPrompt.extraRules` 默认空，非空文字在自带规则后追加；`overrideRules: true` 需要非空文字，只替换调度流程，保留身份和工具指引。手改 profile 后重启 DSH，在新会话选模式。
- 工作区角色定义放在 `.agents/acp-team.yml`。默认 `roles: true`、`workflow: false`，已派工角色会在侧栏「团队派工」视图按状态展示。先确认任务目标的绝对目录，再建 chat；追问用原 chatId，后台 job 完成通知到达后用 job_output 收结果。
- agy 的持久会话可设 `modelSelect: session`、`effort: high`。agy 的 `thought_level` 支持 low/medium/high/xhigh，实际档位随模型而异；Kiro 另支持 max，Codex 用自己的每轮强度。
- 面板的「后端状态」显示后端实际报告的模型与思考强度，配置与报告不同会标出。看清来源：Codex 无会话探测给默认值，ACP 会话报告给最近活跃连接的值。
- 查看在途输出：打开具体 ACP 会话详情并展开运行轮；结算后查看同一轮的日志结果。
- Kiro / agy 的会话行（含已释放会话）可展开「仅此会话设置」切换模型与强度；显式选择在本次进程内的后续重连保留，未改则沿用缺省配置。

## 常见报错

- `DUPLICATE_PROVIDER`：检查是否启用 bundle 后又 insert 了一次主插件；修改已挂载行用同 id 的顶层覆盖。
- `cannot dispatch`：查看后端状态中的 reason，核对 DSH 所见可执行路径、登录和模型，再重查。
- `pass chatId instead`：检查 roles 开关、调用会话和工作目录；没有团队文件时可直接使用现有 chatId。
- `already has a prompt in flight`：同一 chat 正忙。等通知，或对支持插话的运行中任务使用 steer。

## 按任务读取

| 要解决的问题 | 文件 |
|---|---|
| 主插件字段怎么填，默认值如何继承 | [配置参考](references/configuration.md) |
| 后端怎么选模型、强度、审批和沙箱 | [后端](references/backends.md) |
| 调整 Dispatcher 工具、提示词或迁移旧配置 | [Dispatcher](references/dispatcher.md) |
| 配工作区角色、播种、花名册和模板 | [角色与工作流](references/roles-and-workflow.md) |
| 创建、续聊、收 job、插话和释放 | [模型工具](references/tools.md) |
| 根据报错原文找原因和处理方法 | [排错](references/troubleshooting.md) |
| 按场景复制 profile 顶层配置 | [常用配方](references/recipes.md) |
| 同时配置多个后端、Dispatcher 和工作流 | [完整覆盖模板](templates/profile-override.yml) |

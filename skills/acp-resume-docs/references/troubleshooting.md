# 按原始消息定位问题

下表保留可搜索的消息片段；尖括号代表实际值。区分 Loader 警告、状态行、工具错误与恢复通知。

## 安装与配置

| 原文 / 错误码 | 含义 | 怎么改 |
|---|---|---|
| DUPLICATE_PROVIDER / a subagent provider named "<name>" is already registered | provider 重名 | 移除重复 insert 或 preset 子项，用 id 覆盖现有行。 |
| patch: entry "preset-acp-dispatcher" not found | 旧覆盖跳过 | 改用 acp-dispatcher-settings，见[迁移说明](dispatcher.md)。 |
| Duplicate agent preset: acp-dispatcher | 声明重名 | 只启用一处声明。 |
| dispatcherPrompt.overrideRules requires nonempty extraRules | 替换文本空 | 填写规则或关闭替换。 |
| workflow: true requires roles: true | 模板依赖角色 | 开 roles 或关 workflow。 |
| backend names must match [A-Za-z0-9_-]{1,32} and cannot be default | 命名后端键非法 | 改键及角色引用。 |
| defaultBackend must name an available backend definition or default | 固定默认项找不到 | 选已定义键或 default。 |
| registryPath must be an absolute path | 相对路径 | 改绝对路径或空串。 |
| must be a positive finite number no greater than 2147483647 | 空闲或关停越界 | 填合法毫秒数。 |
| is not a session effort level | 会话强度值无效 | agy 选 low、medium、high、xhigh；Kiro 还允许 max，均须模型支持。 |
| skill "<name>" is unknown or no longer available | 目录无此技能 | 查安装文件和全局行；Dispatcher 查 readOnlyFs。 |

## 新建后端

| 原文片段 | 含义 | 怎么改 |
|---|---|---|
| ACP agent command was not found (ENOENT). / executable not found in the DSH runtime | 宿主找不到 CLI | 查 DSH PATH、执行权限或改绝对路径。 |
| acp-resume: cannot dispatch: | 新建被拒 | 读状态行的具体原因。 |
| No dispatch backend is ready. / waiting for the automatic backend check | 无就绪项或检测中 | 等检测结束，修复后重查。 |
| could not read the CLI version / CLI version is outside the verified range | 版本未知或范围外 | 核对命令与版本，见[后端](backends.md)。 |
| configured CLI launch mode or flags are not supported | 启动模式错 | 查 v3 模型旗标、agy 引擎旗标、Codex 协议。 |
| CLI detected but not configured as a dispatch backend / custom ACP executable has no published compatibility range | 候选未配置或包装器未知 | 核对命名配置与启动方式。 |
| sign in to the CLI, then run backend detection again | 需认证 | 登录 CLI 后重查。 |
| the backend did not pass the connection check / did not open a session | 连接失败 | 查阶段与 CLI 诊断。 |
| Codex did not advertise a usable default model / no usable default model for Codex backend | 无唯一可用默认模型 | 选账号可用的模型。 |
| the explicitly configured Codex model is unavailable | 显式模型不可用 | 改模型后重查。 |
| unknown backend / selected backend is not available | 未知候选 | 查 schema 和状态。 |
| was not found; this chat uses | Kiro 缺失，首次创建改派 | 报告实际后端，确认是否只读。 |
| label is <n> characters; keep it at most 80 | 标签过长 | 缩短标签。 |

## 续聊与后台任务

| 原文片段 | 含义 | 怎么改 |
|---|---|---|
| unknown chat / call <prefix>list to see known chats | chat 未找到 | 在原主会话用 list 找 chatId。 |
| uses unavailable backend / the saved session belongs to another agent and was not loaded | 后端缺失或指纹不符 | 恢复旧配置或另建 chat。 |
| already has a prompt in flight / is still being set up | chat 单飞，或角色正在首次供给 | 等通知或使用支持的 steer。 |
| has no turn in flight / has no chat in this session, so it has no turn to steer | 无在途轮 | 用 send。 |
| this backend does not support mid-turn steering | 插话不支持 | 等轮结束，或中止后再 send。 |
| Waiting on job <id> is disabled / You have a running acp-chat job | 等待被拒 | 等通知后用 job_output 不带 wait。 |
| remote session lost, started fresh / remote session failed repeatedly, started fresh | 远端上下文已换新 | 补背景并重述问题。 |
| send aborted before it started / was released before the prompt started | 发送前已取消 | 查状态再决定是否重发。 |
| releasing chat <id> failed; its record is kept | 释放失败 | 保留记录，查进程诊断。 |
| the agent stopped before finishing / the agent failed before it finished / the agent ran out of room / the agent declined to answer | 轮次非 completed | 查看部分输出和 stop reason，按取消、进程失败、上下文不足或拒绝分别。 |
| backend detection is disposed / pool already disposed / open window aborted by pool teardown | 插件在拆卸 | 重载后重查。 |
| subagent request was aborted before the ACP child started | 启动前取消 | 查上游取消状态。 |
| is not a Codex backend / missing settings for Codex backend | 协议不符 | 查对应的 protocol 和命令。 |

## 角色、模板与面板

| 原文片段 | 含义 | 怎么改 |
|---|---|---|
| pass either chatId or role, not both / pass chatId or role / chatId is required | 目标无效 | 按 schema 指定一个目标。 |
| role is not available: the roles feature is off | 角色开关关闭 | 用 chatId 或明确开启 roles。 |
| role needs a calling DSH session / roles need a calling session / acp_workflow needs a calling DSH session | 缺会话身份 | 在会话内调，或用 chatId 续聊。 |
| no workspace team config / pass chatId instead | 未找到团队文件 | 从调用目录向上查三级。 |
| workspace config error: / workspace team config … is invalid / fix the file, or pass chatId instead | 解析失败 | 查缩进、键名、步骤。 |
| no roles defined / unknown role / unknown template | 定义缺失 | 查当前工作区的角色和模板。 |
| names unknown backend / could not be provisioned | 供给失败 | 查后端、目录及种子轮。 |
| role <role> has no chat in this session | 尚未绑定 | 首次派工用 send。 |
| a return_to_model merge must be the last step / put its instruction in merge.prompt | 合并步骤结构错误 | 回交放末尾；合并指令放 merge 内。 |
| needs params: / has no param / must be a string, number, or boolean | 参数不符 | 只给声明的标量参数。 |
| every role failed / workflow <name> failed | 工作流停止 | 读部分 JSON，按成员排查。 |
| gateway/invocation-unavailable | 缺少 Remote | 能力查询遇此码走旧协议；检查两端版本。权限错误和断线另行。 |

# 派工、续聊与收结果

以当前 Agent 暴露的 schema 为准。以下为默认名称，尖括号内为需换成实际值的参数。enableChatTools 关闭时仍保留一次性 provider，持久会话工具不注册。

| 工具 | 参数 | 读回什么 |
|---|---|---|
| acp_backend_status | 无 | 各后端版本、兼容范围、就绪情况、新建默认项与行动建议。读缓存不会启动 CLI。模型与强度的报告及配置对比见面板「后端状态」，不在该工具回执中。 |
| acp_chat_start | cwd 必填绝对工作目录；可选 label（最多 80 个字符）。有 backend 参数的变体才传后端名。 | chatId 与 remoteSessionId；多后端变体还给实际 backend、cwd，发生改派时给 fallbackNotice。 |
| acp_chat_send | chatId 或 role，另加 message | 有 jobs 时立即返回 jobId 和回执，回答流入 job；同步时返回最终回答，非 completed 转工具错误并附可用的部分输出。 |
| acp_chat_list | 无 | 当前主会话的活跃和已释放 chat、后端、状态和角色；团队文件的问题也可能在末行报告。无调用会话时才退回全局列表。 |
| acp_chat_steer | chatId 或 role，另加 message | 将补充指令加入正在执行的轮次，返回 queued 与可选 messageId。未入队或后端不支持时会明确说明。 |
| acp_chat_close | chatId 或 role，可选 purge（默认 false） | 释放进程并报告保留或删除记录。在途轮先取消；按 role 关闭还会解除本主会话的绑定。 |
| acp_team_list | 无；要求 roles 开启 | 工作区角色、summary、未建/空闲/运行中状态。没有调用会话时状态为 unknown，并提示角色需要调用会话。 |
| acp_workflow | template 与按模板声明填写的 params；要求 workflow 和 roles 均开启 | 同步返回运行 JSON 或带部分 JSON 的失败；有 jobs 时返回 jobId，完成后从 job_output 读 JSON。 |
| acp_backend_usage | 可选 backend、refresh（默认 false）；须有显式配置的 Codex 后端才注册 | 额度结构的 JSON 文本，含套餐、最紧窗口的已用比例和重置时间；ACP 后端为 unsupported。成功缓存 5 分钟，失败缓存 1 分钟。 |

## 一次派工

用状态工具确认候选的实际就绪情况。新建 chat 前确认目标项目的绝对目录；不要因为当前正在 A 仓库对话，就让处理 B 项目的 Worker 在 A 中运行。用户明确指定后端时按其选择派工。

start 的 chatId 标识后续操作的本地会话；remoteSessionId 是后端的会话号；jobId 标识一次后台任务。send、steer、close 的 role 与 chatId 二选一；角色必须有调用会话。相同 chat 单飞，不排队。已有会话直接 send，不因新的检测结果重新 start。

后台 job 运行期间可做独立工作，完成通知会唤醒主会话。宿主提供 `wait_agent` 时，可留在本轮等通知；默认超时 30 秒，用户插话会提前返回。收到完成通知后用 `job_output` 不带 wait 收结果。默认等待门只拦运行中 acp-chat 的 `job_output wait:true`。需中止任务时用 job_kill。未挂 jobs 服务则同步等待。

## 释放、恢复与历史

默认空闲十分钟释放进程，注册表和日志保留。send 会尝试恢复。明确丢失远端会话或同一池实例同一 chat 连续三轮 error 后，下一次发送可能使用全新远端上下文；看到 fresh 提示时补充背景。未知原因的恢复失败会报错并保留绑定。

purge 会删除本地记录和对应日志，Kiro 远端记录由其 CLI 单独管理。侧栏可读轮次、后端状态和按 owner 隔离的工作流历史。workflow 关闭时只读历史；持久面板关闭时显示关闭态。修复建议见[排错](troubleshooting.md)。

### 从面板调整单个会话

进入创建该 chat 的 DSH 主会话，在右侧栏展开「仅此会话设置」，即可调整空闲 Kiro / agy 连接的模型和思考强度。后续轮次使用该选择，重连后按配置初始化。Codex 暂不支持会话级切换，可在后端配置中改模型。升级后释放、删除或切换提示重启时，重启 DSH 再操作。

### 在详情中跟进运行轮

在创建此 chat 的 DSH 主会话打开右侧栏 → ACP 会话，进入该 chat 的详情并展开运行轮。实时输出从当前轮已收到的文本开始，超过 64 KiB 时显示尾部。上翻暂停自动跟随；折叠、切走或关闭页签停止订阅。列表不取流，完成后详情显示已有轮日志的最终文本。工作流成员也可在各自的 chat 详情查看。

# 可续聊 ACP 子代理

`dsh-acp-resume` 让 DeepSeek Harness (DSH) 与外部 ACP agent 保持同一条多轮会话。它保留官方一次性委派能力，同时将远端会话号保存在本地：进程退出或空闲释放后，下一次发送会通过 `session/load` 继续原会话。

## 安装

- **npm：**运行 `dsh plugin --profile <name> add dsh-acp-resume`。若刚发布的版本被 `minimumReleaseAge` 过滤，请钉住版本：`dsh plugin --profile <name> add dsh-acp-resume@<版本>`。
- **Discover：**在 **插件** 页的 **实验性插件** 中启用 **自定义插件索引**。打开 **发现**，选择 **添加索引源**，填入 `https://tureen.github.io/dsh-acp-resume/index.json`，再从 `dsh-acp-resume` 卡片确认安装。

安装后重启 DSH。详细的 npm、本地 tgz 与升级说明见 [README](../README.md)。

## 会话工具与面板

模型可使用五个工具：

- `acp_chat_start`：建立持久会话并返回 `chatId`。
- `acp_chat_send`：发送消息。宿主支持后台任务时会立即返回 job id；否则同步等待回答。
- `acp_chat_list`：列出活跃和已释放的会话。
- `acp_chat_close`：释放进程；使用 `purge` 同时删除本地记录。
- `acp_chat_steer`：向正在执行的一轮插入后续指令。

右侧栏的“持久会话”面板可查看会话状态、轮次和详情，并可释放或删除会话。点击卡片可查看每一轮的问题、回答和重连事件。

## 关键配置

- `command`：外部 ACP agent 的可执行文件。默认示例使用 `kiro-cli`。
- `permission`：`allow` 自动允许、`reject` 自动拒绝、`ask` 将每次请求交给宿主用户确认。bundle 默认 `allow`；无确认服务或有效回答时 `ask` 会拒绝。
- `agentEngine: none`：所用 agent 不接受 kiro 的 `--agent-engine` 参数时设置，避免追加该参数。

### 新手配方

以下是 bundle 已启用时写进 profile `cordis.patch.yml` 的顶层同 id 覆盖，不要再加第二个 `- insert:`。

**默认 kiro-cli。** 无需覆盖：安装 `kiro-cli` 并确保它在 `PATH` 中即可使用自带的 `command: kiro-cli` 和 `args: [acp]`。

**指定路径的 kiro-cli。**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/kiro-cli
    args: [acp]
```

**换用其他 ACP agent，并逐次询问权限。**

```yaml
- id: subagent-acp-resume
  name: 'dsh-acp-resume'
  config:
    command: /absolute/path/to/other-acp-agent
    args: [acp]
    agentEngine: 'none'
    permission: ask
```

完整配置、默认值和手动接线方式见 [README](../README.md#配置)。

## 已知限制

- 目前只在 `kiro-cli` 上实测；其他 ACP agent 需要自行验证。
- `acp_chat_steer` 使用 kiro 专属的 `_session/steer` 扩展。其他 agent 未实现时会明确报错。
- 持久会话依赖远端 agent 支持 `session/load`。会话丢失或连续失败时，插件会新开会话并提示重新提供必要上下文。

## 链接

- [GitHub 仓库](https://github.com/Tureen/dsh-acp-resume)
- [npm 包](https://www.npmjs.com/package/dsh-acp-resume)
- [插件索引](https://tureen.github.io/dsh-acp-resume/index.json)

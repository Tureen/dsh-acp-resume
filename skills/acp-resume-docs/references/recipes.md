# 选择一份 profile 配方

以下每段都是一个完整的顶层覆盖，用在启用了本包 bundle 的 profile。选符合目标的配方；同一 id 只保留一条。若已有其他定制，将所需字段放回同一个 config。文件在 ~/.dsh/profiles/<name>/cordis.patch.yml，列表的短横线顶格。

## 只用 Kiro，在会话中指定强度

适用于支持强度的 Kiro v3 模型。此例要求用户逐次确认权限，并关闭额外后端发现。

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    command: kiro-cli
    args: [acp]
    permission: ask
    discoverBackends: false
    modelSelect: session
    effort: high
```

## 新任务优先给显式 Codex

保留顶层 ACP 启动配方，同时使用命名的 Codex。示例让标准 codex CLI 使用可验证的账号模型；没有可用默认时，在 codex 项下填写账号实际可用的 model。

```yaml
- id: subagent-acp-resume
  name: dsh-acp-resume
  config:
    command: kiro-cli
    args: [acp]
    permission: ask
    defaultBackend: codex
    backends:
      codex:
        command: codex
        protocol: codex
        sandbox: read-only
        approvalPolicy: on-request
        permission: ask
```

## 让 Dispatcher 查文件、读使用文档，并追加交付要求

文件核对会同时启用技能发现和加载。关闭 web 后，主 Agent 的工具指引也会移除直接联网查证那一句。

```yaml
- id: acp-dispatcher-settings
  name: dsh-acp-resume/dispatcher-preset
  config:
    dispatcherTools:
      readOnlyFs: true
      web: false
    dispatcherPrompt:
      extraRules: |
        汇总时列出每个 Worker 使用的证据与仍待确认的事项。
      overrideRules: false
```

多后端加工作流的组合见[完整模板](../templates/profile-override.yml)。模板蓝图另放在工作区，见[角色与工作流](roles-and-workflow.md)。修改 profile 后重启 DSH，再从新会话的模式菜单选择 Dispatcher。

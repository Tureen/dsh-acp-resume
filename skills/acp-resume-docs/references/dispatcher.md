# 配置 Dispatcher 的工具和调度方式

右侧栏 → ACP 会话 → 设置可改 `dispatcherTools` 六项和 `dispatcherPrompt` 两项（以及主插件的 `backendDefaults` 等实时项），直接保存到同一份 profile。新绑定的 Agent 使用更新后的工具与 persona，已绑定的 Agent 完成原任务时仍持有原版本；在途的 ACP 会话不受影响。需要保留 YAML 注释时手改 profile。

标准模式已经能用全局 ACP 工具，适合边执行边派工。新会话选 ACP Dispatcher 后，主 Agent 负责分配、转述和汇总，外部 Worker 执行任务。主 Agent 的工具选择对 Worker 的命令、权限和沙箱没有覆盖作用。

编辑 profile 顶层 acp-dispatcher-settings 行，其 name 为 dsh-acp-resume/dispatcher-preset。dispatcherTools 与 dispatcherPrompt 同在该行 config 下。重启 DSH 后在新会话选择模式；运行中若只重载声明，已有绑定仍持有旧组合。模板见[完整覆盖](../templates/profile-override.yml)。

| 开关 | 默认 | 该项影响 |
|---|---|---|
| readOnlyFs | false | 开启 read、grep、glob 和 skill。可先加载技能入口，再读取其 Base directory 下的参考页。文件写入、编辑、补丁和图片读取保持关闭。 |
| web | true | 轻量联网查证（含 fetch）。关闭时对应 persona 指引也会移除。 |
| present | true | 展示交付物；关闭时在对话中提供交付物位置。 |
| todo | true | 维护支持并行事项的任务清单。 |
| askUser | true | 用工具提问；关闭后仍可直接在对话中澄清。 |
| compaction | true | 整组切换压缩、手动命令和工具结果裁剪。 |

0.5.1 的 dispatcherTools.skill 在 0.6.0 仅为兼容而接受。只有 readOnlyFs 决定 Dispatcher 是否能加载技能；旧 skill: true 配合关闭的 readOnlyFs 会在声明加载时告警。标准模式从 bundle 的全局文档 provider 发现本手册，与这些开关无关。全局 provider 只提供文档目录，标准模式和 Dispatcher 各自决定是否提供加载工具。

## 追加或替换文字

dispatcherPrompt.extraRules 默认空，去首尾空白后放在自带汇总规则之后，保留段内换行。overrideRules 默认 false。改为 true 时必须给非空规则，接管后端检查与派工流程、目标目录确认、共享写入范围和结果汇总。身份、自身工具边界、宿主其他提示与条件团队段仍有效；菜单说明只取决于工具开关。

默认规则要求派工前明确目标项目、仓库或 worktree，将绝对路径显式交给启动工具。目标唯一可直接派，多个候选请用户选择。团队转述只在实际 Dispatcher 会话且本步团队工具可用时出现。

## 迁移旧行

旧 preset-acp-dispatcher 覆盖在 rc.5 会报未匹配行并被跳过。只想开文件核对时改新行的 readOnlyFs；曾禁用旧行时改为禁用新行。完全自定义 persona 或新增其他执行工具时，先禁用新声明行，再 insert 完整官方 preset 声明，保留 config.id 为 acp-dispatcher，避免同 id 双重注册。

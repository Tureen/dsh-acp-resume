# 内置后端的 CLI 版本支持范围

2026-11-22，针对本插件使用的协议和启动方式查证。最低版本和纳入支持的次版本线由上游发版记录、发布 tag 的协议源码及已有实测确定。同一次版本线内，正式补丁版默认进入运行时检查；不会把最后核对的补丁号当成上限，也不自动纳入新的次版本线。范围内不代表已就绪或每个补丁均已实测；范围外表示版本未验证，不等同于已证实不兼容。

<!-- compatibility:begin -->
| 后端 | 稳定正式版范围（含下限，不含上限） |
| --- | --- |
| Kiro ACP V2 | `>=2.36.0 <2.38.0` 或 `>=3.0.0 <3.6.0` |
| Kiro ACP V3 | `>=2.36.0 <2.38.0` 或 `>=3.0.0 <3.6.0` |
| Codex app-server | `>=0.154.0 <0.172.0` |
| Google Antigravity CLI (`agy acp`) | `>=1.5.4 <1.6.0` |
<!-- compatibility:end -->

[兼容表](../src/backend-compatibility.ts)以数字比较三段式版本；预发行版及带 `+` 构建标记的版本不计入正式版。是否属于内置后端，由调用方先确定；表不按输出中的产品名识别可执行文件。版本符合范围也不保证登录、模型授权、任意 argv 或非标准部署可用。

- **新会话的默认路由**：未显式选择或固定默认项时，仍使用顶层后端。开启发现时，只有 DSH 确认找不到顶层配置的 Kiro 可执行文件，才从范围内且已就绪的候选中依次选择 Codex、`agy`；版本告警、握手失败和认证失败都不触发回退。没有合格的候选时仍尝试原命令，保留找不到命令的指引。`allowUnverifiedBackends: true` 不改变回退条件。
- **已配置与自动发现的后端**：配置过的 CLI 或包装脚本即使版本未知或超出范围，仍可按原配置尝试连接并收到告警。对仅由自动发现得到的范围外 CLI，可开启 `allowUnverifiedBackends: true` 后显式选择或固定为默认项；这不是兼容性保证。
- **续聊**：已有 `chatId` 的发送和重连不受版本表或就绪检测结果拦截，继续按原后端和 D6 恢复逻辑处理。

## Kiro ACP V2 / V3

- [2.36.0 发行说明（Improvements）](https://kiro.dev/changelog/cli/2-36/)说明 `acp.agentEngine` 支持 `v1`、`v2`、`v3`，`kiro-cli acp --agent-engine` 覆盖该值，未指定时跑 V2；[ACP 文档「Choose the agent harness」](https://kiro.dev/docs/cli/acp/#choose-the-agent-harness)也注明 CLI 2.36 起支持这一选择。用它作为显式选择两种引擎的下界，而不是声称 2.35 以前从未实现 ACP。
- [2.37.1 补丁发行说明](https://kiro.dev/changelog/cli/2-37/#patch-2-37-1)和 [D19](../DECISIONS.md#d19-默认切-kiro-v3-引擎--插话工具-acp_chat_steer2026-11-04)：本项目在 CLI 2.37.1 确认两个引擎的握手及私有 `_session/steer`，并确认 V2 创建的会话能由 V3 `session/load` 恢复。`2.37.1` 是 2.37 线的核对点，不是该线的补丁上限；不因此纳入 2.38 或更高次版本。
- [3.0.0 发行说明](https://kiro.dev/changelog/cli/3-0/#start-on-v3-by-default)记录 ACP 默认切换到 V3 与 V2 共存；[引擎选择文档](https://kiro.dev/docs/cli/agent-harness/#acp-clients)确认显式指定引擎优先。最新核对点见 [3.5.0 发行说明](https://kiro.dev/changelog/cli/3-5/)和 [ACP 参考文档](https://kiro.dev/docs/cli/acp/#default-agent-and-model-on-v3)中写明的 3.5.0 行为。不给 V1 单列支持范围：识别 `v1` 参数的说明不是持久会话协议证据，且 3.0 已退役 Classic 交互界面。
- [V3 ACP 客户端迁移](https://kiro.dev/docs/cli/v3/acp-migration/)列出 `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`，并区分 V2 的 `session/set_model` 与 V3 的 `session/set_config_option`；两种引擎都协商 ACP v1，不能靠 `protocolVersion` 区分。文档也明确要求按握手能力决定运行期的可选方法，明确指出现在的 V3 ACP 会拒绝 V2 专用启动旗标（含 `--model` 和 `--effort`）。上表针对核心 ACP 的启动、会话和轮次，不承诺任意组合的启动参数、会话选项或私有 `_session/steer`；本文档不改变用户 wrapper 的参数处理。

## Codex app-server

- [OpenAI v0.154.0 release（#42358）](https://github.com/openai/codex/releases/tag/rust-v0.154.0)扩展额度读取请求。前一版 [v0.153.0 的请求分发表](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/app-server-protocol/src/protocol/common.rs)定义 `account/rateLimits/read` 的参数为 `Option<()>`；[v0.154.0 的同一分发表](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/src/protocol/common.rs)改用 `NullableGetAccountRateLimitsParams`，[生成的请求类型](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountRateLimitsParams.ts)列出 `excludeResetCreditDetails`。本插件按 [D28](../DECISIONS.md#d28-后端额度查询先接-codex2026-11-20)发送 `{ excludeResetCreditDetails: true }`，故不能因更旧版本已有 `thread/*` 就纳入完整内置范围。
- 核对三个发布 tag 的协议 schema：[v0.154.0](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.schemas.json)、[v0.160.0](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.schemas.json)（本项目 [D25](../DECISIONS.md#d25-codex-app-server-私有协议适配器2026-11-18实施完成mock-全绿真机探针待做)的参考环境）和 [v0.171.0](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.schemas.json)。其中有 `initialize` / `initialized`、`thread/start`（`ephemeral: false`）/ `thread/resume`、`turn/start` / `turn/steer`（`expectedTurnId`）/ `turn/interrupt`，以及 `item/agentMessage/delta`、`item/completed`、`turn/completed`、`account/read` 与额度读取。[v0.171.0 是本次核对时的最新稳定发布](https://github.com/openai/codex/releases/tag/rust-v0.171.0)；后续 `0.171.x` 正式补丁版可以进入检测，不把私有协议兼容性推断到 `0.172.x` 或更高次版本。
- 兼容范围涵盖标准持久会话、只读额度和命令/文件审批的协议形状，不代表所有可选审批都兼容。发布 [权限扩展的审批响应类型](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/schema/typescript/v2/PermissionsRequestApprovalResponse.ts)要求返回 `permissions`（类型也含 `scope`），不是当前适配器统一回复的 `{ decision }`；这一可选 `item/permissions/requestApproval` 路径不在承诺内。默认 `approvalPolicy: never` 不依赖此路径。也没有使用本机账号、切换模型或触发额度消耗来验证此范围。

- 零配置验证用 `account/read`（[`refreshToken: false`](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountParams.ts)）、[`config/read`](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/schema/typescript/v2/ConfigReadParams.ts) 和 `model/list`（[`Model.isDefault`](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/schema/typescript/v2/Model.ts)）。这些字段也核对过支持区间两端。插件不会发登录请求、创建测试线程或发提示词；上游 CLI 读模型目录时仍可能访问网络。

## Google Antigravity CLI

- [CLI ACP 文档](https://antigravity.google/docs/cli/acp/)说明 `agy acp` 用 stdio JSON-RPC 做编辑器后端；[1.5.0 发行说明](https://antigravity.google/docs/changelog/#rel-cli-1.5.0)首次推出此子命令。只看子命令出现不够：[1.5.1](https://antigravity.google/docs/changelog/#rel-cli-1.5.1)修复取消边界和 `session/update` 顺序，[1.5.3](https://antigravity.google/docs/changelog/#rel-cli-1.5.3)修复断开 ACP 时保存可能被中断，[1.5.4](https://antigravity.google/docs/changelog/#rel-cli-1.5.4)修复会话加载/恢复时丢失模式以及二次工具审批导致整轮挂起。这些直接关系到本插件轮次、释放后重连及权限交互，因此下界为 1.5.4。
- [D24](../DECISIONS.md#d24-多后端命名空间2026-11-17已实施)实测 macOS 上 1.5.9：握手声明 `loadSession`，文本块数组 prompt 的两轮对话成功，杀进程后用 `session/load` 恢复会话；`session/update` 内容在 `params.update` 内。后续公开记录中，[1.5.10](https://antigravity.google/docs/changelog/#rel-cli-1.5.10)仍明确说明 ACP 会话和取消相关修复，[1.5.12](https://antigravity.google/docs/changelog/#rel-cli-1.5.12)是本次可核对的最新公开 CLI 发行说明。版本范围不将上游以新 prompt 实现的插话等同于本插件的可选私有 `_session/steer`。
- Google 的 [macOS ARM64 更新清单](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json)本次已指向 1.5.14。仅下载该上游包、按清单 SHA-512 校验并在临时 HOME 下运行 `--version`，得到裸版本行 `1.5.14`。未安装，也未读取/变更本地会话、账号或模型。更新清单和版本行只证明发布与版本输出。`1.5.13`、`1.5.14` 随同 `1.5.x` 正式补丁版进入运行时检查，不标作已实测的协议版本。

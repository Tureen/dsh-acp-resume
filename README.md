[English](README.en.md)

# dsh-acp-resume

A resumable ACP subagent backend for DeepSeek Harness (DSH): a sibling of the official `@deepseek-ai/dsh-subagent-acp` that keeps an external ACP agent alive across turns and reconnects through `session/load` after the process exits. It uses standard ACP methods but has only been tested with kiro-cli; mid-turn steering (`_session/steer`) is a kiro-specific extension. Set `command` to use another ACP agent, and set `agentEngine: none` if it does not accept kiro's `--agent-engine` flag. Install with `dsh plugin --profile <name> add dsh-acp-resume` (requires DSH `>=0.2.1-rc.5 <0.2.2-0`, Node >= 24). The documentation below is in Chinese; a full English version is in [README.en.md](README.en.md).

DeepSeek Harness 的**可续聊 ACP 子代理后端**:官方 `@deepseek-ai/dsh-subagent-acp` 的独立兄弟包。在完整保留官方一次性(one-shot)委派行为的基础上,新增**持久会话池**——进程保活、远端会话号落盘、进程死后经 `session/load` 重连,让模型可以与同一个外部 ACP agent 持续多轮协作。用的是标准 ACP 方法,但**目前只在 kiro-cli 上实测**;会话中途插话(`_session/steer`)是 kiro 专属扩展,其他 agent 不支持时该工具会明确报错。通过 Config 的 `command` 可指向其他 ACP agent,`agentEngine: none` 可关闭对 `--agent-engine`(kiro 的引擎旗标)的追加,以适配不认该旗标的 agent。

状态:已发布到 npm(0.1.16)。连接原语、会话池、五个工具、持久会话面板与接线均已实现,并完成一轮六维评审修复(D16)。

**已知限制与后续计划**:完整的真机 kiro-cli 冒烟剧本(建会话 → 两轮 → 杀进程 → 重连记得上文 → 空闲释放 → 再连)尚未全部走完,其间的行为目前由 mock 服务器的测试覆盖;只在 kiro-cli 上有过实测,其他 ACP agent 未实测。进度见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 动机

官方 ACP 后端每次委派启动新进程、单轮执行、结束即销毁——远端会话虽在对方侧落盘(kiro 实测 `session/load` 可用),但永不复用。本包补上这一层:

- 外部 agent 的会话号持久化在 `$DSH_HOME/storages/acp-resume/registry.json`;每个会话的轮次记录(消息与回答文本,明文)另存于同目录 `turns/<chatId>.jsonl`,最近 200 条,供面板详情页查看,删除会话时一并删除;
- 会话进程空闲保活(超时释放,会话记录保留);
- 下次对话自动重连:重新 spawn → `initialize` → `session/load(原会话号 + 原 cwd)` → 继续;远端在协议层拒绝 load 时降级为新会话。若当前池实例同一 chat 连续 3 轮 `error`,下一次 send 也会跳过 load 新开会话,并以前置短语 `remote session failed repeatedly, started fresh` 明确告知;该计数只在内存中保存,应用重启后重新累计。其余失败本次报错、会话记录不动(D6)。

## 架构(与官方完全隔离并存)

```
                    ┌ one-shot provider(注册名 acp-resume,行为与官方 subagent-acp 一致)
本插件 ─────────────┤
                    └ 持久会话池 + 模型工具(注册到 ctx.tools,不经 ctx.subagents)
```

官方包与现有 kiro 链路零接触;设计依据与全部决策见 [DESIGN.md](DESIGN.md) 与 [DECISIONS.md](DECISIONS.md)。

## 模型工具(阶段二交付)

| 工具 | 用途 |
|---|---|
| `acp_chat_start` | 建立持久会话,返回会话句柄 chatId |
| `acp_chat_send` | 向指定会话发消息;进程死后自动重连恢复上下文。宿主装有 jobs 服务时立即返回后台任务 id,回答流式写入该任务;不要对它 `wait` 硬等(运行中的会被拒绝),完成后会话内通知唤醒,再用不带 `wait` 的 `job_output` 读,`job_kill` 停(D22);无 jobs 服务时等待并返回最终回答(D17) |
| `acp_chat_list` | 列出活跃与持久化会话 |
| `acp_chat_close` | 释放会话进程(记录保留,可再连;`purge` 同时删记录) |
| `acp_chat_steer` | 给**在途轮**插话:排队的消息在下一个工具/消息边界生效,不打断当前步;要立即停止用 `job_kill` / `acp_chat_close`。没有在途轮时报错(改用 send);agent 不实现私有扩展 `_session/steer` 时报「当前 agent 不支持插话」(D19) |
| **持久会话面板**(右侧栏,D15/D18) | 按会话聚合的视图:状态/轮数/摘要,释放与删除;点卡片打开该会话的详情页签(元信息 + 每轮问答、结局、重连事件)——见 [PANEL-DESIGN.md](PANEL-DESIGN.md) |

## 配置

挂载方式二选一(见下节「安装与升级」):启用 bundle 时,在 profile 的 `cordis.patch.yml` 写**顶层**同 id 覆盖;不启用 bundle 时用 `- insert:` 手动接线。下例为手动接线,字段全集:

```yaml
- insert:
    - id: subagent-acp-resume
      name: 'dsh-acp-resume'
      config:
        command: /path/to/agent-cli  # 必填:子 agent 可执行文件
        args: [acp]                  # 默认 []
        agentEngine: v3              # 默认 v3;可选 v1 / v2 / v3 / none。启动子进程时追加 --agent-engine <值>;args 里已写该旗标则以 args 为准、不再追加;none = 完全不追加,供不认该旗标的 agent 使用(D19)
        model: glm-5                 # 默认不设 = 服务器 auto 路由(按任务选模型)。设了就钉死,追加 --model <id>;args 里已写 --model 则以 args 为准
        effort: high                 # 默认不设 = 模型自身默认档。设了追加 --effort <档>(low/medium/high/xhigh/max,依模型而异);args 里已写 --effort 则以 args 为准
        providerName: acp-resume     # 默认 acp-resume;不与官方 acp 冲突
        permission: allow            # schema 兜底默认 reject;同官方语义:allow / reject(见下「permission 的两处默认值」)
        env: {}                      # 叠加到清洗后父环境之上的变量(如子 agent 自己的 key)
        enableChatTools: true        # 默认 true;false 时只注册 one-shot provider
        toolPrefix: acp_chat_        # 默认 acp_chat_;五个工具名的前缀
        allowChatJobWait: false      # 默认 false;false 时拒绝对运行中 acp-chat 任务的 job_output wait:true(D22),true 则放开
        idleTimeoutMs: 600000        # 默认 600000;空闲多久释放进程
        disposeEofGraceMs: 6000      # 默认 6000;关 stdin 后等子进程自行收尾的时间
        disposeGraceMs: 3000         # 默认 3000;观察失败/升级信号的宽限,也是 close 等在途轮结算的上限
        registryPath: ''             # 默认空串 = $DSH_HOME/storages/acp-resume/registry.json;自定义时必须是绝对路径
```

`agentEngine` 对一次性 provider 与持久会话两条路径都生效。默认 `v3` 会给子进程追加 `--agent-engine v3`,这是 kiro-cli 的引擎选择旗标;换用其他 ACP agent 时,若它不认该旗标(多数会因未知参数退出),把 `agentEngine` 设为 `none` 即不再追加。`none` 只影响追加:你在 `args` 里自己写的 `--agent-engine` 照常原样传给子进程。重连旧会话时指纹校验忽略该旗标,所以换引擎不会让旧会话被拒;新引擎读不了旧会话时按原规则降级为新会话。

**permission 的两处默认值。** 启用 bundle 时,自带的 `cordis.patch.yml` 把 `permission` 设为 `allow`(无人值守地放行 agent 的权限请求,与 `command: kiro-cli` 一起作为开箱默认)。不走补丁、按上例手工 `- insert:` 接线而没写 `permission` 时,Config schema 的兜底默认是 `reject`。两者不一致是有意的:补丁是为 kiro-cli 开箱即用调的默认,schema 兜底取更保守的一侧。换用其他 agent 或想收紧时,在 profile 里用顶层同 id 覆盖显式写 `permission: reject`。

`model` / `effort` 同样对两条路径生效,是 **spawn 级**选择(作用于该子进程启动的会话)。两者缺省时不拼对应旗标,保持 kiro 的 `auto`(服务器按任务动态选模型,`effort` 不可控);设了就把模型/档位钉死。**生效语义**:只对下次启动的进程生效——已在运行的会话进程不受影响,正在续聊的会话要等它空闲释放、下次 `acp_chat_send` 重连(新进程)时才应用新模型。与 `--agent-engine` 一样,指纹校验也忽略 `--model` / `--effort`(理由见 D19):`auto` 本就在会话内按任务换模型,换个钉死的模型不构成"换了一个 agent",旧会话照旧可续。

`allowChatJobWait`(D22):一轮对话常跑十几分钟,模型用 `job_output` 的 `wait: true` 硬等会顶满宿主 600 秒上限,期间用户新消息排队。默认在工具派发前拒绝对**运行中**的 acp-chat 任务的 wait,并告诉模型等完成通知;任务已结算、其他种类任务(如 bash)不受影响。设 `true` 关闭该拦截。

三个时长字段须为正数且不超过 Node 定时器上限,`registryPath` 为相对路径时插件启动即报错。

## 安装与升级

**主路径:从 npm 安装。** 需要 DSH `>=0.2.1-rc.5 <0.2.2-0`(包里的 `engines.dsh` 声明了这个范围,不满足时安装会被拒绝)和 Node >= 24:

```sh
dsh plugin --profile <name> add dsh-acp-resume
```

> **提示：** 若安装报 `ERR_PNPM_TARBALL_EXTRACT` 或校验和错误，是 dsh 默认的 `minimumReleaseAge` 供应链防护过滤了刚发布的版本；npm 首发包还可能伴随无效的占位版本 `0.0.0-stage`。请显式钉版本：`dsh plugin --profile <name> add dsh-acp-resume@<版本>`，dsh 会将该版本写入 profile 的 `minimumReleaseAgeExclude`，可立即安装。版本发布一段时间后，不钉版本也会恢复正常。

`<name>` 是 profile 名(DSH App 的默认 profile 目录是 `~/.dsh/profiles/desktop/`)。装好后包会出现在该 profile 的 `dsh.profile.bundles` 里,重启 DSH 生效。升级用 `dsh plugin --profile <name> add dsh-acp-resume@<版本>`;卸载用 `dsh plugin --profile <name> remove dsh-acp-resume`。

**备选:本地 tgz。** 在本仓库 `pnpm build` 后 `pnpm pack --pack-destination <稳定目录>`(`prepack` 会先清空 `lib/` 再编译,保证不打进陈旧产物),再 `dsh plugin --profile <name> add <tgz 路径>`。

- tgz 放稳定位置,如 `~/.dsh/local-plugins/`,不要放 `/tmp`。profile 的 `package.json` 以 `file:` 路径引用 tgz,系统清掉 `/tmp` 后,profile 内任何插件增删(都会触发 pnpm install)都会因找不到该文件而失败。
- 升级必须改版本号。同版本号重新 pack 不生效:pnpm 按锁文件里的哈希认包,版本与路径不变时沿用旧缓存。

**不支持 Git 安装。** 本包不带 `prepare` 脚本,`lib/` 也不入库,`github:` 方式装到的只有源码、加载会失败。要支持得写自包含的 `prepare`,用户还得在 profile 的 `pnpm-workspace.yaml` 里为本包开 `allowBuilds`(等于允许安装时执行包内代码),代价见官方 `docs/user/develop/basic/publish.md` 的 "Installing from GitHub" 一节。请用 npm 或 tgz。

- **bundle 与 profile insert 二选一,勿双挂**。profile 的 `dsh.profile.bundles` 列了 `dsh-acp-resume`(插件页开关打开)时,本包自带的 `cordis.patch.yml` 已经 insert 了插件;profile 再 insert 一次会注册两个同名 provider,报 `DUPLICATE_PROVIDER`。启用 bundle 时改配置用顶层同 id 覆盖:

  ```yaml
  - id: subagent-acp-resume
    name: 'dsh-acp-resume'
    config:
      command: /absolute/path/to/kiro-cli
  ```

## 后台任务模式的宿主前提

`acp_chat_send` 的后台模式依赖宿主同时装有 `@deepseek-ai/dsh-jobs-local`(提供 `ctx.jobs`)与 `@deepseek-ai/dsh-tool-jobs`(挂 job 控制器、提供 `job_output` / `job_list` / `job_kill` 与完成通知)。只有前者时 send 会以"无控制器"报工具错误;两者都没有时 send 回到同步等待。

## 真机冒烟前置检查

- 抓一次真机 `initialize` 响应,确认 `agentCapabilities.loadSession` 为 `true`。重连前会检查这项能力,未声明时每次重连都会降级为新会话,续聊失效(D16)。
- kiro load 对 cwd 敏感:确认注册表回放的是原 cwd(DESIGN.md 风险与对策)。

## 开发

```sh
pnpm install && pnpm build     # 构建 lib/
pnpm test                      # vitest;314 绿 = 官方协议面 67 + connection 24 + pool 60 + tools 13 + jobs 12 + panel 16 + client 70 + steer 5 + engine 16 + turn-log 18 + job-wait-gate 13
```

- 基线:源码复制自 `@deepseek-ai/dsh-subagent-acp@0.2.1-rc.5`,peer 钉 `~0.2.1-rc.5`;
- 条件运行的用例:真实子进程类 24 例需要官方 checkout 里的 `spawn.ts`(npm 分发包不含)。官方 checkout(路径由环境变量 `DSH_OFFICIAL_CHECKOUT` 指定,未设置时用测试里的默认位置)在场时全绿、退出码 0;不在时这 24 例自动跳过(见 DECISIONS D8);
- 双实现并存:run.ts 保持官方原版不重构(D11);connection.ts 是池专用姊妹实现;
- 参考用官方源码 checkout:分支 `my-subagent-acp` @ `dsh-v0.2.1-rc.5`(只读对照)。

## License

MIT

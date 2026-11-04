# dsh-acp-resume

DeepSeek Harness 的**可续聊 ACP 子代理后端**:官方 `@deepseek-ai/dsh-subagent-acp` 的独立兄弟包。在完整保留官方一次性(one-shot)委派行为的基础上,新增**持久会话池**——进程保活、远端会话号落盘、进程死后经 `session/load` 重连,让模型可以与同一个外部 agent(如 kiro-cli)持续多轮协作。

状态:**开发中**。阶段二(连接原语、会话池、四个工具与接线)已实现,并完成一轮六维评审修复(D16);待真机 kiro-cli 冒烟与装机验收,进度见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 动机

官方 ACP 后端每次委派启动新进程、单轮执行、结束即销毁——远端会话虽在对方侧落盘(kiro 实测 `session/load` 可用),但永不复用。本包补上这一层:

- 外部 agent 的会话号持久化在 `$DSH_HOME/storages/acp-resume/registry.json`;
- 会话进程空闲保活(超时释放,会话记录保留);
- 下次对话自动重连:重新 spawn → `initialize` → `session/load(原会话号 + 原 cwd)` → 继续;仅当远端在协议层拒绝 load 时降级为新会话并明确告知,其余失败本次报错、会话记录不动(D6)。

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
| `acp_chat_send` | 向指定会话发消息,返回最终回答;进程死后自动重连恢复上下文 |
| `acp_chat_list` | 列出活跃与持久化会话 |
| `acp_chat_close` | 释放会话进程(记录保留,可再连;`purge` 同时删记录) |
| **持久会话面板**(右侧栏,D15) | 按会话聚合的只读视图:状态/轮数/摘要,释放与删除操作——见 [PANEL-DESIGN.md](PANEL-DESIGN.md) |

## 配置

挂载方式二选一(见下节「安装与升级」):启用 bundle 时,在 profile 的 `cordis.patch.yml` 写**顶层**同 id 覆盖;不启用 bundle 时用 `- insert:` 手动接线。下例为手动接线,字段全集:

```yaml
- insert:
    - id: subagent-acp-resume
      name: 'dsh-acp-resume'
      config:
        command: /path/to/agent-cli  # 必填:子 agent 可执行文件
        args: [acp]                  # 默认 []
        providerName: acp-resume     # 默认 acp-resume;不与官方 acp 冲突
        permission: allow            # 默认 reject;同官方语义:allow / reject
        env: {}                      # 叠加到清洗后父环境之上的变量(如子 agent 自己的 key)
        enableChatTools: true        # 默认 true;false 时只注册 one-shot provider
        toolPrefix: acp_chat_        # 默认 acp_chat_;四个工具名的前缀
        idleTimeoutMs: 600000        # 默认 600000;空闲多久释放进程
        disposeEofGraceMs: 6000      # 默认 6000;关 stdin 后等子进程自行收尾的时间
        disposeGraceMs: 3000         # 默认 3000;观察失败/升级信号的宽限,也是 close 等在途轮结算的上限
        registryPath: ''             # 默认空串 = $DSH_HOME/storages/acp-resume/registry.json;自定义时必须是绝对路径
```

三个时长字段须为正数且不超过 Node 定时器上限,`registryPath` 为相对路径时插件启动即报错。

## 安装与升级

本包未发布到 npm,以本地 tgz 装进 DSH profile(以 desktop profile 为例,目录 `~/.dsh/profiles/desktop/`)。

- **tgz 放稳定位置**,如 `~/.dsh/local-plugins/`,不要放 `/tmp`。profile 的 `package.json` 以 `file:` 路径引用 tgz,系统重启清掉 `/tmp` 后,profile 内任何插件增删(都会触发 pnpm install)都会因找不到该文件而失败。
- **升级必须改版本号**。同版本号重新 pack 不生效:pnpm 按锁文件里的哈希认包,版本与路径不变时沿用旧缓存。
- 升级顺序:
  1. 改本仓库 `package.json` 的 `version`;
  2. `pnpm build`;
  3. `pnpm pack --pack-destination ~/.dsh/local-plugins`(`prepack` 会先清空 `lib/` 再编译,保证不打进陈旧产物);
  4. 改 profile `package.json` 的依赖为新 tgz 路径,如 `"dsh-acp-resume": "file:/Users/<you>/.dsh/local-plugins/dsh-acp-resume-<版本>.tgz"`;
  5. 在 profile 目录内 `pnpm install`;
  6. 重启 DSH App。
- **bundle 与 profile insert 二选一,勿双挂**。profile 的 `dsh.profile.bundles` 列了 `dsh-acp-resume`(插件页开关打开)时,本包自带的 `cordis.patch.yml` 已经 insert 了插件;profile 再 insert 一次会注册两个同名 provider,报 `DUPLICATE_PROVIDER`。启用 bundle 时改配置用顶层同 id 覆盖:

  ```yaml
  - id: subagent-acp-resume
    name: 'dsh-acp-resume'
    config:
      command: /absolute/path/to/kiro-cli
  ```

## 真机冒烟前置检查

- 抓一次真机 `initialize` 响应,确认 `agentCapabilities.loadSession` 为 `true`。重连前会检查这项能力,未声明时每次重连都会降级为新会话,续聊失效(D16)。
- kiro load 对 cwd 敏感:确认注册表回放的是原 cwd(DESIGN.md 风险与对策)。

## 开发

```sh
pnpm install && pnpm build     # 构建 lib/
pnpm test                      # vitest;142 绿 = 官方协议面 67 + connection 23 + pool 32 + tools 12 + panel 8
```

- 基线:源码复制自 `@deepseek-ai/dsh-subagent-acp@0.2.1-rc.5`,peer 钉 `~0.2.1-rc.5`;
- 条件运行的用例:真实子进程类 24 例需要官方 checkout 里的 `spawn.ts`(npm 分发包不含)。checkout 在 `/Users/Tulane/Developer/open-source-projects/deepseek-harness`(可用 `DSH_OFFICIAL_CHECKOUT` 覆盖)时全绿、退出码 0;不在时这 24 例自动跳过(见 DECISIONS D8);
- 双实现并存:run.ts 保持官方原版不重构(D11);connection.ts 是池专用姊妹实现;
- 参考用官方源码 checkout:分支 `my-subagent-acp` @ `dsh-v0.2.1-rc.5`(只读对照)。

## License

MIT

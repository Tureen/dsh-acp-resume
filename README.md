# dsh-acp-resume

DeepSeek Harness 的**可续聊 ACP 子代理后端**:官方 `@deepseek-ai/dsh-subagent-acp` 的独立兄弟包。在完整保留官方一次性(one-shot)委派行为的基础上,新增**持久会话池**——进程保活、远端会话号落盘、进程死后经 `session/load` 重连,让模型可以与同一个外部 agent(如 kiro-cli)持续多轮协作。

状态:**开发中**(阶段一基线完成;阶段二实现进行中,见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md))。

## 动机

官方 ACP 后端每次委派启动新进程、单轮执行、结束即销毁——远端会话虽在对方侧落盘(kiro 实测 `session/load` 可用),但永不复用。本包补上这一层:

- 外部 agent 的会话号持久化在 `$DSH_HOME/storages/acp-resume/registry.json`;
- 会话进程空闲保活(超时释放,会话记录保留);
- 下次对话自动重连:重新 spawn → `initialize` → `session/load(原会话号 + 原 cwd)` → 继续;load 失败降级为新会话并明确告知。

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
| `acp_chat_close` | 释放会话进程(记录保留,可再连) |

## 配置(cordis.patch.yml)

```yaml
- insert:
    - id: subagent-acp-resume
      name: 'dsh-acp-resume'
      config:
        providerName: acp-resume     # 不与官方 acp 冲突
        command: /path/to/agent-cli
        args: [acp]
        permission: allow             # 同官方语义:allow / reject
        idleTimeoutMs: 600000         # 空闲释放窗口
        # registryPath: 自定义会话注册表路径(默认 $DSH_HOME/storages/acp-resume/registry.json)
```

## 开发

```sh
pnpm install && pnpm build     # 构建 lib/
pnpm test                      # vitest;42 个协议面用例为回归门
```

- 基线:源码复制自 `@deepseek-ai/dsh-subagent-acp@0.2.1-rc.5`,peer 钉 `~0.2.1-rc.5`;
- 测试豁免:真实子进程类 25 例依赖 npm 分发包不包含的内部模块,由官方仓库覆盖(见 DECISIONS D8);
- 参考用官方源码 checkout:分支 `my-subagent-acp` @ `dsh-v0.2.1-rc.5`(只读对照)。

## License

MIT

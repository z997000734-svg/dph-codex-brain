# DPH Codex Brain 接入分析

实施与验收结果见 [交付说明](CODEX-BRAIN-DELIVERY.md)。

本机项目为 `D:\deepseek-harness`，运行入口是 `dsh --profile web`，本机数据目录为 `.local/data`。本次接入官方 Codex CLI，不读取认证文件、不修改 Codex 用户配置。

## 当前架构与接入位置

- `packages/llm/llm` 提供 `LlmAdapter`、结构化内容和工具调用协议；新 Provider 注册到现有模型注册表。
- `packages/core/agent-loop` 负责模型请求、工具执行和后续步骤；Codex 返回工具调用后仍由 DPH 执行，保留审批与会话记录。
- `packages/subprocess/subprocess` 和 `subprocess-local` 已支持独立子进程、环境脱敏和按进程树取消。
- `packages/settings/settings` 与文件 Provider 负责配置持久化。
- `packages/client/ui-settings-models` 提供模型设置和插件扩展位置。
- `packages/bundle/base` 和 `web-app` 负责实际启动时加载插件。

## 实施方案

新增 `packages/llm/llm-codex`：通过 `codex exec --json --output-schema` 获取回答或 DPH 工具请求。每次调用使用独立临时目录、只读沙箱和独立会话；传入 DPH 已记录的上下文，禁用 Codex 自带工具与扩展，工具权限由 DPH 负责。官方 CLI 保留现有登录位置，DPH 不复制或解析 OAuth 凭据。

同一 Provider 的模型请求使用单并发队列；支持取消、30 分钟执行超时、暂停和有限日志。已有 DPH 会话保存用户任务及工具结果。队列记录区分已完成、失败、取消、超时和重启中断，避免把中断任务误报完成。涉及完整用户任务串行化的接入点需结合 agent 生命周期验证，不能仅把请求队列等同于整轮任务锁。

前端增加 Codex 管理入口：检测、连接测试、配置、暂停、队列与取消。模型通过原有选择器选择。配置不提供 API Key、Cookie 或 OAuth Token 输入。

## 文件、数据和接口

新增 Provider 源码、测试、README、决策记录和前端管理组件；更新 workspace 编译映射、bundle 依赖与插件装配。复用现有设置、会话和子进程服务，不改写 Agent 主循环，不新增业务数据库表。管理操作通过已有鉴权 RPC 通道导出。

已有未提交修改涉及 web-app 启动、聊天界面与 Windows 子进程模块；本次保留这些修改，不覆盖或回退。

## 验证与风险

验证真实 CLI 认证与极小请求、DPH 工具闭环、请求并发上限、排队取消、超时清理、错误分类、脱敏和插件卸载。CLI 参数按本机 `0.153.1` 验证；不支持的版本明确报错。不同进程不会阻止用户同时修改同一项目，DPH 内部锁不能约束外部编辑器。Codex 结构化输出经校验后才能转成 DPH 工具调用，禁止把返回文本当 shell 命令执行。

官方依据：[非交互调用](https://learn.chatgpt.com/docs/non-interactive-mode)、[配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。

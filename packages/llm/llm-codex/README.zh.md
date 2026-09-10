---
description: "本机 Codex CLI 的配置、请求归属和工具调用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-codex

[English](README.md) | 中文

## 概述

通过本机官方 Codex CLI 提供 `codex` LLM 路由。CLI 负责 ChatGPT 认证；Harness 提供对话上下文、执行请求的工具并记录对话。已在 Windows 上使用 Codex CLI 0.153.1 验证。

## 使用此包

基础组合加载此插件，默认关闭。在设置 → Codex 大脑中启用，填写程序路径，保存、检测安装、测试连接，再设为默认大脑。需要认证时在终端运行 `codex login`。代理地址可选；留空时继承进程环境。

每次请求在私有临时目录中使用 `codex exec --json --output-schema`。它忽略用户配置、关闭原生工具并使用只读沙箱。持久化用户图片会转换为面积不超过 2048×2048、最大一兆字节的请求版本，再通过 `--image` 传入；所属进程退出后删除这些私有文件。通过官方认证机制复用登录，不读取或复制凭据。子进程环境移除 `OPENAI_API_KEY` 和 `CODEX_API_KEY`。不修改全局 Codex 设置或手动 Codex 会话。

## 配置

设置命名空间：`llm-codex`。默认值：`enabled=false`、`command=codex`、`model=default`、`proxyUrl=""`、`timeoutSeconds=1800`、`graceMs=3000`、`maxOutputBytes=2097152`、`maxQueueSize=100`、`retainedTasks=100`。字节限制同时约束序列化输入和 JSONL 输出。由于忽略用户配置，`default` 选择官方 CLI 的默认模型。

每个 Harness 进程同时运行一个 CLI 请求，其余请求先进先出等待。暂停阻止新的执行；取消和超时仅终止所持有的进程树。遇到限流会暂停队列，不自动重试。重启将未完成条目标记为中断；用户手动继续原 Harness 对话。元数据保存在 `$DSH_HOME/brains/codex/tasks.json`，不包含提示词、图片字节或原始凭据。每个请求最多保留 20 张图片和 20 MiB 转换后图片；历史累计超过任一限制时，较早的图片出现位置会变成明确的文字占位符。

## 模型体验

### 每次 CLI 请求

#### 模型看到什么

以下桥接指令位于 JSON 之前，JSON 包含 Harness 指令、消息和工具定义。每个图片块标明对应的一基 CLI 图片序号、持久附件标识、规范化请求媒体类型与尺寸。结构化结果携带回复文本和工具调用；Harness 先验证工具名称和参数对象，再通过普通工具循环执行。

##### 桥接指令

```markdown
You are the reasoning provider for DeepSeek Harness. The JSON request contains its system instructions, conversation and available tools. Continue that conversation. Images attached to this CLI prompt are numbered from 1; JSON image blocks preserve the owning message and name the matching image number. Return only the required JSON response. To use a tool, return its name and JSON-encoded arguments in toolCalls; Harness executes it and supplies the result in the next request. Do not execute tools yourself. Do not claim a requested tool has run until its result is present. Use text for your response and an empty toolCalls array when finished.
```

#### Token 影响

每个请求包含保留的对话上下文、工具 schema、桥接指令和保留的图片输入。CLI 用量按互不重叠的输入、缓存读取和输出类别报告。此适配器不报告金额或剩余订阅额度。

#### KV Cache 影响

每轮工具调用开启独立的临时 CLI 请求。提供方可能复用稳定前缀，但不保证缓存复用。修改指令、工具、保留历史、保留图片或模型可能改变此前请求的 token。

## 已知限制与延后工作

- 支持用户消息中的 PNG、JPEG、WebP 和 GIF 图片。助手或工具结果历史中的图片，以及不支持的温度、输出 token 上限、停止控制会明确失败。输出在完整 JSON 验证后交付，因此不是逐 token 流式输出。
- 一个执行槽覆盖一次模型请求，不覆盖整段多轮对话；不同对话可在请求之间交替执行。多个 Harness 主机进程具有独立队列，不应共享同一数据目录。中断请求不自动重放。
- CLI 升级可能需要更新参数或事件解析器。订阅限制与用户其他 Codex 客户端共享，不通过 token 数推算剩余额度。

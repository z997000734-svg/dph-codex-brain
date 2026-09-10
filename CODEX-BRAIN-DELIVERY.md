# DPH Codex 大脑交付说明

2026-09-09。本机项目：`D:\deepseek-harness`。

## 已交付并启用

DPH 已接入本机官方 Codex CLI，已通过 ChatGPT 登录检测和真实连接测试，并设为新对话的默认大脑。服务入口：[打开 DPH](http://127.0.0.1:3080/)。在“设置 → Codex 大脑”管理配置、检测安装、测试连接、暂停队列及取消请求。

新增 `packages/llm/llm-codex`，通过官方 `codex exec --json --output-schema` 返回回复或工具调用。DPH 保留原有工具执行、权限处理和对话记录。官方 CLI 负责认证；接入代码不读取或复制 Cookie、OAuth Token、密码，也不修改 Codex 全局配置。手动 Codex 会话不被复用或终止。

默认同时执行一个 CLI 请求；多余请求排队。提供 30 分钟执行超时、取消、限流暂停和重启中断状态。队列元数据保存在 `.local/data/brains/codex/tasks.json`，不保存原始提示词。配置使用已有 DPH 设置服务持久化。

本机使用 Codex CLI 0.153.1，程序路径为 `C:\Users\Administrator\AppData\Local\OpenAI\Codex\bin\1e3e57cdf0634c02\codex.exe`，代理为 `http://127.0.0.1:7897`。CLI 更新后若路径失效，在设置中更新路径。代理必须保持可用；此前未显式设置代理的真实调用出现连接超时。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 完整构建 | 通过，生成 220 个客户端产物 |
| 前后端 TypeScript 检查 | 通过 |
| Codex 协议、队列、管理状态及样式专项 | 28 项通过，默认跳过需显式启用的真实账号测试 |
| 真实官方 CLI 测试 | 已单独启用并通过；网页连接测试也返回 OK |
| 真实图片输入验收 | 已通过；网页粘贴图片后 `gpt-5.6-sol` 正确识别框选模型为 `GPT-5.6 Sol`，请求结束后私有图片临时目录为 0 |
| 实际 Loader 组合测试 | 通过，验证配置启用、默认大脑选择及关闭 |
| 完整 GUI 回归 | 284 个测试文件通过，3927 项通过、1 项跳过 |
| 设置页与 Codex 网页回放 | 3 个测试文件、23 项通过；6 份快照仅新增 Codex 菜单项 |
| 中文界面文案、Agent Note、README 模型体验与限制、中英配对 | 通过 |
| `git diff --check` | 通过 |

真实网页验收创建了独立对话，要求读取 `.local/codex-smoke.txt`。Codex 发出一个文件读取工具调用，DPH 执行后通过第二次模型请求获得 `DPH_CODEX_TOOL_ROUNDTRIP_0909_C74B`。界面显示一次工具调用、两步模型请求；服务重启后对话仍可打开。图片验收通过网页粘贴用户提供的截图，DPH 将请求版本经 CLI `--image` 传给 `gpt-5.6-sol`，模型返回 `VISION_RESULT=GPT-5.6 Sol`。验收截图见 [设置页](.local/codex-ui.png)、[真实工具调用](.local/codex-chat.png) 和 [真实图片识别](.local/codex-image-verified.png)。

全量 `DSH_SNAPSHOT=replay` 网页回放未通过。单独复现的 `chat-scroll-contract.e2e.ts` 在已有 `scaffold.ts:988` 因 Windows 路径直接插入 JSON 而报 `Bad escaped character in JSON`，发生在 Codex 未启用的场景。全量运行在确认该问题后停止。因此不声称全部网页快照通过。受本次变更影响的设置页快照已通过测试生成器刷新，检查差异后重新回放，23 项通过。另一次测试归属错误产生的临时编译文件已清理，主机/前端测试归属已修正，类型检查重新通过。

## 当前边界

- 串行单位是一次模型请求，整段多轮对话并不独占执行槽。不同对话可在工具轮次之间交替执行，避免父智能体等待子智能体时占住唯一执行槽。
- 支持用户消息中的 PNG、JPEG、WebP 和 GIF 图片。每个请求最多保留 20 张、共 20 MiB 的请求图片；单张会转换为面积不超过 2048×2048、最大 1 MiB 的版本。非用户消息中的图片和不支持的生成参数会明确报错。完整 JSON 校验后返回输出，目前不是逐 token 流式展示。
- 重启后的未完成请求标记为中断，不自动重放；回到原对话继续即可。
- 并发限制只覆盖当前 DPH 主机进程。不要启动多个共享同一数据目录的 DPH 服务。
- 与手动 Codex 共享账号用量，不提供剩余 Pro 额度或金额估算。官方客户端控制登录与套餐访问。

本机已有的 `dsh-balance-sidebar` 插件曾将 Codex token 按 DeepSeek 价格计算。本次在其本地插件副本和安装副本中排除了 `provider=codex`，重启后验证误计价消失。这两个文件位于忽略版本控制的 `.local/data/profiles/web` 下；以后重装该自定义插件需保留此过滤条件。

## 代码与维护入口

接入说明：[llm-codex 中文 README](packages/llm/llm-codex/README.zh.md)。决策记录：[Codex 大脑 Agent Note](.agents/notes/implemented/feature/2026-09-09-codex-brain.zh.md)。原有未提交的聊天、启动与 Windows 子进程修改均保留；本次未提交 Git commit。

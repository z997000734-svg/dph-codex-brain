---
description: "Local Codex CLI configuration, request ownership and tool routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-codex

English | [中文](README.zh.md)

## Summary

Provides the `codex` LLM route through the installed official Codex CLI. The CLI owns ChatGPT authentication; Harness supplies conversation context, executes requested tools and records the conversation. Tested with Codex CLI 0.153.1 on Windows.

## Use this package

The base bundle mounts the plugin disabled. In Settings → Codex Brain, enable it, enter the executable path, save, detect installation, test the connection and set it as the default brain. Run `codex login` in a terminal when authentication is required. A proxy URL is optional; leave it empty to inherit the process environment.

Each request uses `codex exec --json --output-schema` in a private temporary directory. It ignores user configuration, disables native tools and uses read-only sandboxing. Durable user images are projected to at most 2048×2048-area, one-megabyte request versions and passed with `--image`; these private files are removed after the owned process exits. It reuses official authentication without reading or copying credentials. `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the child environment. Global Codex settings and manual Codex sessions are not modified.

## Configuration

Settings namespace: `llm-codex`. Defaults: `enabled=false`, `command=codex`, `model=default`, `proxyUrl=""`, `timeoutSeconds=1800`, `graceMs=3000`, `maxOutputBytes=2097152`, `maxQueueSize=100`, `retainedTasks=100`. The byte limit bounds both serialized input and JSONL output. `default` selects the official CLI default model because user config is ignored.

One CLI request runs at a time per Harness process. Additional requests wait in FIFO order. Pause stops new execution; cancel and timeout terminate only the owned process tree. Rate limits pause the queue without automatic retries. Restart marks unfinished entries interrupted; users continue the original Harness conversation manually. Metadata is saved under `$DSH_HOME/brains/codex/tasks.json`, without prompts, image bytes or raw credentials. A request retains at most 20 images and 20 MiB of projected image bytes; older image occurrences become explicit text placeholders when the accumulated history exceeds either bound.

## Model Experience

### Each CLI request

#### What the model sees

The bridge instruction below precedes JSON containing the Harness instructions, messages and tool definitions. Each image block names the matching one-based CLI image index, durable attachment identity, normalized request media type and dimensions. Structured results carry response text and tool calls; Harness validates tool names and argument objects before its ordinary tool loop executes them.

##### Bridge instruction

```markdown
You are the reasoning provider for DeepSeek Harness. The JSON request contains its system instructions, conversation and available tools. Continue that conversation. Images attached to this CLI prompt are numbered from 1; JSON image blocks preserve the owning message and name the matching image number. Return only the required JSON response. To use a tool, return its name and JSON-encoded arguments in toolCalls; Harness executes it and supplies the result in the next request. Do not execute tools yourself. Do not claim a requested tool has run until its result is present. Use text for your response and an empty toolCalls array when finished.
```

#### Token effect

Each request includes retained conversation context, tool schemas, the bridge instruction and the retained image inputs. CLI usage is reported with disjoint input, cache-read and output buckets. This adapter does not report monetary prices or remaining subscription quota.

#### KV Cache effect

Every tool round starts an independent ephemeral CLI request. Stable prefixes may be reusable by the provider, but no cache reuse is promised. Changing instructions, tools, retained history, retained images or model can change earlier request tokens.

## Known Limitations and Deferred Work

- User-message PNG, JPEG, WebP and GIF images are supported. Images in assistant or tool-result history and unsupported temperature, output-token and stop controls fail explicitly. Output is delivered after complete JSON validation, so it is not token streaming.
- One slot covers a model request, not an entire multi-round conversation; different conversations may interleave between requests. Multiple Harness host processes have independent queues and must not share the same data directory. Interrupted requests are not automatically replayed.
- CLI upgrades may require argument or event-parser updates. Subscription limits are shared with the user's other Codex clients, and their remaining quota is not inferred from token counts.

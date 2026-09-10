# Agent Note: Codex CLI as a Harness reasoning provider

Status: implemented

English | [中文](2026-09-09-codex-brain.zh.md)

## Problem

A user with an existing local ChatGPT-authenticated Codex installation needs to use it for ordinary Harness conversations while continuing manual Codex work.

## Decision

The `llm-codex` plugin exposes a normal LLM adapter and an authenticated management service. Official CLI execution owns authentication. A strict JSON response carries text and requested Harness tool calls; the existing Harness loop executes the tools and records results. The settings page manages configuration, installation detection, connection tests, default selection and the single-request FIFO queue.

The CLI runs in an ephemeral private directory with user configuration ignored and native tools disabled. Durable user images are resolved through the attachment service, projected to bounded request versions, materialized under that directory and attached by index with the official `--image` argument. The JSON history preserves each image's owning user message. Image files are removed after the owned process exits; prompts, image bytes and paths are absent from queue metadata. Cancellation targets only its owned process tree. Queue metadata is durable; unfinished records become interrupted after restart. No tokens, cookies or passwords are read or copied by the adapter. This addition does not replace the existing Codex subagent backend.

## Alternatives considered

**Calling private endpoints using copied OAuth credentials.** Rejected because authentication and account access must remain with the official client.

**Delegating the entire conversation to the existing Codex subagent backend.** It would make Codex execute its own tools and would bypass the normal Harness conversation/tool loop required here.

**Holding the queue slot for a complete Harness turn.** A parent waiting for a nested agent could retain the only slot the child needs. Per-request serialization avoids this deadlock and allows conversations to interleave between tool rounds.

## Consequences

The user keeps manual Codex sessions and a shared subscription login. The adapter adds full-context serialization, retained image input and per-request process startup latency. It emits completed validated responses rather than token streaming. Image history is bounded; older occurrences become text placeholders, and non-user image history fails explicitly. Independent host processes do not coordinate queues. No remaining-quota or monetary estimate is exposed. The protocol and process tests cover malformed output, FIFO execution, image projection and cleanup, cancellation, timeout, rate-limit pause and unrelated-process survival; an opt-in official CLI test checks real authentication and response transport. Browser acceptance exercises the shipped composition, a real read-tool round trip and a real image request.

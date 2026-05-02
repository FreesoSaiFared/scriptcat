# ScriptCat Agent Provider Call Path Map

Branch: `friso/webagent-provider-v1.5`
Baseline: `friso/webagent-v1.5` / release `v1.5` chassis
Date: 2026-05-02

## Files inspected

### Core provider and model types
- `src/app/service/agent/core/types.ts`
  - Defines `AgentModelConfig`, `AgentModelSafeConfig`, `ChatRequest`, `ChatStreamEvent`, `LLMStreamEvent`, `ConversationApiRequest`, and CAT.agent API types.
  - Current provider union is `"openai" | "anthropic" | "zhipu"`; this is the narrowest type insertion point for `"webagent"`.
- `src/app/service/agent/core/providers/types.ts`
  - Defines `LLMProvider`, `ProviderBuildRequestInput`, and `ProviderStreamEventHandler`.
  - Existing provider abstraction assumes HTTP request construction plus SSE parsing.
- `src/app/service/agent/core/providers/registry.ts`
  - Creates singleton `providerRegistry` and registers OpenAI, Anthropic, and Zhipu providers.
  - Safest place to register a WebAgent provider after adding a compatible implementation.
- `src/app/service/agent/core/providers/openai.ts`
  - OpenAI-compatible request builder and stream parser; `apiKey` is optional for Authorization header.
- `src/app/service/agent/core/providers/anthropic.ts`
  - Anthropic request builder and stream parser; always sends `x-api-key` today.
- `src/app/service/agent/core/providers/index.ts`
  - Re-exports `providerRegistry` so consumers trigger built-in provider registration.

### LLM call path and Agent service APIs
- `src/app/service/agent/service_worker/llm_client.ts`
  - `LLMClient.callLLM()` resolves attachments, gets `providerRegistry.get(model.provider)`, calls `provider.buildRequest()`, fetches `url`, then passes `response.body.getReader()` to `provider.parseStream()`.
  - This is the core runtime insertion point. Current shape is HTTP/SSE-first, so WebAgent needs either a compatible local stream adapter or an extension to provider interface.
- `src/app/service/agent/service_worker/tool_loop_orchestrator.ts`
  - `callLLMWithToolLoop()` calls injected `callLLM()`, accumulates usage, handles tool calls, persists assistant/tool messages, and emits final `done`.
  - WebAgent provider should emit the same `ChatStreamEvent` stream and return the same `LLMCallResult` fields.
- `src/app/service/agent/service_worker/chat_service.ts`
  - `handleConversationChat()` handles UI and userscript streaming chat, creates per-session tool registries, fetches the selected model, and invokes `callLLMWithToolLoop()`.
  - `handleEphemeralChat()` is important for CAT.agent userscripts because it can run without persisted conversation state and only exposes script-supplied tools.
- `src/app/service/agent/service_worker/agent.ts`
  - Wires `AgentModelService`, `LLMClient`, `ToolLoopOrchestrator`, `ChatService`, DOM tools, MCP tools, OPFS tools, task tools, and GM API handlers.
  - `handleConversationApi()`, `handleConversationChatFromGmApi()`, `handleModelApi()`, and `handleAttachToConversationFromGmApi()` are the public service-worker entry points for CAT.agent.
- `src/app/service/service_worker/index.ts`
  - Instantiates `AgentService`, calls `agent.init()`, and injects it into GMApi with `gmApi.setAgentService(agent)`.

### Model persistence and CAT.agent.model exposure
- `src/app/repo/agent_model.ts`
  - Persists `AgentModelConfig` under `chrome.storage.local` using `agent_model:` keys.
- `src/app/service/agent/service_worker/model_service.ts`
  - Registers service-worker messages: `listModels`, `getModel`, `saveModel`, `removeModel`, defaults, and summary model IDs.
  - `stripApiKey()` removes `apiKey` before exposing models to userscripts.
  - `handleModelApi()` backs CAT.agent.model list/get/default/summary.
- `src/app/service/service_worker/gm_api/gm_agent_model.ts`
  - Registers `CAT_agentModel` through PermissionVerify and delegates to `AgentService.handleModelApi()`.
- `src/app/service/content/gm_api/cat_agent_model.ts`
  - Userscript-side `CAT.agent.model.list/get/getDefault/getSummary`; calls service worker and receives `AgentModelSafeConfig` without `apiKey`.
- `src/app/service/content/gm_api/cat_agent.ts`
  - Userscript-side `CAT.agent.conversation` and streaming conversation wrapper.
  - Supports ephemeral conversations, custom tools, command handlers, background runs, and stream chunks.

### Options UI provider/model management
- `src/pages/options/routes/AgentProvider.tsx`
  - UI CRUD for model configs.
  - Current provider select only offers OpenAI, Anthropic, Zhipu.
  - Current modal always shows API Base URL and API Key fields and has fetch/test buttons that assume remote API endpoints.
  - Save validation requires `name` and `model`, not `apiKey`, so WebAgent can remain keyless with small UI branching.
- `src/pages/options/routes/AgentSettings.tsx`
  - Lets users choose summary model; consumes model list generically.
- `src/pages/options/routes/AgentChat/index.tsx`
  - Loads models/default model via `agentClient`; passes selected model to `ChatArea`.
- `src/pages/options/routes/AgentChat/model_utils.ts`
  - Infers provider label/icon grouping from model id/base URL and falls back to provider field.
  - Needs a direct `webagent` branch for a clear label/order.
- `src/pages/options/routes/AgentChat/ProviderIcon.tsx`
  - Defines provider icons/text badges. Needs a WebAgent text badge.
- `src/pages/store/features/script.ts`
  - Exposes `agentClient`, a service-worker client used by options UI.

### Extension build output
- `rspack.config.ts`
  - Production build writes bundled extension to `dist/ext` with JS/CSS under `dist/ext/src` and manifest copied to `dist/ext/manifest.json`.
- `src/manifest.json`
  - Manifest version is 3.

## Call graph summary

```text
Options UI / userscript
  -> agentClient or CAT.agent.conversation / CAT.agent.model
  -> service worker message group "agent" or GM API PermissionVerify bridge
  -> AgentService
  -> ChatService.handleConversationChat()
  -> AgentModelService.getModel()
  -> ToolLoopOrchestrator.callLLMWithToolLoop()
  -> LLMClient.callLLM()
  -> providerRegistry.get(model.provider)
  -> LLMProvider.buildRequest()
  -> fetch(url, init)
  -> LLMProvider.parseStream(reader, onEvent, signal)
  -> ChatStreamEvent content/tool/done/error events
  -> ToolLoopOrchestrator persists assistant/tool messages and emits final done
```

## Safest insertion points

1. `src/app/service/agent/core/types.ts`
   - Add `"webagent"` to `AgentModelConfig.provider`.
   - Add optional `webagent` config fields: `target`, `transport`, and optional mock response text.
   - Keep `apiKey` present for compatibility but not semantically required for WebAgent.
2. New module under `src/app/service/agent/core/providers/webagent/`
   - Define driver contract: `health()`, `ensureTab()`, `sendMessage()`, `abort()`, `readConversation()`.
   - Implement a mock/local driver for tests.
   - Adapt driver output into `ChatStreamEvent` without site-specific selectors in core.
3. `src/app/service/agent/core/providers/registry.ts`
   - Register `webagentProvider` alongside existing built-ins.
4. `src/app/service/agent/service_worker/llm_client.ts`
   - Current provider interface is HTTP/SSE. Smallest compatible seam is a local `ReadableStream` adapter returned by WebAgent provider's `buildRequest()` plus special local fetch handling, or a provider interface extension for direct execution.
   - Lower-risk first slice: add an optional direct `execute()` method to `LLMProvider`; `LLMClient` uses it when present and otherwise keeps existing HTTP path untouched.
5. `src/pages/options/routes/AgentProvider.tsx` and model UI utilities
   - Add WebAgent option and hide/disable API-key/fetch/test-API behavior for WebAgent.
   - Keep model field as the target selector (`chatgpt`, `gemini`, `claude`) for the first minimal UI slice, or add target/transport fields if small enough.

## Risks

- The current `LLMProvider` interface assumes HTTP request + readable SSE stream. Forcing WebAgent through fake URLs/fetch would be brittle; a direct provider execution hook is cleaner but touches a core interface.
- `AgentModelConfig.apiKey` is required by type today. Making it optional broadly could ripple through existing tests. Safer first slice: leave `apiKey: string` for compatibility, but ensure WebAgent UI/config uses an empty string and never requires it.
- Full browser automation requires target-specific DOM/CDP/local bridge details. Those must remain in userscripts/content scripts/driver modules, not provider core.
- Existing provider tests should not become dependent on WebAgent runtime/browser state.

## First implementation slice

- Add WebAgent config fields and provider union support.
- Add WebAgent driver contract and mock driver under provider-core code.
- Extend `LLMProvider` with optional direct execution so WebAgent can stream without API keys or HTTP fetch.
- Register `webagentProvider`.
- Add tests for:
  - WebAgent provider registration.
  - WebAgent mock driver streaming `content_delta` + `done` events.
  - WebAgent config works with blank `apiKey`.
  - Existing OpenAI/Anthropic/Zhipu provider structure remains registered and compatible.
- Add minimal UI recognition: WebAgent provider option, WebAgent label/icon, and API-key-free save path.

# WebAgent Provider Implementation Notes

Branch: `friso/webagent-provider-v1.5`
Baseline chassis: ScriptCat `release/v1.5` via `friso/webagent-v1.5`
Date: 2026-05-02

## Slice delivered

This slice establishes the smallest useful browser-session WebAgent seam without automating ChatGPT/Gemini/Claude yet.

Implemented provider shape:

```ts
provider: "webagent"
target: "chatgpt" | "gemini" | "claude"
transport: "tab-dom" | "cdp" | "local-bridge"
```

Driver contract added in `src/app/service/agent/core/providers/webagent.ts`:

- `health()`
- `ensureTab()`
- `sendMessage()`
- `abort()`
- `readConversation()`

The included `MockWebAgentDriver` is intentionally local/test-safe. It proves the provider seam and streaming adapter without requiring real website sessions, API keys, or secrets.

## Runtime approach

Existing API providers still use the established `buildRequest()` + `fetch()` + `parseStream()` path.

WebAgent uses a new optional `LLMProvider.execute()` hook. When a provider exposes `execute()`, `LLMClient.callLLM()` uses it directly and expects the same `ChatStreamEvent` stream emitted by HTTP/SSE providers. This avoids pretending browser tabs are API endpoints and keeps API-key providers as optional compatibility providers.

## Files changed for the provider seam

- `src/app/service/agent/core/types.ts`
  - Adds `AgentModelProvider`, `WebAgentTarget`, and `WebAgentTransport`.
  - Extends `AgentModelConfig.provider` to include `"webagent"`.
  - Adds optional WebAgent fields: `target`, `transport`, `mockResponse`.
- `src/app/service/agent/core/providers/types.ts`
  - Adds optional `LLMProvider.execute()` for direct non-HTTP providers.
- `src/app/service/agent/core/providers/webagent.ts`
  - Adds WebAgent driver contract, config normalization, mock driver, and provider implementation.
- `src/app/service/agent/core/providers/registry.ts`
  - Registers `webagentProvider` alongside OpenAI, Anthropic, and Zhipu.
- `src/app/service/agent/service_worker/llm_client.ts`
  - Dispatches to `provider.execute()` when available; otherwise preserves existing fetch/parse behavior.
- `src/pages/options/routes/AgentProvider.tsx`
  - Adds WebAgent provider option with target/transport fields.
  - Hides API base URL, API key, model fetch, and API test controls for WebAgent.
  - Saves WebAgent configs keyless with model equal to target.
- `src/pages/options/routes/AgentChat/model_utils.ts`
  - Detects WebAgent as a first-class provider label/group.
- `src/pages/options/routes/AgentChat/ProviderIcon.tsx`
  - Adds a compact `WA` badge.
- `src/types/scriptcat.d.ts`
- `src/types/scriptcat.zh-CN.d.ts`
  - Exposes WebAgent-safe provider/target/transport fields in CAT.agent model summaries.

## Tests added

- `src/app/service/agent/core/providers/webagent.test.ts`
  - keyless config normalization
  - mock driver health/tab/send/abort/read contract
  - direct stream emission through provider execution
- `src/app/service/agent/core/providers/registry.test.ts`
  - built-in registry includes `webagent` and existing compatibility providers
- `src/app/service/agent/service_worker/llm.test.ts`
  - WebAgent direct execution does not call `fetch` or require `apiKey`
  - existing OpenAI/Anthropic/error/retry/tool-loop structure remains covered by existing tests
- `src/pages/options/routes/AgentChat/model_utils.test.ts`
  - provider detection recognizes WebAgent

## Validation for this slice

- `timeout 180 pnpm typecheck` -> exit 0
- `timeout 120 pnpm test src/app/service/agent/core/providers/webagent.test.ts src/app/service/agent/core/providers/registry.test.ts src/app/service/agent/service_worker/llm.test.ts src/pages/options/routes/AgentChat/model_utils.test.ts` -> exit 0, 4 files / 38 tests passed
- `timeout 180 pnpm lint` -> exit 0 with pre-existing warnings

Logs:

- `../../artifacts/webagent-provider-map/typecheck-webagent-contract.log`
- `../../artifacts/webagent-provider-map/tdd-green-targeted-rerun.log`
- `../../artifacts/webagent-provider-map/lint-webagent-contract.log`

## Design boundaries preserved

- WebAgent is keyless by default; API keys are not required for browser-session configs.
- API providers remain intact and optional.
- Website-specific selectors are not in extension core.
- Future ChatGPT/Gemini/Claude automation should live in drivers/userscripts/content scripts/CDP/local bridge layers behind the driver contract.
- Local filesystem, shell, repo analysis, Desktop Commander, Anything Analyzer, and MCP Super Assistant belong behind MCP/local bridge layers, not inside provider core.

## Next implementation step

Replace or augment `MockWebAgentDriver` with target-specific drivers:

1. `tab-dom` driver: message a ScriptCat userscript/content script in an already logged-in tab.
2. `cdp` driver: use extension-owned `chrome.debugger`/CDP capability where permission and UX allow it.
3. `local-bridge` driver: call a local MCP/bridge process for Playwriter/MCP/Desktop Commander integration.

Each real driver should adapt back to the same `ChatStreamEvent` stream and keep selectors in driver/userscript modules.

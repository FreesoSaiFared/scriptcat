# Ralph WebAgent Provider Run Report

Date: 2026-05-02
Repo: `/home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat`

## Branches

- Baseline branch: `friso/webagent-v1.5`
- Implementation branch: `friso/webagent-provider-v1.5`
- Baseline commit: `1c2b2f95577dc47e1451216e51770cc92b48649a`
- Current HEAD: `09c3345cf59d3836b85b8fe43d0b51363a6815ba`

## GitHub branch URLs

- Baseline: https://github.com/FreesoSaiFared/scriptcat/tree/friso/webagent-v1.5
- Implementation: https://github.com/FreesoSaiFared/scriptcat/tree/friso/webagent-provider-v1.5

## Commits made on implementation branch

- 6677d298 docs: map scriptcat agent provider path
- 9b407df5 feat: add webagent provider contract
- 09c3345c docs: record webagent provider implementation notes

## Pushes completed

- Pushed `friso/webagent-v1.5` to `friso` remote: `https://github.com/FreesoSaiFared/scriptcat.git`.
- Pushed `friso/webagent-provider-v1.5` after provider-path mapping.
- Pushed `friso/webagent-provider-v1.5` after provider contract commit.
- Pushed `friso/webagent-provider-v1.5` after implementation-notes commit.

## Files changed from baseline

- docs/webagent/IMPLEMENTATION_NOTES.md
- docs/webagent/PROVIDER_CALL_PATH.md
- src/app/service/agent/core/providers/registry.test.ts
- src/app/service/agent/core/providers/registry.ts
- src/app/service/agent/core/providers/types.ts
- src/app/service/agent/core/providers/webagent.test.ts
- src/app/service/agent/core/providers/webagent.ts
- src/app/service/agent/core/types.ts
- src/app/service/agent/service_worker/llm.test.ts
- src/app/service/agent/service_worker/llm_client.ts
- src/pages/options/routes/AgentChat/ProviderIcon.tsx
- src/pages/options/routes/AgentChat/model_utils.test.ts
- src/pages/options/routes/AgentChat/model_utils.ts
- src/pages/options/routes/AgentProvider.tsx
- src/types/scriptcat.d.ts
- src/types/scriptcat.zh-CN.d.ts

External artifacts written:

- `../../artifacts/webagent-provider-map/PROVIDER_CALL_PATH.md`
- `../../artifacts/webagent-provider-map/IMPLEMENTATION_NOTES.md`
- `../../artifacts/webagent-provider-map/RALPH_RUN_REPORT.md`
- `../../artifacts/extension-install/INSTALL_SCRIPT_CAT_WEBAGENT.md`

## Implementation summary

- Added `provider: "webagent"` to Agent model config while preserving OpenAI/Anthropic/Zhipu providers as optional compatibility providers.
- Added `target: "chatgpt" | "gemini" | "claude"` and `transport: "tab-dom" | "cdp" | "local-bridge"` fields for browser-session WebAgent configs.
- Added a WebAgent driver contract with `health()`, `ensureTab()`, `sendMessage()`, `abort()`, and `readConversation()`.
- Added a mock driver so unit tests can prove streaming behavior without real site automation or API keys.
- Added optional `LLMProvider.execute()` so direct browser-session providers can emit the same `ChatStreamEvent` stream without fake HTTP endpoints.
- Updated Agent provider UI/config so WebAgent models do not require API Base URL or API Key.
- Kept real ChatGPT/Gemini/Claude selectors out of extension core.

## Validation results

- `timeout 180 pnpm typecheck` -> exit 0.
- `timeout 120 pnpm test src/app/service/agent/core/providers/webagent.test.ts src/app/service/agent/core/providers/registry.test.ts src/app/service/agent/service_worker/llm.test.ts src/pages/options/routes/AgentChat/model_utils.test.ts` -> exit 0, 4 files / 38 tests passed.
- `timeout 180 pnpm lint` -> exit 0 with 29 pre-existing warnings.
- `timeout 240 pnpm test` -> exit 0, 105 files / 1844 tests passed.
- `timeout 240 pnpm build` -> exit 0, Rspack compiled with 5 warnings.

Validation logs:

- `../../artifacts/webagent-provider-map/typecheck-webagent-contract.log`
- `../../artifacts/webagent-provider-map/tdd-green-targeted-rerun.log`
- `../../artifacts/webagent-provider-map/lint-webagent-contract.log`
- `../../artifacts/webagent-provider-map/full-typecheck.log`
- `../../artifacts/webagent-provider-map/full-test.log`
- `../../artifacts/webagent-provider-map/full-build.log`

## Extension build path

Unpacked extension directory:

```text
/home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat/dist/ext
```

Manifest:

- Path: `/home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat/dist/ext/manifest.json`
- `manifest_version`: `3`
- Version: `1.4.0.1200`

## Install readiness

Friso can install now. The production build passed and `/home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat/dist/ext/manifest.json` exists.

## Risks and follow-ups

- Real ChatGPT/Gemini/Claude browser automation is not implemented yet; this is the provider seam.
- The mock driver is intentionally local/test-only.
- CDP/local bridge drivers need explicit UX/permission handling before real automation.
- Keep site selectors in drivers/userscripts/content scripts, not extension core.

## Exact next prompt for post-install browser validation

```text
$ralph
Use Playwriter/MCP to validate the locally loaded ScriptCat WebAgent MV3 build. Verify Chrome Canary has ScriptCat enabled from /home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat/dist/ext, open the ScriptCat options page, confirm the Agent provider settings show WebAgent as a keyless provider with ChatGPT/Gemini/Claude targets and tab-dom/cdp/local-bridge transports, create or inspect a keyless WebAgent ChatGPT/tab-dom model if safe, collect screenshots/logs under ../../artifacts/extension-install/, and report any extension console errors. Do not require API keys and do not automate real ChatGPT/Gemini/Claude yet.
```

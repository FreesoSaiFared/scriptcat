# Install ScriptCat WebAgent Build

Date: 2026-05-02
Branch: `friso/webagent-provider-v1.5`
Build commit: `09c3345cf59d3836b85b8fe43d0b51363a6815ba`
Manifest version: MV3
Extension version: `1.4.0.1200`

## Load this unpacked extension

Local unpacked-extension directory:

```text
/home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat/dist/ext
```

The directory exists and contains `manifest.json` plus bundled extension assets. The manifest is Chrome MV3-compatible (`manifest_version: 3`).

## Browser recommendation

Use **Chrome Canary** with a **separate browser profile** for this first WebAgent build.

Reasons:

- The extension requests broad ScriptCat development permissions, including `debugger`, `userScripts`, `scripting`, and `<all_urls>` host access.
- A separate profile avoids mixing test scripts, extension state, cookies, and browser-session experiments with your daily browser profile.
- Chrome stable should also load MV3, but Canary is safer for iterative extension/WebAgent validation.

## Load unpacked steps

1. Open Chrome Canary with a separate profile.
2. Navigate to:

   ```text
   chrome://extensions
   ```

3. Toggle **Developer mode** on.
4. Click **Load unpacked**.
5. Select exactly this directory:

   ```text
   /home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat/dist/ext
   ```

6. Confirm ScriptCat appears in the extension list and is enabled.
7. Open ScriptCat's extension page/options UI.
8. Go to the Agent provider/model settings.
9. Verify that **WebAgent** is available as a provider and that it offers:
   - Target: ChatGPT / Gemini / Claude
   - Transport: Tab DOM / CDP / Local Bridge
   - No required API Base URL
   - No required API Key

## What should be visible now

- ScriptCat should load as an unpacked MV3 extension.
- Existing ScriptCat release/v1.5 Agent features should still be present.
- API providers (OpenAI, Anthropic, Zhipu) should still be present as optional compatibility providers.
- A new **WebAgent** provider option should be visible in Agent provider/model settings.
- WebAgent config should save without an API key.
- Agent chat/provider grouping can display a **WA** WebAgent badge for WebAgent models.

## What not to expect yet

This build establishes the provider seam only. It does **not** yet automate real ChatGPT, Gemini, or Claude pages.

Do not expect yet:

- Automatic ChatGPT/Gemini/Claude DOM control.
- Real CDP conversation driving.
- Local bridge/MCP execution.
- Site-specific selectors in extension core.

Those belong in target-specific drivers, userscripts/content scripts, CDP modules, or MCP/local bridge layers behind the WebAgent driver contract.

## Where to put validation evidence

Use these folders for follow-up evidence:

- Screenshots: `../../artifacts/extension-install/screenshots/`
- Logs: `../../artifacts/extension-install/logs/`

Suggested screenshot names:

- `chrome-extensions-loaded.png`
- `scriptcat-options-agent-provider.png`
- `webagent-keyless-model-config.png`

Suggested log names:

- `chrome-extension-errors.txt`
- `scriptcat-service-worker-console.txt`
- `webagent-provider-smoke.txt`

## Exact next OMX prompt after installation

After loading the extension, use this prompt:

```text
$ralph
Use Playwriter/MCP to validate the locally loaded ScriptCat WebAgent MV3 build. Verify Chrome Canary has ScriptCat enabled from /home/ned/src/ai-work/scriptcat-webagent-lab/repos/scriptcat/dist/ext, open the ScriptCat options page, confirm the Agent provider settings show WebAgent as a keyless provider with ChatGPT/Gemini/Claude targets and tab-dom/cdp/local-bridge transports, create or inspect a keyless WebAgent ChatGPT/tab-dom model if safe, collect screenshots/logs under ../../artifacts/extension-install/, and report any extension console errors. Do not require API keys and do not automate real ChatGPT/Gemini/Claude yet.
```

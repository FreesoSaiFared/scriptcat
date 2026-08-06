# Windows live ChatGPT acceptance — isolated ConversationSurface

Status: first live run exposed two correlation defects; repaired candidate prepared for rerun.

The production ScriptCat build from `chatgpt/torsionfield-chatgpt-surface-20260806` was loaded in Playwright Chromium 149 against the existing dedicated authenticated profile `E:\Transductive_MCP_Work\page-agent-chatgpt-profile`. Chrome Stable 151 and Chrome Canary 153 did not honor command-line unpacked-extension loading in this run; the installed Playwright Chromium did. The normal interactive Chrome and Canary profiles were left running and untouched.

ScriptCat Beta `1.5.0.1100` loaded as an unpacked MV3 extension. `chrome.developerPrivate.updateExtensionConfiguration` enabled `userScriptsAccess`, and the candidate userscript was installed through ScriptCat's real installation page from the immutable commit URL.

The first live prompt created exactly one user turn and one settled assistant turn. The contract appeared exactly once, the assistant returned the nonce exactly, the gate badge reported `Gates pass`, and the composer was empty afterward. The receipt nevertheless reported `UNKNOWN_OUTCOME` for two live-only reasons:

1. a first submission legitimately changes the route from the non-durable landing page to a durable `/c/<conversation-id>` route;
2. ChatGPT renders long user messages inside a collapsible wrapper and flattens line breaks, so outer `innerText` includes `Show more` and differs from the exact composer string.

The repair accepts only the expected same-origin non-durable-to-durable first-conversation transition. Durable conversation-to-different-durable-conversation changes remain `UNKNOWN_OUTCOME`. Prompt correlation now removes the collapsible UI control and collapses presentation whitespace while retaining all words, punctuation, contract fingerprints and nonces. Focused tests cover both regressions.

The next distinguishing action is a second live run using `scripts/live-chatgpt-surface-acceptance.cjs`. Acceptance requires the persisted receipt to become `CONFIRMED`; all earlier postconditions must remain true.


## ScriptCat requirement-cache repair

The second live run still produced the old `conversation-identity-changed` receipt after the source fix had been pushed and the userscript had been updated. The real effect and page evidence were otherwise correct. ScriptCat had retained the previously fetched `@require` resource because its URL still named the moving branch. Updating the top-level userscript version alone did not invalidate that resource URL.

The userscript now pins both `@require` resources to commit `a9942fd4b3ba8b02ea396208f021d257f5e8b9ef`. This makes the executable dependency set immutable and gives every later change a new URL plus a deliberate userscript version. A static test rejects a return to the moving branch URL.

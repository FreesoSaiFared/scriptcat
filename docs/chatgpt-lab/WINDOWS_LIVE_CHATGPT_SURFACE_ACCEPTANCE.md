# Windows live ChatGPT acceptance — isolated ConversationSurface

Status: **PROVEN against the dedicated authenticated ChatGPT profile on 2026-08-06.**

Repository branch: `chatgpt/torsionfield-chatgpt-surface-20260806`
Runtime repair commit: `4a43c0dc32a32dc97031d6de3a1413c06071fe00`
Browser: Playwright Chromium `149.0.7827.55` on Windows
Extension: unpacked ScriptCat Beta `1.5.0.1100`, ID `jikpfcegceaoondgnomhpopjgoaljndo`

## Direct live result

The final acceptance harness ran immediately after a fresh dedicated-browser start, without a manual page reload. A real ChatGPT submission started on the non-durable landing route and created one durable conversation. The page showed exactly one new user turn, exactly one settled assistant turn, exactly one constraint contract, the expected nonce in the assistant answer, an empty composer after submission, and the persisted receipt:

```text
CONFIRMED
contract-injected:prompt-and-settled-assistant-effect-observed
```

The separate live draft probe placed a known non-empty draft in the composer, reached `HUMAN_DRAFT_PRESENT`, preserved the exact SHA-256 before and after the refused operation, submitted no turn, and cleared only the probe-owned draft after verification.

Machine-readable evidence recorded at `2026-08-06T17:03:12.826Z` is committed at `docs/chatgpt-lab/evidence/WINDOWS_LIVE_CHATGPT_SURFACE_20260806.json`. The local full screenshot is retained outside Git because it contains the authenticated profile's sidebar and unrelated conversation titles.

## Failures that produced the repairs

The first live effect was correct, yet the receipt reported `UNKNOWN_OUTCOME`. Two live-only observations caused it:

1. the first submission legitimately changes the route from `/` to a durable `/c/<conversation-id>` route;
2. ChatGPT wraps long user messages in a collapsible element, adds a `Show more` control to outer text, and flattens presentation line breaks.

The surface now permits only a same-origin non-durable-to-durable creation transition. Durable conversation changes remain ambiguous. Correlation reads the dedicated user-message content element and collapses presentation whitespace while retaining every visible word, punctuation mark, contract fingerprint and nonce.

The next live run still executed the old classifier because ScriptCat had cached the moving-branch `@require` URL. Userscript version `0.3.2-live-surface` pins both requirements to `4a43c0dc32a32dc97031d6de3a1413c06071fe00`. Static tests reject a return to `refs/heads/...` requirement URLs.

A fresh browser start also showed one bounded startup race: ChatGPT's initial document could reach `document-idle` before ScriptCat restored its registered user script. The acceptance harness now reloads exactly once only when the launcher is absent; it never retries a submission.

## Preservation and scope

The run used the existing dedicated authenticated profile directly. It copied no cookies, profile databases, or authentication material and called no private ChatGPT endpoint. Normal Stable and Canary browser profiles were untouched. Verbose Chromium logs containing account identifiers are excluded from repository evidence.

The candidate is ready for semantic porting into the current authoritative Torsionfield branch. Wholesale branch merge remains unnecessary; the bounded surface, focused tests, pinned metadata, and live acceptance harness are the transplantable units.

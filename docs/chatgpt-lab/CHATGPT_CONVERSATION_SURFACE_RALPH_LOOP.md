# Torsionfield ChatGPT Conversation Surface — isolated Ralph loop

> Historical donor-development record. The authenticated provider boundary described near the end was later closed by [`WINDOWS_LIVE_CHATGPT_SURFACE_ACCEPTANCE.md`](./WINDOWS_LIVE_CHATGPT_SURFACE_ACCEPTANCE.md).

## One goal

Make one ScriptCat-managed userscript send path observable enough that a later
integration process can distinguish a confirmed ChatGPT turn from a missing,
partial, redirected, or ambiguous effect without overwriting a human draft.

This branch does not attempt to become the final Torsionfield architecture. It is
an isolated, removable candidate built on `chatgpt/torsionfield-lab` so Codex and
other ChatGPT internal-VM sessions can compare or transplant the mechanism later.

## Branch boundary

Branch:

`chatgpt/torsionfield-chatgpt-surface-20260806`

Base commit:

`3a6c7132e3a4436d8cd631d570e6f635418b6aad`

The earlier `torsionfield/prompt-runtime-userscript-v0` branch had diverged from
the current laboratory line. The current branch therefore begins from the
seven-commit-ahead `chatgpt/torsionfield-lab` branch rather than silently
combining two histories.

## Ralph loop actually run

The same goal was repeated through these concrete gaps:

1. Baseline syntax and core tests passed.
2. A removable `ConversationSurface` module was added.
3. Outcome classification was tested for `CONFIRMED`, `PARTIAL`, `NOT_APPLIED`,
   and `UNKNOWN_OUTCOME`.
4. The existing send guard was connected to a pre-submit baseline and a
   post-submit settled-turn observer.
5. A GitHub Actions staging job fetched the exact isolated commit through
   `gh-proxy.com`, hashed it, extracted it, and uploaded it as an immutable
   artifact.
6. The internal Debian 13 VM verified and decompressed that artifact.
7. Chromium policy blocklists were first observed to prevent unpacked extension
   loading, then repaired in both persistent policy inputs and the effective
   merged policy. The pre-repair absence and post-repair service-worker target
   were both recorded.
8. ScriptCat 1.5.0.1100 was loaded in Chromium 144.
9. Chrome's per-extension **Allow User Scripts** setting was enabled through the
   same `chrome.developerPrivate` call used by ScriptCat's own E2E fixtures.
10. The candidate userscript was installed through ScriptCat's real install page.
11. A local ChatGPT-shaped fixture received exactly one prompt, streamed an
    assistant turn, settled, and produced a `CONFIRMED` receipt.
12. Browser postconditions proved that a non-empty human draft was refused,
    a file was attached through the page input without an OS dialog, and citation
    links survived in clean response evidence.
13. The evidence clone was repaired so Torsionfield's own validation badges no
    longer contaminate the captured provider HTML.

## Semantic operations introduced

`userscripts/torsionfield-chatgpt-conversation-surface.js` supplies:

- exact conversation identity derived from the current URL;
- composer discovery and draft-safe insertion;
- send-button and streaming-state observation;
- pre-submit turn baseline;
- settled-response observation with a quiet period;
- re-observation classification before any retry;
- file-input attachment using `DataTransfer`;
- clean assistant HTML, text, and citation capture;
- bounded session receipts.

Selectors remain current bindings, not public architecture. The semantic
operations are the candidate mechanism worth evaluating.

## Preservation rules encoded in behavior

- No cookie, profile, token, or private backend access.
- No force option that clears a human draft.
- No automatic retry from `UNKNOWN_OUTCOME`.
- No claim that the internal VM reached an authenticated live ChatGPT account.
- No mutation of the bootstrap, laboratory, prompt-runtime, main, or release
  branches.

## Evidence disposition

The detailed internal-VM browser logs, screenshots, checkpoints, and temporary filesystem paths remain outside this repository. The durable repository evidence is the source history, focused tests, and the later sanitized Windows acceptance record.

The deterministic fixture established the removable mechanism. The dedicated authenticated profile later established the same user-visible postconditions on `chatgpt.com`.

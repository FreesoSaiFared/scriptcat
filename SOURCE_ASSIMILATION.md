# Torsionfield ScriptCat source assimilation

This fork follows ScriptCat as its primary upstream and maintains a small number of Torsionfield-specific execution capabilities. `source-assimilation.json` records only source relationships that change future integration work.

## Current semantic transplant

The ChatGPT ConversationSurface source began on `chatgpt/torsionfield-chatgpt-surface-20260806` from old base `3a6c7132e3a4436d8cd631d570e6f635418b6aad` and reached proven donor result `52db2e02fee42728fa58075af2b35a333a0234c6`. The target is the authoritative Torsionfield line beginning at `a5d48ca4df6fd620a282c9a6ae4b6c0b83f6e057`.

The transplant keeps the observable behavior and does not merge the older laboratory history. It adds a removable userscript boundary, focused tests, a dedicated-profile launcher, and a live acceptance probe while preserving the resident ScriptCat channel and Rust Torsion Node.

## Deliberate local behavior

- Read the exact conversation and turn baseline before submission.
- Preserve a non-empty human draft byte-for-byte.
- Observe streaming and settled assistant turns before classifying the effect.
- Permit retry only after the page proves `NOT_APPLIED`.
- Preserve provider text, HTML, citations, and conversation identity as evidence.
- Use a dedicated authenticated browser profile without copying profile or credential files.
- Keep ChatGPT selectors behind the removable ConversationSurface module.

## Acceptance commands

```text
pnpm run test:chatgpt-surface
pnpm run typecheck
pnpm run build:torsionfield
pnpm run verify:torsionfield-core
pnpm run torsion-node:build
pnpm run verify:torsion-node
pnpm run verify:chatgpt-surface
```

The live ChatGPT check requires a dedicated authenticated browser launched with the built extension and a loopback-only CDP endpoint. Run evidence belongs in `test-results/verify/` or the external private evidence store; this file contains only the reusable boundary and current source lineage.

## Removal condition

Delete the local ConversationSurface when ScriptCat or another maintained source supplies equivalent draft-preserving, exact-conversation, re-observed submission semantics and passes the same acceptance checks.

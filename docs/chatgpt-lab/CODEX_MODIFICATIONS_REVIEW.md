# Review of the Codex-managed Torsionfield ScriptCat changes

Reviewed: 2026-08-05, Europe/Amsterdam

Repository: `FreesoSaiFared/scriptcat`

This review does not modify the Codex-managed branches and does not propose a pull request. The experimental implementations are additive files on `chatgpt/torsionfield-lab`.

## Branch state reviewed

- `torsionfield/scriptcat-1.5-bootstrap` at `de28dc830ac4eae0f761c1dd0b463879c62978a8`
- `torsionfield/prompt-runtime-userscript-v0` at `ad689109be517c6fb0cd2bbd454b9b6b8802a90a`
- merge base between those branches: `df9e0e25c8b754b8ad00fc38e2f4e614121ecad0`

The bootstrap branch is mainly an execution/staging branch: a ScriptCat launcher plus workflows for source archives, browser runtimes, MindTown dependencies, PBRT and Blender. The prompt-runtime branch contains the one unique product experiment: `userscripts/transductive-prompt-runtime.user.js`.

## What Codex did well

### It produced a complete userscript rather than an architecture sketch

The prompt runtime is a functioning vertical slice: hierarchical prompt selection, persistent prompt storage, epoch constraints, contract fingerprints, output gates, response validation, prompt capture, import/export, UI, menu commands and a core self-test. The core logic is defined before browser initialization and exported under CommonJS, which makes non-DOM tests possible without splitting the file first.

### The constraint contract has an inspectable identity

The contract is generated deterministically and carries a fingerprint. This is useful for seeing whether the current composer already contains the active constraint set and for exposing the active state in the launcher UI. The 32-bit FNV hash is not cryptographic, but the code does not use it as a security claim.

### The output gates are concrete

`code-only`, `json-only` and `patch-only` are machine-checkable rather than rhetorical. The strict-projection blocker remains reversible: the user can reveal a blocked answer instead of losing it.

### The launcher checks an actual browser boundary

The launcher does more than call `Start-Process`: it waits for CDP, finds the ScriptCat service worker, derives the extension ID and writes a machine-readable receipt.

### Codex removed an unproven path

Commit `df9e0e25...` removes a tunnel revocation helper because the corresponding public CUA/MCP tunnel had not been executed. That is the right evidence discipline: infrastructure should not remain merely because it completes a hypothetical architecture.

## Findings in the prompt runtime

### High — contract injection and send are not transactional

The original capture-phase send handler mutates the composer and then allows the same Enter, click or submit event to continue. ChatGPT's React state can still submit the value that existed before the synthetic input event was processed. A visible contract in the DOM is therefore not proof that the transmitted prompt contained it.

Lab correction: when injection changes the composer, cancel the original send, dispatch the input event, wait for two animation frames, then replay the original send action under a one-shot bypass. If injection was required but failed, cancel the send rather than silently transmit an unconstrained prompt.

### High — changed gates do not revalidate unchanged messages

The original `processedMessages` cache is keyed only by message text. Activating another gate leaves the text unchanged, so earlier responses are skipped and keep results from the previous gate set.

Lab correction: include the contract fingerprint in the validation cache key and clear/reschedule validation whenever epoch or persistent validation settings change.

### High — mutually exclusive structural gates can be locked together

`code-only`, `json-only` and `patch-only` can all be active simultaneously. No output can satisfy those contracts together.

Lab correction: structural gates are mutually exclusive within one epoch. A new structural gate is rejected while another is locked. Imported epoch state is normalized to retain only the first structural gate.

### Medium — incomplete streaming responses can be blocked

The original observer scans character-data mutations while ChatGPT is generating. A partially emitted JSON value, code fence or diff fails the structural gate by definition and can be hidden before generation finishes.

Lab correction: validate only after the message text remains stable for 1.2 seconds and the page no longer reports active generation for the newest assistant message.

### Medium — every DOM change causes a full conversation scan

The document-wide observer debounces into `scanAllMessages()`. Long conversations and token streaming repeatedly traverse every assistant message.

Lab correction: map each mutation to its nearest assistant message, collect only affected messages and schedule those. Mutations created by the lab UI and badges are ignored.

### Medium — “session” constraints are persisted as durable state

The original state stores prompt library, settings, constraints and gates together through `GM_setValue`. Consequently, a constraint epoch survives a browser restart even though the UI describes it as session or epoch state.

Lab correction: durable prompt library and settings remain in GM storage; current constraints, gates and epoch identity use `sessionStorage`.

### Medium — imports are only partially bounded

The original import checks that `prompts` is an array, then maps its objects into the library. Very large libraries, oversized fields, repeated IDs and unknown gate names are not normalized through a single schema boundary.

Lab correction: imports are capped at 200 unique prompts, bodies at 20,000 characters, titles at 120, paths at eight components and 80 characters per component. Kinds and gate IDs are restricted to known values.

### Low — explicit prompt blocks can be detected twice

A response containing `<prompt>...</prompt>` can produce both a tagged candidate and an “instruction-like response” candidate for the wrapper text.

Lab correction: heuristic whole-response capture runs only when no explicit tagged, fenced or headed candidate was found.

### Low — direct-language validation reads quoted source as authored prose

The original direct-language patterns can mark an answer as failing because a quoted passage or code example contains “If you want”.

Lab correction: fenced code, inline code and Markdown blockquotes are removed before prose-style gates run.

## Findings in the launcher

### Stale build acceptance

The original builds only when `dist/ext/manifest.json` is absent. A source edit can therefore launch an old build.

Lab correction: rebuild when explicitly requested, when the manifest is absent or when a source/configuration file is newer than the manifest.

### CDP endpoint ambiguity

The original does not preflight the requested port and does not explicitly set the debugging address. An occupied port can produce confusing attachment or startup behavior.

Lab correction: prove the loopback port can be bound before launch and pass `--remote-debugging-address=127.0.0.1`.

### Service-worker timing

The original waits until any CDP target exists, then performs a single service-worker lookup. MV3 workers start asynchronously and may be temporarily absent.

Lab correction: wait separately for `/json/version` and the ScriptCat service-worker target until the deadline.

### Failed-launch residue and weak provenance

The original can leave the newly started browser running after a later validation failure. Its receipt does not bind the launch to a repository revision or built manifest.

Lab correction: terminate the process on failed validation and record the repository commit, manifest SHA-256, browser version, complete launch arguments and launcher version.

## Findings in the staging workflows

The staging workflows solved a real managed-VM problem: they generated downloadable, pinned source and runtime artifacts when direct VM internet access was unavailable. The successful ScriptCat simulator test used those artifacts.

The main limitations are operational rather than reasons to discard the workflows:

- The archive URLs pin upstream commits, but downloads pass through `gh-proxy.com`. The resulting hash records what arrived; it does not independently prove that the proxy delivered the intended commit. Checking out the exact SHA and verifying `HEAD`, or comparing against a separately established digest, would close that gap.
- GitHub actions use mutable major tags such as `actions/setup-node@v4`; commit-SHA action pins would make the staging environment more reproducible.
- One-day retention made the artifacts nearly expire during this review. That is economical for one-shot transfer but fragile for a durable recovery channel.
- Blender, PBRT, GeoGebra, MindTown and ScriptCat staging in the ScriptCat product fork creates branch noise. It worked for the immediate VM experiment; a dedicated orchestration repository would reduce later product-branch reconciliation.

No staging-workflow changes were made in the lab branch because they belong to Codex's active orchestration work and are not required to demonstrate the prompt-runtime fixes.

## Additive lab files

- `userscripts/transductive-prompt-runtime.chatgpt-lab-core.js`
- `userscripts/transductive-prompt-runtime.chatgpt-lab.user.js`
- `userscripts/transductive-prompt-runtime.chatgpt-lab.test.cjs`
- `scripts/start-chatgpt-torsionfield-lab.ps1`
- `docs/chatgpt-lab/CODEX_MODIFICATIONS_REVIEW.md`

The original Codex userscript and launcher remain unchanged. The browser userscript imports the testable core through ScriptCat’s `@require` mechanism, while the Node test loads that same core directly.

## Verification performed

- Node syntax check: passed
- userscript core self-test: passed
- focused Node test: 16 assertions passed
- lab core SHA-256: `5790a5ceafed2bdb745fab1fd2c302ead7242a81ae82a18b14df3cc364a6775b`
- browser userscript SHA-256: `81766d13c0284667500943b04f498dbe38ad348cf57b258a27c54c53ac056e1e`
- focused test SHA-256: `73af53e9c92b07875329040779389701d13b8059dd874485c1a40c8bdfc96027`
- lab launcher SHA-256: `9839e735acbd744cdae1b801be5c3ede4780537c3728dc3263a876a7bfa49a44`

PowerShell is not installed in the managed Debian VM, so the launcher received static structural checks but has not yet been executed on Windows. The lab userscript has passed its pure-core tests but has not yet received a full live ChatGPT browser test. Those are the two precise remaining verification boundaries.

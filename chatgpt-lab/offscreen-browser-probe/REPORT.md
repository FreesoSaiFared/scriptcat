# Torsionfield Offscreen Client Lifecycle Browser Probe

Date: 2026-08-08
Environment: Debian GNU/Linux 13 (trixie), Chromium 144.0.7559.96, 5 vCPU, Node 22.16.0
Status: VERIFIED IN LIVE INTERNAL-VM CHROMIUM

## Question

Can a Manifest V3 service worker safely retain a `Client` for an offscreen document after that document is closed and recreated, or must it resolve the current offscreen client again before sending?

## Experiment

Two otherwise equivalent MV3 probes were loaded unpacked into Chromium.

- `stale`: resolves the offscreen `Client` once and retains it.
- `repaired`: calls `clients.matchAll({includeUncontrolled:true,type:'window'})` and resolves the current `offscreen.html` client before every send.

Each probe performed:

1. create/locate offscreen document;
2. send probe and receive unique offscreen generation;
3. close offscreen document;
4. recreate offscreen document;
5. prove offscreen `Client.id` changed;
6. keep the original service-worker CDP target alive;
7. send a second probe.

## Observed stale behavior

- service worker target before/after: identical (`98A5BD2678CD3FA75661A11868B2BA3A`)
- first offscreen client: `ea2fcb63-29a1-4536-be54-dfa28c612d19`
- recreated offscreen client: `35aa30eb-528c-4ad9-b2f3-945fcf670544`
- second send through cached old client: `probe timeout`

The failure occurs while the same service worker is alive, isolating the stale-Client lifecycle defect.

## Observed repaired behavior

- service worker target before/after: identical (`5427C9DA0D868B59A9524B5410643C76`)
- first offscreen client: `bf1f1485-83db-485f-af24-e4fab354d20d`
- recreated offscreen client: `b8b65021-aadb-4084-9edc-0a19e395b00a`
- first offscreen generation: `f6788b7f-88a3-48db-9eec-8bf3d9f8d53c`
- second offscreen generation: `24ecd023-d3d8-4715-a01c-d8f8939a09cb`
- second send: succeeded with the new `Client.id`

## Relation to ScriptCat

The isolated ScriptCat repair in `packages/message/window_message.ts` implements the repaired rule in `ServiceWorkerMessageSend.init()`: it calls `self.clients.matchAll(...)` every time, finds the current `src/offscreen.html` client, clears the target and throws a precise error when absent, and then replaces `this.target` with the current client.

The probe is intentionally small: it tests the browser lifecycle primitive directly rather than claiming to be a second userscript manager. Together with the existing 17/17 focused ScriptCat regression test and successful production build, it upgrades the offscreen-rebind evidence from unit-only to browser-semantics verified.

## Boundary

This does not yet close a full live ScriptCat command across an offscreen destroy/recreate cycle inside the production extension. It proves the exact Chromium lifecycle mechanism and the repair rule used by ScriptCat. A production-extension live lifecycle run remains a higher-cost integration test rather than a prerequisite for retaining this repair.

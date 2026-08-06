// ==UserScript==
// @name         Transductive Prompt Runtime — ChatGPT Lab
// @namespace    https://transductive.science/
// @version      0.3.1-live-surface
// @description  Transactional prompt contracts and finalized-response gates for ChatGPT.
// @author       Friso + ChatGPT Lab
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @require      https://raw.githubusercontent.com/FreesoSaiFared/scriptcat/refs/heads/chatgpt/torsionfield-chatgpt-surface-20260806/userscripts/torsionfield-chatgpt-conversation-surface.js
// @require      https://raw.githubusercontent.com/FreesoSaiFared/scriptcat/refs/heads/chatgpt/torsionfield-chatgpt-surface-20260806/userscripts/transductive-prompt-runtime.chatgpt-lab-core.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  'use strict';
  const SurfaceModule = globalThis.TorsionfieldChatGPTConversationSurface;
  const Core = globalThis.TransductivePromptLabCore;
  if (!SurfaceModule) throw new Error('Torsionfield ChatGPT Conversation Surface did not load');
  if (!Core) throw new Error('Transductive Prompt Runtime Lab core did not load');

  /*
   * WHY THIS IS CREATED ONCE
   * ------------------------
   * The surface owns observations of conversation identity, baseline turn
   * counts, streaming state and settled output. The prompt runtime still owns
   * its existing contract mutation. Keeping those responsibilities separate
   * lets the integration process later replace the ChatGPT bindings without
   * rewriting prompt-library or gate behavior.
   */
  const conversationSurface = SurfaceModule.create();
  globalThis.__TORSIONFIELD_CHATGPT_CONVERSATION_SURFACE__ = conversationSurface;
  const { VERSION, PERSISTENT_KEY, EPOCH_KEY, OPEN, STRUCTURAL, FINALIZE_DELAY_MS, BUILTIN_PROMPTS, GATES, fnv1a64, stripConstraintContracts, normalizePromptLibrary, normalizePersistentState, normalizeEpochState, defaultEpochState, validateResponse, buildConstraintContract, detectPromptCandidates, runCoreSelfTest } = Core;
  function readPersistent() {
    let value = null;
    try { value = typeof GM_getValue === 'function' ? GM_getValue(PERSISTENT_KEY, null) : null; } catch (_) {}
    if (value == null) try { value = localStorage.getItem(PERSISTENT_KEY); } catch (_) {}
    if (typeof value === 'string') try { value = JSON.parse(value); } catch (_) { value = null; }
    return normalizePersistentState(value);
  }

  function writePersistent(value) {
    persistent = normalizePersistentState(value);
    try { if (typeof GM_setValue === 'function') GM_setValue(PERSISTENT_KEY, persistent); else localStorage.setItem(PERSISTENT_KEY, JSON.stringify(persistent)); } catch (_) {}
    processed = new WeakMap(); scheduleExisting(); refreshButton();
  }

  function readEpoch() {
    let value = null;
    try { value = JSON.parse(sessionStorage.getItem(EPOCH_KEY) || 'null'); } catch (_) {}
    const normalized = normalizeEpochState(value); sessionStorage.setItem(EPOCH_KEY, JSON.stringify(normalized)); return normalized;
  }

  function writeEpoch(value) {
    epoch = normalizeEpochState(value); sessionStorage.setItem(EPOCH_KEY, JSON.stringify(epoch)); processed = new WeakMap(); scheduleExisting(); refreshButton();
  }

  let persistent = readPersistent(), epoch = readEpoch(), processed = new WeakMap(), bypass = false, button;
  const stability = new WeakMap(), revealed = new WeakMap();

  function visible(node) { if (!node?.isConnected) return false; const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; }
  function findComposer() { for (const selector of ['#prompt-textarea', 'textarea[data-id="root"]', 'form textarea', 'form [contenteditable="true"][role="textbox"]', 'form [contenteditable="true"]']) { const found = [...document.querySelectorAll(selector)].filter(visible); if (found.length) return found.at(-1); } return null; }
  function composerText(node) { return !node ? '' : 'value' in node ? node.value : node.innerText || node.textContent || ''; }
  function dispatchInput(node) { try { node.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' })); } catch (_) { node.dispatchEvent(new Event('input', { bubbles: true })); } }

  function setComposerText(node, text) {
    if (!node) return false; node.focus();
    if ('value' in node) { const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value'); if (descriptor?.set) descriptor.set.call(node, text); else node.value = text; }
    else { node.textContent = text; }
    dispatchInput(node); return composerText(node).trim() === text.trim();
  }

  function ensureContract() {
    const node = findComposer();
    if (!node) return { ok: false, changed: false, beforeText: '', afterText: '', reason: 'composer-missing' };
    const current = composerText(node), contract = buildConstraintContract(epoch);
    if (current.includes(OPEN) && current.includes(`fingerprint="${contract.fingerprint}"`)) {
      return { ok: true, changed: false, beforeText: current, afterText: current, reason: 'contract-already-present' };
    }
    const clean = stripConstraintContracts(current), next = `${clean}${clean ? '\n\n' : ''}${contract.text}`;
    const ok = setComposerText(node, next);
    return { ok, changed: true, beforeText: current, afterText: next, reason: ok ? 'contract-injected' : 'contract-injection-not-observed' };
  }

  function sendButton(form = findComposer()?.closest('form')) { for (const selector of ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label^="Send"]']) { const found = (form || document).querySelector(selector); if (found && visible(found) && !found.disabled) return found; } return null; }
  function intent(event) { const composer = findComposer(), form = composer?.closest('form'); if (!composer) return null; if (event.type === 'keydown') return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && composer.contains(event.target) ? { form } : null; if (event.type === 'click') { const target = event.target.closest('button'); return target && target === sendButton(form) ? { form, target } : null; } return event.type === 'submit' && event.target === form ? { form } : null; }

  function replay(sendIntent) { bypass = true; const target = sendIntent.target || sendButton(sendIntent.form); if (target) target.click(); else if (sendIntent.form?.requestSubmit) sendIntent.form.requestSubmit(); setTimeout(() => { bypass = false; }, 0); }

  function observeSubmission(baseline, expectedUserText, injectionResult) {
    /*
     * This observer deliberately does not initiate a retry. A missing click
     * acknowledgement, a route change, or a sleeping service worker can all leave
     * the external effect ambiguous. Only a later NOT_APPLIED receipt authorizes
     * another caller to try again; UNKNOWN_OUTCOME is a stop-and-inspect state.
     */
    void conversationSurface.waitForSettledTurn(baseline, {
      expectedUserText,
      timeoutMs: 180_000,
      pollMs: 300,
      quietMs: 1_500,
    }).then((outcome) => {
      conversationSurface.recordReceipt({
        id: `prompt-send-${Date.now().toString(36)}`,
        operation: 'prompt-contract-send',
        status: outcome.status,
        reason: `${injectionResult.reason}:${outcome.reason}`,
        conversationKey: outcome.after.identity.key,
        baselineHash: baseline.latestAssistantHash,
        resultHash: outcome.after.latestAssistantHash,
      });
    }).catch((error) => {
      conversationSurface.recordReceipt({
        id: `prompt-send-observer-error-${Date.now().toString(36)}`,
        operation: 'prompt-contract-send',
        status: 'UNKNOWN_OUTCOME',
        reason: `observer-error:${error?.message || String(error)}`,
        conversationKey: baseline.identity.key,
        baselineHash: baseline.latestAssistantHash,
      });
    });
  }

  function guard(event) {
    if (bypass) return;
    const sendIntent = intent(event);
    if (!sendIntent) return;

    // Capture the exact conversation and turn state before changing the composer.
    // Without this baseline, a prior answer can be mistaken for the response to
    // the prompt being sent now.
    const baseline = conversationSurface.captureBaseline();
    const result = ensureContract();

    if (!result.ok && result.changed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      conversationSurface.recordReceipt({
        id: `prompt-send-cancelled-${Date.now().toString(36)}`,
        operation: 'prompt-contract-send',
        status: 'NOT_APPLIED',
        reason: result.reason,
        conversationKey: baseline.identity.key,
        baselineHash: baseline.latestAssistantHash,
      });
      return;
    }

    if (!result.changed) {
      // The ordinary site event continues. Observation begins in a microtask so
      // ChatGPT first receives the user-initiated event. This path still obtains a
      // receipt even when the correct contract was already present.
      queueMicrotask(() => observeSubmission(baseline, result.afterText, result));
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      replay(sendIntent);
      observeSubmission(baseline, result.afterText, result);
    }));
  }

  function messageText(message) { const clone = message.cloneNode(true); clone.querySelectorAll('.tspr-lab-badge,.tspr-lab-blocker').forEach((node) => node.remove()); return (clone.innerText || clone.textContent || '').trim(); }
  function messages() { const explicit = [...document.querySelectorAll('[data-message-author-role="assistant"]')]; return explicit.length ? explicit : [...document.querySelectorAll('article')].filter((node) => /assistant/i.test(node.getAttribute('data-testid') || node.getAttribute('aria-label') || '')); }
  function messageFor(node) { const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement; return element?.closest?.('[data-message-author-role="assistant"],article[data-testid*="assistant"]') || null; }
  function generating() { return Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label^="Stop"],button[aria-label*="Stop generating"]')); }

  function decorate(message, label, state, action) { const badge = document.createElement('button'); badge.className = 'tspr-lab-badge'; badge.dataset.state = state; badge.textContent = label; badge.addEventListener('click', action); message.append(badge); }
  function validateFinal(message) {
    const text = messageText(message); if (text.length < 10) return;
    const contract = buildConstraintContract(epoch), key = `${fnv1a64(text)}:${contract.fingerprint}`;
    if (processed.get(message) === key) return; processed.set(message, key);
    message.querySelectorAll(':scope > .tspr-lab-badge,:scope > .tspr-lab-blocker').forEach((node) => node.remove()); message.classList.remove('tspr-lab-blocked');
    if (persistent.promptDetection) { const candidates = detectPromptCandidates(text); if (candidates.length) decorate(message, `Capture prompt${candidates.length > 1 ? `s (${candidates.length})` : ''}`, 'capture', () => { writePersistent({ ...persistent, savedPrompts: normalizePromptLibrary([...persistent.savedPrompts, { title: candidates[0].title, path: ['Captured'], body: candidates[0].body }]) }); }); }
    const violations = persistent.responseValidation ? validateResponse(text, epoch.activeGates) : [];
    decorate(message, violations.length ? `${violations.length} gate violation${violations.length === 1 ? '' : 's'}` : 'Gates pass', violations.length ? 'fail' : 'pass', () => violations.length && alert(violations.map((item) => `${item.label}: ${item.detail}`).join('\n')));
    if (persistent.strictProjection && violations.some((item) => item.structural) && revealed.get(message) !== key) { message.classList.add('tspr-lab-blocked'); const blocker = document.createElement('div'); blocker.className = 'tspr-lab-blocker'; blocker.textContent = 'Hidden by a structural output gate. Click to reveal.'; blocker.onclick = () => { revealed.set(message, key); message.classList.remove('tspr-lab-blocked'); blocker.remove(); }; message.append(blocker); }
  }

  function schedule(message) { if (!message?.isConnected) return; const hash = fnv1a64(messageText(message)), previous = stability.get(message); if (previous) clearTimeout(previous); const timer = setTimeout(() => { if (!message.isConnected) return; if (hash !== fnv1a64(messageText(message)) || (generating() && message === messages().at(-1))) return schedule(message); validateFinal(message); }, FINALIZE_DELAY_MS); stability.set(message, timer); }
  function scheduleExisting() { for (const message of messages()) schedule(message); }

  function activateGate(id) { if (!GATES[id] || epoch.activeGates.includes(id)) return; if (STRUCTURAL.has(id) && epoch.activeGates.some((gate) => STRUCTURAL.has(gate))) return alert('Start a new epoch before selecting another structural gate.'); writeEpoch({ ...epoch, activeGates: [...epoch.activeGates, id] }); }
  function addConstraint(id) { const prompt = BUILTIN_PROMPTS.find((item) => item.id === id); if (!prompt || epoch.constraints.some((item) => item.id === id)) return; writeEpoch({ ...epoch, constraints: [...epoch.constraints, { ...prompt, kind: 'insert' }] }); }
  function newEpoch() { if (confirm('Start a new constraint epoch?')) writeEpoch(defaultEpochState()); }
  function exportLibrary() { const text = JSON.stringify({ version: 2, prompts: persistent.savedPrompts }, null, 2); if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text'); else navigator.clipboard?.writeText(text); }
  function importLibrary() { const text = prompt('Paste prompt-library JSON:'); if (!text) return; try { const parsed = JSON.parse(text); if (!Array.isArray(parsed.prompts)) throw new Error('prompts must be an array'); writePersistent({ ...persistent, savedPrompts: normalizePromptLibrary([...persistent.savedPrompts, ...parsed.prompts]) }); } catch (error) { alert(error.message); } }

  function refreshButton() { if (!button) return; const contract = buildConstraintContract(epoch); button.textContent = `PROMPTS · ${epoch.activeGates.length} · ${contract.fingerprint.slice(0, 8)}`; }
  function createButton() { button = document.createElement('button'); button.id = 'tspr-lab-launcher'; button.onclick = () => ensureContract(); document.body.append(button); refreshButton(); }

  if (typeof GM_addStyle === 'function') GM_addStyle('#tspr-lab-launcher{position:fixed;right:18px;bottom:82px;z-index:2147483600;background:#111;color:#fff;border:1px solid #777;border-radius:999px;padding:9px 13px;cursor:pointer}.tspr-lab-badge{border:1px solid #666;border-radius:999px;margin:5px;padding:3px 7px}.tspr-lab-badge[data-state="fail"]{color:#f88}.tspr-lab-blocked>*:not(.tspr-lab-blocker):not(.tspr-lab-badge){display:none!important}.tspr-lab-blocker{border:1px solid #a44;padding:9px;margin:8px}');
  createButton();
  document.addEventListener('keydown', guard, true); document.addEventListener('click', guard, true); document.addEventListener('submit', guard, true);
  new MutationObserver((records) => { const affected = new Set(); for (const record of records) { const direct = messageFor(record.target); if (direct) affected.add(direct); for (const node of record.addedNodes || []) { const found = messageFor(node); if (found) affected.add(found); } } for (const message of affected) schedule(message); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(scheduleExisting, 1_000);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Prompt Runtime Lab: inject contract', ensureContract);
    GM_registerMenuCommand('Prompt Runtime Lab: new epoch', newEpoch);
    GM_registerMenuCommand('Prompt Runtime Lab: lock Direct outcome', () => addConstraint('direct-outcome'));
    GM_registerMenuCommand('Prompt Runtime Lab: lock Root-cause repair', () => addConstraint('root-cause'));
    GM_registerMenuCommand('Prompt Runtime Lab: lock code-only gate', () => activateGate('code-only'));
    GM_registerMenuCommand('Prompt Runtime Lab: lock JSON-only gate', () => activateGate('json-only'));
    GM_registerMenuCommand('Prompt Runtime Lab: lock patch-only gate', () => activateGate('patch-only'));
    GM_registerMenuCommand('Prompt Runtime Lab: export library', exportLibrary);
    GM_registerMenuCommand('Prompt Runtime Lab: import library', importLibrary);
    GM_registerMenuCommand('Prompt Runtime Lab: show conversation receipts', () => alert(JSON.stringify(conversationSurface.readReceipts(), null, 2)));
    GM_registerMenuCommand('Prompt Runtime Lab: self-test', () => alert(JSON.stringify({ core: runCoreSelfTest(), surface: { version: conversationSurface.version, identity: conversationSurface.identity(), composer: conversationSurface.readComposer() } }, null, 2)));
  }
})();

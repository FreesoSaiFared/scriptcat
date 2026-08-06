/*
 * Torsionfield ChatGPT Conversation Surface — isolated internal-VM candidate
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ChatGPT's web page is not a stable API. A userscript can find a composer and
 * click a send button, yet still misreport success when React has not accepted
 * the text, when a prior assistant answer is mistaken for the new answer, or
 * when navigation has moved the tab to another conversation. This file keeps
 * those failure-prone observations in one removable boundary.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * - It does not copy cookies, browser profiles, or authentication material.
 * - It does not call private ChatGPT backend endpoints.
 * - It does not clear a non-empty composer.
 * - It does not retry a send. It classifies what the page actually shows so a
 *   caller may retry only after the outcome is demonstrably NOT_APPLIED.
 * - It does not claim selectors are permanent. Each selector is a current
 *   binding underneath semantic operations such as readComposer() and
 *   captureBaseline().
 *
 * REMOVE / ASSIMILATE BOUNDARY
 * ----------------------------
 * This candidate can be removed by deleting this file and its single @require
 * line. If the mechanism proves useful, the main Torsionfield integration may
 * transplant the semantic operations while replacing every current selector.
 */
(function installTorsionfieldChatGPTConversationSurface(globalObject) {
  'use strict';

  const VERSION = '0.1.1-live';
  const RECEIPT_STORAGE_KEY = 'torsionfield.chatgpt.surface.receipts.v1';
  const MAX_RECEIPTS = 64;

  const BINDINGS = Object.freeze({
    composer: Object.freeze([
      '#prompt-textarea',
      'textarea[data-id="root"]',
      'form textarea',
      'form [contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"]',
    ]),
    sendButton: Object.freeze([
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label^="Send"]',
    ]),
    stopButton: Object.freeze([
      'button[data-testid="stop-button"]',
      'button[aria-label^="Stop"]',
      'button[aria-label*="Stop generating"]',
    ]),
    userTurn: '[data-message-author-role="user"]',
    assistantTurn: '[data-message-author-role="assistant"]',
    fileInput: Object.freeze([
      'input[type="file"]',
      'form input[type="file"]',
    ]),
  });

  function fnv1a64(value) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(String(value || ''))) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  }

  /*
   * CORRELATION NORMALIZATION IS DELIBERATELY NARROW
   * ------------------------------------------------
   * ChatGPT preserves the submitted bytes internally, yet its rendered user
   * bubble may turn line breaks into spaces. Correlation therefore treats runs
   * of presentation whitespace as equivalent while keeping every visible word,
   * punctuation mark, contract fingerprint and nonce significant. This avoids
   * accepting a merely similar prompt and fixes the real live-page mismatch
   * observed on 2026-08-06.
   */
  function normalizeCorrelationText(value) {
    return normalizeText(value).replace(/\s+/g, ' ').trim();
  }

  function elementText(node) {
    if (!node) return '';
    if (typeof node.value === 'string') return node.value;
    return node.innerText || node.textContent || '';
  }

  function isVisible(node, view = globalObject) {
    if (!node || node.isConnected === false) return false;
    if (typeof node.getBoundingClientRect !== 'function') return true;
    const rect = node.getBoundingClientRect();
    const style = typeof view.getComputedStyle === 'function'
      ? view.getComputedStyle(node)
      : { display: '', visibility: '' };
    return rect.width > 0 && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden';
  }

  function lastVisible(documentObject, selectors) {
    for (const selector of selectors) {
      const candidates = Array.from(documentObject.querySelectorAll(selector) || [])
        .filter((node) => isVisible(node, documentObject.defaultView || globalObject));
      if (candidates.length) return candidates.at(-1);
    }
    return null;
  }

  function parseConversationIdentity(urlValue) {
    let parsed;
    try {
      parsed = new URL(String(urlValue || ''), 'https://chatgpt.com/');
    } catch (_) {
      parsed = new URL('https://chatgpt.com/');
    }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const match = path.match(/^\/c\/([^/?#]+)/);
    const projectMatch = path.match(/^\/g\/g-p-[^/]+(?:-[^/]+)?\/c\/([^/?#]+)/);
    const conversationId = decodeURIComponent((projectMatch || match || [])[1] || '');
    return Object.freeze({
      origin: parsed.origin,
      path,
      conversationId,
      key: conversationId ? `${parsed.origin}/c/${conversationId}` : `${parsed.origin}${path}`,
      isDurableConversation: Boolean(conversationId),
    });
  }

  function cloneCitationEvidence(turn) {
    if (!turn || typeof turn.querySelectorAll !== 'function') return [];
    const output = [];
    const seen = new Set();
    for (const link of turn.querySelectorAll('a[href]')) {
      const href = String(link.href || link.getAttribute?.('href') || '').trim();
      if (!href || seen.has(href)) continue;
      seen.add(href);
      output.push({
        href,
        label: normalizeText(link.innerText || link.textContent || link.getAttribute?.('aria-label') || ''),
      });
      if (output.length >= 100) break;
    }
    return output;
  }

  function pureOutcomeClassification(before, after, expectedUserText = '') {
    const expected = normalizeCorrelationText(expectedUserText);
    const newUserTurn = after.userTurnCount > before.userTurnCount;
    const newAssistantTurn = after.assistantTurnCount > before.assistantTurnCount
      || (after.latestAssistantHash && after.latestAssistantHash !== before.latestAssistantHash);
    const promptObserved = !expected || after.userTurnTexts.some((text) => normalizeCorrelationText(text) === expected);

    /*
     * A first send starts at a provider landing route and is then assigned a
     * durable /c/<id> route. That one transition is the expected completion of
     * conversation creation, not evidence that another actor stole the tab.
     * Once either side already has a durable ID, every different ID remains an
     * ambiguous cross-conversation mutation and is rejected.
     */
    const expectedNewConversationTransition = !before.identity.isDurableConversation
      && after.identity.isDurableConversation
      && before.identity.origin === after.identity.origin;
    if (after.identity.key !== before.identity.key && !expectedNewConversationTransition) {
      return { status: 'UNKNOWN_OUTCOME', reason: 'conversation-identity-changed' };
    }
    if (after.streaming && (newUserTurn || promptObserved || newAssistantTurn)) {
      return { status: 'PARTIAL', reason: 'effect-observed-response-still-streaming' };
    }
    if (!after.streaming && promptObserved && newAssistantTurn) {
      return { status: 'CONFIRMED', reason: 'prompt-and-settled-assistant-effect-observed' };
    }
    if (!newUserTurn && !newAssistantTurn && !promptObserved) {
      return { status: 'NOT_APPLIED', reason: 'baseline-unchanged-and-prompt-absent' };
    }
    return { status: 'UNKNOWN_OUTCOME', reason: 'page-shows-incomplete-or-ambiguous-effect' };
  }

  function create(options = {}) {
    const documentObject = options.document || globalObject.document;
    const locationObject = options.location || globalObject.location;
    const sessionStorageObject = options.sessionStorage || globalObject.sessionStorage;
    const clock = options.now || (() => Date.now());
    const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    if (!documentObject) throw new Error('ConversationSurface requires a document');

    function identity() {
      return parseConversationIdentity(locationObject?.href || 'https://chatgpt.com/');
    }

    function findComposer() {
      return lastVisible(documentObject, BINDINGS.composer);
    }

    function readComposer() {
      const node = findComposer();
      const text = elementText(node);
      return Object.freeze({
        found: Boolean(node),
        node,
        text,
        normalizedText: normalizeText(text),
        empty: normalizeText(text).length === 0,
        kind: node && typeof node.value === 'string' ? 'textarea' : node ? 'contenteditable' : 'missing',
      });
    }

    function dispatchInput(node, text) {
      node.focus?.();
      if (typeof node.value === 'string') {
        const prototype = Object.getPrototypeOf(node);
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) descriptor.set.call(node, text);
        else node.value = text;
      } else {
        node.textContent = text;
      }
      try {
        node.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        }));
      } catch (_) {
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    function insertPromptIfEmpty(text) {
      const before = readComposer();
      const intended = String(text || '');
      if (!before.found) return { ok: false, status: 'COMPOSER_MISSING' };
      if (!before.empty) {
        // This refusal is the actual human-draft boundary. No force flag exists:
        // a caller that truly intends to transform a draft must use a separate,
        // explicit operation whose postcondition preserves the original bytes.
        return {
          ok: false,
          status: 'HUMAN_DRAFT_PRESENT',
          draftHash: fnv1a64(before.text),
          draftLength: before.text.length,
        };
      }
      dispatchInput(before.node, intended);
      const after = readComposer();
      return {
        ok: after.normalizedText === normalizeText(intended),
        status: after.normalizedText === normalizeText(intended) ? 'INSERTED' : 'INSERTION_NOT_OBSERVED',
        intendedHash: fnv1a64(intended),
        observedHash: fnv1a64(after.text),
      };
    }

    function findSendButton() {
      const composer = findComposer();
      const form = composer?.closest?.('form') || documentObject;
      return lastVisible(form, BINDINGS.sendButton);
    }

    function isStreaming() {
      return BINDINGS.stopButton.some((selector) => Boolean(documentObject.querySelector(selector)));
    }

    function turnNodes(role) {
      const selector = role === 'assistant' ? BINDINGS.assistantTurn : BINDINGS.userTurn;
      return Array.from(documentObject.querySelectorAll(selector) || []);
    }

    function turnText(node) {
      if (!node) return '';

      /*
       * Long ChatGPT user messages are wrapped by a collapsible control whose
       * visible label becomes part of outer innerText ("Show more"). Reading the
       * dedicated content node first retains the submitted message and excludes
       * that provider UI label. Assistant turns use the whole turn because they
       * currently have no equivalent stable content wrapper.
       */
      const content = node.querySelector?.('[data-testid="collapsible-user-message-content"]') || node;
      const clone = typeof content.cloneNode === 'function' ? content.cloneNode(true) : content;
      clone.querySelectorAll?.('.tspr-lab-badge,.tspr-lab-blocker,[data-testid="collapsible-user-message-toggle"]')
        .forEach((element) => element.remove?.());
      return normalizeText(clone.innerText || clone.textContent || '');
    }

    function latestAssistantEvidence() {
      const node = turnNodes('assistant').at(-1) || null;
      // Capture a provider-shaped answer rather than an answer polluted by this
      // userscript's own validation badges. The live DOM remains untouched; only
      // the evidence clone is cleaned. This makes the clean view reproducible
      // while preserving citation links and the provider-rendered HTML structure.
      const clone = node && typeof node.cloneNode === 'function' ? node.cloneNode(true) : node;
      clone?.querySelectorAll?.('.tspr-lab-badge,.tspr-lab-blocker').forEach((element) => element.remove?.());
      const text = normalizeText(clone?.innerText || clone?.textContent || '');
      return Object.freeze({
        found: Boolean(node),
        text,
        textHash: text ? fnv1a64(text) : '',
        html: clone?.innerHTML || '',
        citations: cloneCitationEvidence(clone),
      });
    }

    function captureBaseline() {
      const userNodes = turnNodes('user');
      const assistantNodes = turnNodes('assistant');
      const latestAssistant = latestAssistantEvidence();
      return Object.freeze({
        capturedAt: clock(),
        identity: identity(),
        composer: readComposer(),
        userTurnCount: userNodes.length,
        assistantTurnCount: assistantNodes.length,
        userTurnTexts: userNodes.slice(-20).map(turnText),
        latestAssistantHash: latestAssistant.textHash,
        latestAssistant,
        streaming: isStreaming(),
      });
    }

    function classifyOutcome(before, expectedUserText = '') {
      const after = captureBaseline();
      const classification = pureOutcomeClassification(before, after, expectedUserText);
      return Object.freeze({ ...classification, before, after });
    }

    async function waitForSettledTurn(before, optionsValue = {}) {
      const timeoutMs = Math.max(250, Number(optionsValue.timeoutMs || 120_000));
      const pollMs = Math.max(50, Number(optionsValue.pollMs || 250));
      const quietMs = Math.max(100, Number(optionsValue.quietMs || 1_200));
      const expectedUserText = String(optionsValue.expectedUserText || '');
      const startedAt = clock();
      let quietSince = 0;
      let lastAssistantHash = '';
      let latest = captureBaseline();

      while (clock() - startedAt < timeoutMs) {
        latest = captureBaseline();
        const classification = pureOutcomeClassification(before, latest, expectedUserText);
        const assistantChanged = latest.latestAssistantHash !== before.latestAssistantHash;

        if (!latest.streaming && assistantChanged) {
          if (latest.latestAssistantHash !== lastAssistantHash) {
            lastAssistantHash = latest.latestAssistantHash;
            quietSince = clock();
          } else if (clock() - quietSince >= quietMs) {
            return Object.freeze({ ...classification, before, after: latest, elapsedMs: clock() - startedAt });
          }
        } else {
          quietSince = 0;
          lastAssistantHash = latest.latestAssistantHash;
        }
        await sleep(pollMs);
      }

      const classification = pureOutcomeClassification(before, latest, expectedUserText);
      return Object.freeze({
        ...classification,
        status: classification.status === 'NOT_APPLIED' ? 'NOT_APPLIED' : 'UNKNOWN_OUTCOME',
        reason: `timeout:${classification.reason}`,
        before,
        after: latest,
        elapsedMs: clock() - startedAt,
      });
    }

    function findFileInput() {
      return lastVisible(documentObject, BINDINGS.fileInput)
        || BINDINGS.fileInput.map((selector) => documentObject.querySelector(selector)).find(Boolean)
        || null;
    }

    function attachFiles(files) {
      const input = findFileInput();
      const requested = Array.from(files || []);
      if (!input) return { ok: false, status: 'FILE_INPUT_MISSING', requested: requested.length };
      if (!requested.length) return { ok: false, status: 'NO_FILES', requested: 0 };
      if (typeof globalObject.DataTransfer !== 'function') {
        return { ok: false, status: 'DATATRANSFER_UNAVAILABLE', requested: requested.length };
      }
      const transfer = new globalObject.DataTransfer();
      for (const file of requested) transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: input.files?.length === requested.length,
        status: input.files?.length === requested.length ? 'FILES_ATTACHED' : 'ATTACHMENT_NOT_OBSERVED',
        requested: requested.length,
        observed: input.files?.length || 0,
      };
    }

    function readReceipts() {
      try {
        const parsed = JSON.parse(sessionStorageObject?.getItem(RECEIPT_STORAGE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.slice(-MAX_RECEIPTS) : [];
      } catch (_) {
        return [];
      }
    }

    function recordReceipt(receipt) {
      const safe = {
        version: 1,
        id: String(receipt.id || `surface-${clock().toString(36)}`),
        recordedAt: clock(),
        operation: String(receipt.operation || 'observe'),
        status: String(receipt.status || 'UNKNOWN_OUTCOME'),
        reason: String(receipt.reason || ''),
        conversationKey: String(receipt.conversationKey || identity().key),
        baselineHash: String(receipt.baselineHash || ''),
        resultHash: String(receipt.resultHash || ''),
      };
      const next = [...readReceipts(), safe].slice(-MAX_RECEIPTS);
      try { sessionStorageObject?.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(next)); } catch (_) {}
      try {
        documentObject.dispatchEvent(new CustomEvent('torsionfield:conversation-surface-receipt', { detail: safe }));
      } catch (_) {}
      return safe;
    }

    return Object.freeze({
      version: VERSION,
      bindings: BINDINGS,
      identity,
      findComposer,
      readComposer,
      insertPromptIfEmpty,
      findSendButton,
      isStreaming,
      latestAssistantEvidence,
      captureBaseline,
      classifyOutcome,
      waitForSettledTurn,
      attachFiles,
      readReceipts,
      recordReceipt,
    });
  }

  const exported = Object.freeze({
    VERSION,
    BINDINGS,
    RECEIPT_STORAGE_KEY,
    MAX_RECEIPTS,
    fnv1a64,
    normalizeText,
    normalizeCorrelationText,
    parseConversationIdentity,
    pureOutcomeClassification,
    create,
  });

  globalObject.TorsionfieldChatGPTConversationSurface = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);

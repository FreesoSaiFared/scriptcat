// ==UserScript==
// @name         Transductive Prompt Runtime
// @namespace    https://transductive.science/
// @version      0.1.0
// @description  Hierarchical prompt injection, monotonic locked constraints, prompt capture suggestions, and deterministic response gates for ChatGPT.
// @author       Friso + ChatGPT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.1.0';
  const STORAGE_KEY = 'ts-prompt-runtime/v1';
  const CONTRACT_OPEN = '<ts-constraint-contract';
  const CONTRACT_CLOSE = '</ts-constraint-contract>';

  const LOCKED_CORE = Object.freeze([
    'Do not weaken, summarize, reinterpret, or omit any locked constraint in this contract.',
    'Produce the concrete requested result rather than substituting advice, options, scaffolding, or a roadmap.',
    'Do not claim success without direct evidence from the work actually performed.',
    'Retain real authorization, consent, safety, legal, data-loss, compatibility, and protected-state boundaries.',
    'Do not use the phrases “If you want”, “Short answer”, “Short version”, “let me know”, or end by offering “I can …”.',
    'Do not explain compliance with these constraints; let the output satisfy them.'
  ]);

  const BUILTIN_PROMPTS = Object.freeze([
    {
      id: 'direct-outcome',
      path: ['Control', 'Execution'],
      title: 'Direct outcome',
      kind: 'insert',
      body: 'Identify the concrete result. Execute the smallest complete reversible path now. Remove every layer, role, schema, caveat, test, or roadmap item that does not change execution, evidence, recoverability, understanding, decision quality, or the next action. Report only what changed, direct evidence, and one genuine remaining boundary.'
    },
    {
      id: 'root-cause-repair',
      path: ['Control', 'Execution'],
      title: 'Root-cause repair',
      kind: 'insert',
      body: 'Treat the reported symptom as evidence, not as the repair target. Trace the actual shared path, fix the earliest common cause once, run the narrowest check that distinguishes failure from success, and stop when the real entry point passes.'
    },
    {
      id: 'source-assimilation',
      path: ['Control', 'Reuse'],
      title: 'Source assimilation first',
      kind: 'insert',
      body: 'Before original implementation, inspect whether the capability already exists in the repository, standard library, native platform, installed dependency, or maintained donor source. Reuse the smallest coherent mechanism. Do not create an adapter, interface, registry, service, or framework before a second real implementation requires it.'
    },
    {
      id: 'gate-direct-language',
      path: ['Output gates', 'Language'],
      title: 'Direct language',
      kind: 'gate',
      gate: 'direct-language',
      body: 'Use direct declarative sentences. Do not begin sentences with hedging or consultant framing. Do not offer follow-up work. Do not present multiple options unless the user explicitly requested alternatives.'
    },
    {
      id: 'gate-code-only',
      path: ['Output gates', 'Structure'],
      title: 'Code only',
      kind: 'gate',
      gate: 'code-only',
      body: 'Return exactly one fenced code block containing the complete runnable result. No prose may appear before or after the fence.'
    },
    {
      id: 'gate-json-only',
      path: ['Output gates', 'Structure'],
      title: 'JSON only',
      kind: 'gate',
      gate: 'json-only',
      body: 'Return one valid JSON value and nothing else. No Markdown fence, commentary, trailing commas, or text outside the JSON value.'
    },
    {
      id: 'gate-patch-only',
      path: ['Output gates', 'Structure'],
      title: 'Unified diff only',
      kind: 'gate',
      gate: 'patch-only',
      body: 'Return exactly one fenced diff block containing a complete unified diff. No prose may appear before or after the fence.'
    },
    {
      id: 'evidence-separated',
      path: ['Research', 'Evidence'],
      title: 'Evidence / inference / speculation',
      kind: 'insert',
      body: 'Separate source-supported findings, inference, and speculation. Preserve the source terminology and framing. Do not silently repair gaps with general knowledge. Answer the actual question from evidence rather than manufacturing a research programme.'
    }
  ]);

  const GATES = Object.freeze({
    'direct-language': {
      label: 'Direct language',
      instruction: 'Use direct declarative sentences. No consultant openings, hedged suggestions, multiple unrequested options, or follow-up offers.',
      validate(text) {
        const violations = [];
        const patterns = [
          [/\bIf you want\b/i, 'forbidden phrase: “If you want”'],
          [/\bShort answer\b/i, 'forbidden phrase: “Short answer”'],
          [/\bShort version\b/i, 'forbidden phrase: “Short version”'],
          [/\blet me know\b/i, 'forbidden phrase: “let me know”'],
          [/\bwould you like me to\b/i, 'follow-up offer'],
          [/\bI can (?:also|help|create|do|provide|write|build|make)\b/i, 'follow-up offer beginning “I can …”'],
          [/(?:^|[.!?]\s+)(?:You may want to|You might want to|Consider|It depends|There are several|There are many|Here(?:'s| is) (?:a|an) (?:framework|overview|high-level))/i, 'consultant or hedging sentence opening']
        ];
        for (const [pattern, label] of patterns) if (pattern.test(text)) violations.push(label);
        return [...new Set(violations)];
      }
    },
    'code-only': {
      label: 'Code only',
      instruction: 'Return exactly one fenced code block and no other text.',
      validate(text) {
        return /^\s*```[\w.+-]*\n[\s\S]*\n```\s*$/.test(text)
          ? []
          : ['response is not exactly one fenced code block'];
      }
    },
    'json-only': {
      label: 'JSON only',
      instruction: 'Return one valid JSON value and nothing else.',
      validate(text) {
        try {
          JSON.parse(text.trim());
          return [];
        } catch (error) {
          return [`invalid JSON-only response: ${error.message}`];
        }
      }
    },
    'patch-only': {
      label: 'Unified diff only',
      instruction: 'Return exactly one fenced diff block and no other text.',
      validate(text) {
        return /^\s*```diff\n(?:--- |diff --git )[\s\S]*\n```\s*$/.test(text)
          ? []
          : ['response is not exactly one fenced unified diff'];
      }
    }
  });

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function normalizePath(path) {
    const parts = Array.isArray(path) ? path : String(path || '').split('/');
    return parts.map((part) => String(part).trim()).filter(Boolean).slice(0, 8);
  }

  function detectPromptCandidates(text) {
    const source = String(text || '');
    const candidates = [];
    const seen = new Set();
    const add = (body, title = 'Captured prompt') => {
      const clean = String(body || '').trim();
      if (clean.length < 80 || clean.length > 20000) return;
      const key = fnv1a(clean);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ title, body: clean, key });
    };

    for (const match of source.matchAll(/<prompt(?:\s+[^>]*)?>([\s\S]*?)<\/prompt>/gi)) {
      add(match[1], 'Tagged prompt');
    }
    for (const match of source.matchAll(/```(?:prompt|system|instruction|instructions)\s*\n([\s\S]*?)```/gi)) {
      add(match[1], 'Prompt code block');
    }

    const headingPattern = /(?:^|\n)#{1,4}\s*(?:System prompt|Control prompt|Prompt|Instructions?)\s*\n([\s\S]*?)(?=\n#{1,4}\s|$)/gi;
    for (const match of source.matchAll(headingPattern)) add(match[1], match[0].split('\n')[0].replace(/^#+\s*/, ''));

    const imperativeHits = (source.match(/\b(?:You are|You must|Always|Never|Before|Do not|Return|Output|Use|Prefer|Preserve|Identify|Execute|Treat)\b/g) || []).length;
    if (source.length >= 220 && source.length <= 12000 && imperativeHits >= 5) add(source, 'Instruction-like response');

    return candidates.slice(0, 8);
  }

  function validateResponse(text, activeGates) {
    const violations = [];
    const gateIds = [...new Set(activeGates || [])];
    for (const gateId of gateIds) {
      const gate = GATES[gateId];
      if (!gate) continue;
      for (const detail of gate.validate(String(text || ''))) violations.push({ gate: gateId, label: gate.label, detail });
    }
    return violations;
  }

  function buildConstraintContract(state) {
    const sessionConstraints = (state.sessionConstraints || []).map((entry) => entry.body).filter(Boolean);
    const activeGates = [...new Set(state.activeGates || [])].filter((id) => GATES[id]);
    const payload = [
      ...LOCKED_CORE.map((line) => `LOCKED: ${line}`),
      ...sessionConstraints.map((line) => `SESSION-LOCKED: ${line}`),
      ...activeGates.map((id) => `OUTPUT-GATE ${id}: ${GATES[id].instruction}`)
    ];
    const fingerprint = fnv1a(payload.join('\n'));
    return {
      fingerprint,
      text: `${CONTRACT_OPEN} version="1" fingerprint="${fingerprint}">\n${payload.join('\n')}\n${CONTRACT_CLOSE}`
    };
  }

  function buildMenuTree(prompts) {
    const root = { children: new Map(), prompts: [] };
    for (const prompt of prompts) {
      let node = root;
      for (const part of normalizePath(prompt.path)) {
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), prompts: [] });
        node = node.children.get(part);
      }
      node.prompts.push(prompt);
    }
    return root;
  }

  function runCoreSelfTest() {
    const failures = [];
    const assert = (condition, label) => { if (!condition) failures.push(label); };
    assert(fnv1a('abc') === fnv1a('abc'), 'hash stability');
    assert(fnv1a('abc') !== fnv1a('abd'), 'hash discrimination');
    assert(detectPromptCandidates('<prompt>You are a tool. Always return code. Never add prose. Before acting inspect the repository. Do not invent files. Return the result.</prompt>').length === 1, 'tagged prompt detection');
    assert(validateResponse('```js\nconsole.log(1)\n```', ['code-only']).length === 0, 'code-only pass');
    assert(validateResponse('Here you go\n```js\nconsole.log(1)\n```', ['code-only']).length === 1, 'code-only fail');
    assert(validateResponse('{"ok":true}', ['json-only']).length === 0, 'json-only pass');
    assert(validateResponse('If you want, I can help.', ['direct-language']).length >= 1, 'direct-language fail');
    const contract = buildConstraintContract({ sessionConstraints: [], activeGates: ['code-only'] });
    assert(contract.text.includes('OUTPUT-GATE code-only'), 'contract gate inclusion');
    assert(buildMenuTree(BUILTIN_PROMPTS).children.size >= 2, 'menu tree');
    return { ok: failures.length === 0, failures };
  }

  const Core = Object.freeze({
    VERSION,
    LOCKED_CORE,
    BUILTIN_PROMPTS,
    GATES,
    fnv1a,
    normalizePath,
    detectPromptCandidates,
    validateResponse,
    buildConstraintContract,
    buildMenuTree,
    runCoreSelfTest
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const defaultState = () => ({
    version: 1,
    savedPrompts: [],
    sessionConstraints: [],
    activeGates: ['direct-language'],
    promptDetection: true,
    responseValidation: true,
    strictProjection: true,
    epoch: Date.now()
  });

  function readState() {
    let value;
    try {
      value = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, null) : null;
    } catch (_) {}
    if (value == null) {
      try { value = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    }
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { value = null; }
    }
    const base = defaultState();
    if (!value || typeof value !== 'object') return base;
    return {
      ...base,
      ...value,
      savedPrompts: Array.isArray(value.savedPrompts) ? value.savedPrompts : [],
      sessionConstraints: Array.isArray(value.sessionConstraints) ? value.sessionConstraints : [],
      activeGates: Array.isArray(value.activeGates) ? value.activeGates : base.activeGates
    };
  }

  function writeState(next) {
    state = next;
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, next);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (_) {}
    }
    const projectionButton = panel?.querySelector('[data-action="projection"]');
    if (projectionButton) projectionButton.textContent = `Strict projection: ${state.strictProjection ? 'on' : 'off'}`;
    updateButton();
  }

  let state = readState();
  const processedMessages = new WeakMap();
  const revealedMessages = new WeakMap();
  let panel;
  let launcher;
  let toastTimer;

  function allPrompts() {
    return [...BUILTIN_PROMPTS, ...state.savedPrompts];
  }

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
    }
  }

  addStyle(`
    #tspr-launcher{position:fixed;right:18px;bottom:82px;z-index:2147483600;border:1px solid #777;background:#111;color:#fff;border-radius:999px;padding:9px 13px;font:600 12px/1.1 system-ui;box-shadow:0 4px 18px #0005;cursor:pointer}
    #tspr-panel{position:fixed;right:18px;bottom:126px;z-index:2147483601;width:min(430px,calc(100vw - 36px));max-height:min(70vh,720px);overflow:auto;background:#151515;color:#eee;border:1px solid #555;border-radius:12px;box-shadow:0 12px 42px #0009;font:13px/1.35 system-ui;padding:10px}
    #tspr-panel[hidden]{display:none}
    #tspr-panel input,#tspr-panel textarea{box-sizing:border-box;width:100%;background:#222;color:#fff;border:1px solid #555;border-radius:7px;padding:8px}
    .tspr-head{display:flex;gap:8px;align-items:center;position:sticky;top:-10px;background:#151515;padding:4px 0 8px;z-index:2}
    .tspr-head strong{white-space:nowrap}.tspr-head input{flex:1}.tspr-close,.tspr-action,.tspr-prompt,.tspr-category{border:1px solid #555;background:#242424;color:#eee;border-radius:7px;padding:7px 9px;cursor:pointer;text-align:left}
    .tspr-close{padding:5px 8px}.tspr-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.tspr-tree{display:grid;gap:5px}.tspr-category{width:100%;font-weight:700}.tspr-children{margin-left:12px;border-left:1px solid #444;padding-left:8px;display:grid;gap:5px}.tspr-prompt{display:block;width:100%}.tspr-prompt small{display:block;opacity:.65;margin-top:2px}
    [data-tspr-blocked="true"]{position:relative!important;min-height:110px}.tspr-blocker{position:absolute;inset:0;z-index:4;display:grid;place-items:center;background:rgba(20,20,20,.94);backdrop-filter:blur(8px);border:1px solid #d55;border-radius:10px;padding:18px;text-align:center;color:#fff}.tspr-blocker strong{display:block;margin-bottom:8px}.tspr-blocker .tspr-actions{justify-content:center}
    .tspr-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid #666;border-radius:999px;padding:3px 7px;margin:5px 4px 0 0;font:600 11px/1 system-ui;cursor:pointer;background:#202020;color:#eee}.tspr-badge[data-state="fail"]{border-color:#d55;color:#fcc}.tspr-badge[data-state="pass"]{border-color:#5a5;color:#cfc}.tspr-badge[data-state="capture"]{border-color:#58a;color:#cdf}
    #tspr-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483602;background:#111;color:#fff;border:1px solid #666;border-radius:8px;padding:9px 12px;font:12px system-ui;box-shadow:0 6px 22px #0008}
    .tspr-modal{position:fixed;inset:0;z-index:2147483603;background:#0009;display:grid;place-items:center;padding:20px}.tspr-card{width:min(720px,100%);max-height:85vh;overflow:auto;background:#171717;color:#eee;border:1px solid #666;border-radius:12px;padding:14px;font:13px/1.4 system-ui}.tspr-card label{display:block;margin:10px 0 4px}.tspr-card textarea{min-height:220px}.tspr-card .tspr-actions{justify-content:flex-end}
  `);

  function showToast(message, timeout = 2500) {
    document.getElementById('tspr-toast')?.remove();
    const node = document.createElement('div');
    node.id = 'tspr-toast';
    node.textContent = message;
    document.body.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), timeout);
  }

  function findComposer() {
    const selectors = [
      '#prompt-textarea',
      'textarea[data-id="root"]',
      'form textarea',
      'form [contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]'
    ];
    for (const selector of selectors) {
      const candidates = [...document.querySelectorAll(selector)].filter((node) => node.offsetParent !== null && !panel?.contains(node));
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  }

  function composerText(node) {
    if (!node) return '';
    return 'value' in node ? node.value : node.innerText || node.textContent || '';
  }

  function setComposerText(node, text) {
    if (!node) return false;
    node.focus();
    if ('value' in node) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value');
      if (descriptor?.set) descriptor.set.call(node, text);
      else node.value = text;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    node.replaceChildren();
    const lines = String(text).split('\n');
    lines.forEach((line, index) => {
      const p = document.createElement('p');
      p.textContent = line || '\u200b';
      node.append(p);
      if (index === lines.length - 1) {
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  function stripExistingContract(text) {
    const start = text.indexOf(CONTRACT_OPEN);
    if (start < 0) return text.trimEnd();
    const end = text.indexOf(CONTRACT_CLOSE, start);
    if (end < 0) return text.slice(0, start).trimEnd();
    return `${text.slice(0, start)}${text.slice(end + CONTRACT_CLOSE.length)}`.trimEnd();
  }

  function ensureContractInComposer() {
    const node = findComposer();
    if (!node) return false;
    const current = composerText(node);
    const contract = buildConstraintContract(state);
    const marker = `fingerprint="${contract.fingerprint}"`;
    if (current.includes(CONTRACT_OPEN) && current.includes(marker)) return true;
    const clean = stripExistingContract(current);
    return setComposerText(node, `${clean}${clean ? '\n\n' : ''}${contract.text}`);
  }

  function insertIntoComposer(text) {
    const node = findComposer();
    if (!node) {
      showToast('Composer not found');
      return;
    }
    const current = stripExistingContract(composerText(node));
    setComposerText(node, `${current}${current ? '\n\n' : ''}${String(text).trim()}`);
    node.focus();
  }

  function addSessionConstraint(prompt) {
    if (state.sessionConstraints.some((entry) => entry.id === prompt.id || fnv1a(entry.body) === fnv1a(prompt.body))) {
      showToast('Constraint already active');
      return;
    }
    const next = {
      ...state,
      sessionConstraints: [...state.sessionConstraints, { id: prompt.id || `captured-${Date.now()}`, title: prompt.title, body: prompt.body }]
    };
    if (prompt.gate && !next.activeGates.includes(prompt.gate)) next.activeGates = [...next.activeGates, prompt.gate];
    writeState(next);
    showToast(`Locked for this epoch: ${prompt.title}`);
  }

  function activateGate(gateId) {
    if (!GATES[gateId]) return;
    if (state.activeGates.includes(gateId)) {
      showToast(`${GATES[gateId].label} already active`);
      return;
    }
    writeState({ ...state, activeGates: [...state.activeGates, gateId] });
    showToast(`Output gate locked: ${GATES[gateId].label}`);
  }

  function usePrompt(prompt) {
    if (prompt.kind === 'gate') {
      addSessionConstraint(prompt);
      activateGate(prompt.gate);
    } else insertIntoComposer(prompt.body);
    closePanel();
  }

  function renderTreeNode(node, container, query = '') {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesPrompt = (prompt) => !normalizedQuery || `${prompt.title} ${prompt.path.join(' ')} ${prompt.body}`.toLowerCase().includes(normalizedQuery);

    for (const [name, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const childHasMatches = child.prompts.some(matchesPrompt) || [...child.children.values()].some((grand) => hasMatches(grand, matchesPrompt));
      if (!childHasMatches) continue;
      const wrapper = document.createElement('div');
      const button = document.createElement('button');
      button.className = 'tspr-category';
      button.textContent = name;
      const children = document.createElement('div');
      children.className = 'tspr-children';
      children.hidden = !normalizedQuery;
      button.addEventListener('click', () => { children.hidden = !children.hidden; });
      wrapper.append(button, children);
      container.append(wrapper);
      renderTreeNode(child, children, query);
    }

    for (const prompt of node.prompts.filter(matchesPrompt).sort((a, b) => a.title.localeCompare(b.title))) {
      const button = document.createElement('button');
      button.className = 'tspr-prompt';
      button.innerHTML = `<strong>${escapeHtml(prompt.title)}</strong><small>${escapeHtml(prompt.kind === 'gate' ? 'lock output gate' : 'insert into composer')}</small>`;
      button.addEventListener('click', () => usePrompt(prompt));
      container.append(button);
    }
  }

  function hasMatches(node, predicate) {
    return node.prompts.some(predicate) || [...node.children.values()].some((child) => hasMatches(child, predicate));
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function renderPanel(query = '') {
    const tree = panel.querySelector('.tspr-tree');
    tree.replaceChildren();
    renderTreeNode(buildMenuTree(allPrompts()), tree, query);
  }

  function openPanel() {
    panel.hidden = false;
    const input = panel.querySelector('input');
    input.value = '';
    renderPanel();
    input.focus();
  }

  function closePanel() {
    panel.hidden = true;
  }

  function updateButton() {
    if (!launcher) return;
    const contract = buildConstraintContract(state);
    launcher.textContent = `PROMPTS · ${state.activeGates.length} gates · ${contract.fingerprint}`;
    launcher.title = `${state.sessionConstraints.length} session constraints; epoch ${new Date(state.epoch).toLocaleString()}`;
  }

  function savePrompt(candidateOrCandidates) {
    const candidates = Array.isArray(candidateOrCandidates) ? candidateOrCandidates : [candidateOrCandidates];
    let selected = candidates[0];
    const modal = document.createElement('div');
    modal.className = 'tspr-modal';
    const selector = candidates.length > 1
      ? `<label>Detected candidate</label><select data-field="candidate">${candidates.map((candidate, index) => `<option value="${index}">${escapeHtml(candidate.title || `Candidate ${index + 1}`)}</option>`).join('')}</select>`
      : '';
    modal.innerHTML = `
      <div class="tspr-card">
        <strong>Save detected prompt</strong>
        ${selector}
        <label>Title</label><input data-field="title" value="${escapeHtml(selected.title || 'Captured prompt')}">
        <label>Hierarchy path</label><input data-field="path" value="Captured/${new Date().toISOString().slice(0, 10)}">
        <label>Prompt</label><textarea data-field="body"></textarea>
        <div class="tspr-actions"><button class="tspr-action" data-action="cancel">Cancel</button><button class="tspr-action" data-action="save">Save</button><button class="tspr-action" data-action="lock">Save + lock now</button></div>
      </div>`;
    const bodyField = modal.querySelector('[data-field="body"]');
    const titleField = modal.querySelector('[data-field="title"]');
    bodyField.value = selected.body;
    modal.querySelector('[data-field="candidate"]')?.addEventListener('change', (event) => {
      selected = candidates[Number(event.target.value)] || candidates[0];
      titleField.value = selected.title || 'Captured prompt';
      bodyField.value = selected.body;
    });
    modal.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'cancel') return modal.remove();
      const title = titleField.value.trim() || 'Captured prompt';
      const path = normalizePath(modal.querySelector('[data-field="path"]').value);
      const body = bodyField.value.trim();
      if (body.length < 20) return showToast('Prompt is too short');
      const prompt = { id: `saved-${Date.now()}-${fnv1a(body)}`, path, title, kind: 'insert', body };
      writeState({ ...state, savedPrompts: [...state.savedPrompts, prompt] });
      if (action === 'lock') addSessionConstraint(prompt);
      modal.remove();
      showToast(`Saved: ${title}`);
    });
    document.body.append(modal);
  }

  function showViolations(message, violations) {
    const modal = document.createElement('div');
    modal.className = 'tspr-modal';
    const details = violations.map((v) => `• ${v.label}: ${v.detail}`).join('\n');
    modal.innerHTML = `
      <div class="tspr-card">
        <strong>Response gate violations</strong>
        <pre>${escapeHtml(details)}</pre>
        <div class="tspr-actions"><button class="tspr-action" data-action="close">Close</button><button class="tspr-action" data-action="repair">Prepare repair prompt</button></div>
      </div>`;
    modal.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') modal.remove();
      if (action === 'repair') {
        const original = messageText(message).slice(0, 14000);
        insertIntoComposer(`Rewrite the preceding assistant response without losing any substantive content. Correct these deterministic gate violations:\n${details}\n\nOriginal response:\n<response>\n${original}\n</response>`);
        modal.remove();
      }
    });
    document.body.append(modal);
  }

  function messageText(message) {
    const clone = message.cloneNode(true);
    clone.querySelectorAll('.tspr-badge,.tspr-blocker').forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  function findAssistantMessages(root = document) {
    const explicit = [...root.querySelectorAll?.('[data-message-author-role="assistant"]') || []];
    if (explicit.length) return explicit;
    return [...root.querySelectorAll?.('article') || []].filter((node) => /assistant/i.test(node.getAttribute('data-testid') || node.getAttribute('aria-label') || ''));
  }

  function attachBadge(message, label, stateName, onClick) {
    const badge = document.createElement('button');
    badge.className = 'tspr-badge';
    badge.dataset.state = stateName;
    badge.textContent = label;
    badge.addEventListener('click', onClick);
    message.append(badge);
    return badge;
  }

  function applyBlocker(message, signature, violations) {
    message.querySelector(':scope > .tspr-blocker')?.remove();
    message.dataset.tsprBlocked = 'true';
    const blocker = document.createElement('div');
    blocker.className = 'tspr-blocker';
    const labels = [...new Set(violations.map((item) => item.label))].join(', ');
    blocker.innerHTML = `<div><strong>Blocked by output gate: ${escapeHtml(labels)}</strong><div>The model output is preserved but hidden because it violates a locked structural contract.</div><div class="tspr-actions"><button class="tspr-action" data-action="repair">Prepare repair</button><button class="tspr-action" data-action="reveal">Reveal blocked output</button></div></div>`;
    blocker.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'repair') showViolations(message, violations);
      if (action === 'reveal') {
        revealedMessages.set(message, signature);
        blocker.remove();
        delete message.dataset.tsprBlocked;
      }
    });
    message.append(blocker);
  }

  function scanMessage(message) {
    const text = messageText(message);
    if (!text || text.length < 10) return;
    const previous = processedMessages.get(message);
    const signature = fnv1a(text);
    if (previous === signature) return;
    processedMessages.set(message, signature);
    message.querySelectorAll(':scope > .tspr-badge,:scope > .tspr-blocker').forEach((node) => node.remove());
    delete message.dataset.tsprBlocked;

    if (state.promptDetection) {
      const candidates = detectPromptCandidates(text);
      if (candidates.length) {
        attachBadge(message, `Prompt detected · ${candidates.length}`, 'capture', () => savePrompt(candidates));
        showToast(`Prompt detected in assistant output (${candidates.length})`);
      }
    }

    if (state.responseValidation && state.activeGates.length) {
      const violations = validateResponse(text, state.activeGates);
      if (violations.length) {
        attachBadge(message, `${violations.length} gate violation${violations.length === 1 ? '' : 's'}`, 'fail', () => showViolations(message, violations));
        const structural = violations.some((item) => ['code-only', 'json-only', 'patch-only'].includes(item.gate));
        if (state.strictProjection && structural && revealedMessages.get(message) !== signature) applyBlocker(message, signature, violations);
      } else attachBadge(message, 'Gates pass', 'pass', () => showToast('All active deterministic gates pass'));
    }
  }

  function scanAllMessages() {
    for (const message of findAssistantMessages()) scanMessage(message);
  }

  function newEpoch() {
    const confirmed = window.confirm('Start a new constraint epoch? Built-in locked constraints remain. Session-added constraints and output gates reset to Direct language.');
    if (!confirmed) return;
    writeState({ ...state, sessionConstraints: [], activeGates: ['direct-language'], epoch: Date.now() });
    showToast('New constraint epoch started');
  }

  function exportLibrary() {
    const payload = JSON.stringify({ version: 1, prompts: state.savedPrompts }, null, 2);
    if (typeof GM_setClipboard === 'function') GM_setClipboard(payload, 'text');
    else navigator.clipboard?.writeText(payload);
    showToast('Saved prompt library copied');
  }

  function importLibrary() {
    const input = window.prompt('Paste an exported prompt-library JSON object:');
    if (!input) return;
    try {
      const parsed = JSON.parse(input);
      if (!Array.isArray(parsed.prompts)) throw new Error('prompts must be an array');
      const prompts = parsed.prompts.map((prompt) => ({
        id: prompt.id || `imported-${Date.now()}-${fnv1a(prompt.body || '')}`,
        path: normalizePath(prompt.path),
        title: String(prompt.title || 'Imported prompt'),
        kind: 'insert',
        body: String(prompt.body || '').trim()
      })).filter((prompt) => prompt.body.length >= 20);
      writeState({ ...state, savedPrompts: [...state.savedPrompts, ...prompts] });
      showToast(`Imported ${prompts.length} prompts`);
    } catch (error) {
      showToast(`Import failed: ${error.message}`, 5000);
    }
  }

  function createUi() {
    launcher = document.createElement('button');
    launcher.id = 'tspr-launcher';
    launcher.addEventListener('click', () => panel.hidden ? openPanel() : closePanel());

    panel = document.createElement('section');
    panel.id = 'tspr-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="tspr-head"><strong>Prompt runtime</strong><input type="search" placeholder="Search prompts"><button class="tspr-close">×</button></div>
      <div class="tspr-actions">
        <button class="tspr-action" data-action="contract">Inject contract</button>
        <button class="tspr-action" data-action="epoch">New epoch</button>
        <button class="tspr-action" data-action="export">Export</button>
        <button class="tspr-action" data-action="import">Import</button>
        <button class="tspr-action" data-action="projection">Strict projection: on</button>
        <button class="tspr-action" data-action="test">Self-test</button>
      </div>
      <div class="tspr-tree"></div>`;
    panel.querySelector('.tspr-close').addEventListener('click', closePanel);
    panel.querySelector('input').addEventListener('input', (event) => renderPanel(event.target.value));
    panel.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'contract') { ensureContractInComposer(); closePanel(); }
      if (action === 'epoch') newEpoch();
      if (action === 'export') exportLibrary();
      if (action === 'import') importLibrary();
      if (action === 'projection') {
        writeState({ ...state, strictProjection: !state.strictProjection });
        event.target.textContent = `Strict projection: ${state.strictProjection ? 'on' : 'off'}`;
        scanAllMessages();
      }
      if (action === 'test') {
        const result = runCoreSelfTest();
        showToast(result.ok ? 'Self-test PASS' : `Self-test FAIL: ${result.failures.join(', ')}`, 6000);
      }
    });
    document.body.append(launcher, panel);
    panel.querySelector('[data-action="projection"]').textContent = `Strict projection: ${state.strictProjection ? 'on' : 'off'}`;
    updateButton();
  }

  function isSendIntent(event) {
    if (event.type === 'keydown') {
      return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && findComposer()?.contains(event.target);
    }
    if (event.type === 'click') {
      const button = event.target.closest('button');
      if (!button) return false;
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('data-testid') || ''} ${button.title || ''}`;
      return /send|submit/i.test(label) && !panel?.contains(button);
    }
    if (event.type === 'submit') return Boolean(event.target.closest('form'));
    return false;
  }

  function sendGuard(event) {
    if (!isSendIntent(event)) return;
    ensureContractInComposer();
  }

  createUi();
  document.addEventListener('keydown', sendGuard, true);
  document.addEventListener('click', sendGuard, true);
  document.addEventListener('submit', sendGuard, true);

  const observer = new MutationObserver(() => {
    clearTimeout(observer._timer);
    observer._timer = setTimeout(scanAllMessages, 700);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(scanAllMessages, 1200);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Prompt Runtime: open menu', openPanel);
    GM_registerMenuCommand('Prompt Runtime: inject locked contract', ensureContractInComposer);
    GM_registerMenuCommand('Prompt Runtime: new constraint epoch', newEpoch);
    GM_registerMenuCommand('Prompt Runtime: run self-test', () => {
      const result = runCoreSelfTest();
      window.alert(result.ok ? 'Transductive Prompt Runtime self-test: PASS' : `FAIL\n${result.failures.join('\n')}`);
    });
  }
})();

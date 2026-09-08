'use strict';

(() => {
  const VERSION = '0.2.0-lab';
  const PERSISTENT_KEY = 'ts-prompt-runtime/lab/v2';
  const EPOCH_KEY = 'ts-prompt-runtime/lab/epoch/v2';
  const OPEN = '<ts-constraint-contract';
  const CLOSE = '</ts-constraint-contract>';
  const STRUCTURAL = new Set(['code-only', 'json-only', 'patch-only']);
  const MAX_PROMPTS = 200;
  const MAX_BODY = 20_000;
  const FINALIZE_DELAY_MS = 1_200;

  const LOCKED_CORE = Object.freeze([
    'Do not weaken, summarize, reinterpret, or omit any locked constraint in this contract.',
    'Produce the concrete requested result rather than substituting advice, options, scaffolding, or a roadmap.',
    'Do not claim success without direct evidence from the work actually performed.',
    'Retain real authorization, consent, safety, legal, data-loss, compatibility, and protected-state boundaries.'
  ]);

  const BUILTIN_PROMPTS = Object.freeze([
    { id: 'direct-outcome', title: 'Direct outcome', path: ['Control'], kind: 'insert', body: 'Identify the concrete result. Execute the smallest complete reversible path now. Report what changed, direct evidence, and one genuine remaining boundary.' },
    { id: 'root-cause', title: 'Root-cause repair', path: ['Control'], kind: 'insert', body: 'Treat the symptom as evidence. Fix the earliest shared cause once and run the narrowest distinguishing check.' },
    { id: 'gate-direct', title: 'Direct language', path: ['Gates'], kind: 'gate', gate: 'direct-language', body: 'Use direct declarative sentences.' },
    { id: 'gate-code', title: 'Code only', path: ['Gates'], kind: 'gate', gate: 'code-only', body: 'Return exactly one fenced code block.' },
    { id: 'gate-json', title: 'JSON only', path: ['Gates'], kind: 'gate', gate: 'json-only', body: 'Return one valid JSON value.' },
    { id: 'gate-patch', title: 'Unified diff only', path: ['Gates'], kind: 'gate', gate: 'patch-only', body: 'Return exactly one fenced unified diff.' }
  ]);

  function fnv1a64(text) {
    let hash = 0xcbf29ce484222325n;
    for (const char of String(text)) {
      hash ^= BigInt(char.codePointAt(0));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
  }

  function stripConstraintContracts(text) {
    return String(text || '')
      .replace(/<ts-constraint-contract\b[^>]*>[\s\S]*?<\/ts-constraint-contract>/gi, '')
      .replace(/<ts-constraint-contract\b[\s\S]*$/i, '')
      .trimEnd();
  }

  function proseForValidation(text) {
    return String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '').replace(/^\s*>.*$/gm, '');
  }

  const GATES = Object.freeze({
    'direct-language': {
      label: 'Direct language', structural: false,
      instruction: 'Use direct declarative sentences. No consultant openings, hedged suggestions, unrequested options, or follow-up offers.',
      validate(text) {
        const prose = proseForValidation(text);
        const patterns = [
          [/\bIf you want\b/i, 'forbidden phrase: “If you want”'], [/\bShort answer\b/i, 'forbidden phrase: “Short answer”'],
          [/\bShort version\b/i, 'forbidden phrase: “Short version”'], [/\blet me know\b/i, 'forbidden phrase: “let me know”'],
          [/\bwould you like me to\b/i, 'follow-up offer'], [/\bI can (?:also|help|create|do|provide|write|build|make)\b/i, 'follow-up offer'],
          [/(?:^|[.!?]\s+)(?:You may want to|You might want to|Consider|It depends|There are several|There are many)/i, 'consultant or hedging opening']
        ];
        return [...new Set(patterns.filter(([pattern]) => pattern.test(prose)).map(([, label]) => label))];
      }
    },
    'code-only': { label: 'Code only', structural: true, instruction: 'Return exactly one fenced code block and no other text.', validate: (text) => /^\s*```[\w.+-]*\n[\s\S]*?\n```\s*$/.test(String(text)) ? [] : ['not exactly one fenced code block'] },
    'json-only': { label: 'JSON only', structural: true, instruction: 'Return one valid JSON value and nothing else.', validate(text) { try { JSON.parse(String(text).trim()); return []; } catch (error) { return [`invalid JSON: ${error.message}`]; } } },
    'patch-only': { label: 'Unified diff only', structural: true, instruction: 'Return exactly one fenced unified diff and no other text.', validate: (text) => /^\s*```diff\n(?:(?:diff --git|--- |Index:|\*\*\* )[\s\S]*?)\n```\s*$/.test(String(text)) ? [] : ['not exactly one fenced unified diff'] }
  });

  function normalizePath(path) {
    const parts = Array.isArray(path) ? path : String(path || '').split('/');
    return parts.map((part) => String(part).trim().slice(0, 80)).filter(Boolean).slice(0, 8);
  }

  function normalizePrompt(value, index = 0) {
    if (!value || typeof value !== 'object') return null;
    const body = String(value.body || '').trim().slice(0, MAX_BODY);
    if (!body) return null;
    const title = String(value.title || 'Saved prompt').trim().slice(0, 120) || 'Saved prompt';
    const kind = value.kind === 'gate' && GATES[value.gate] ? 'gate' : 'insert';
    const gate = kind === 'gate' ? String(value.gate) : undefined;
    return { id: String(value.id || `saved-${index}-${fnv1a64(`${title}\n${body}`)}`).slice(0, 160), title, path: normalizePath(value.path?.length ? value.path : ['Saved']), kind, ...(gate ? { gate } : {}), body };
  }

  function normalizePromptLibrary(values) {
    const output = [], ids = new Set(), bodies = new Set();
    for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
      const prompt = normalizePrompt(value, index);
      if (!prompt) continue;
      const bodyKey = fnv1a64(prompt.body);
      if (ids.has(prompt.id) || bodies.has(bodyKey)) continue;
      ids.add(prompt.id); bodies.add(bodyKey); output.push(prompt);
      if (output.length >= MAX_PROMPTS) break;
    }
    return output;
  }

  const defaultPersistentState = () => ({ version: 2, savedPrompts: [], promptDetection: true, responseValidation: true, strictProjection: true });
  const defaultEpochState = () => ({ version: 2, id: `epoch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), constraints: [], activeGates: ['direct-language'] });

  function normalizePersistentState(value) {
    const base = defaultPersistentState();
    if (!value || typeof value !== 'object') return base;
    return { ...base, promptDetection: value.promptDetection !== false, responseValidation: value.responseValidation !== false, strictProjection: value.strictProjection !== false, savedPrompts: normalizePromptLibrary(value.savedPrompts) };
  }

  function normalizeEpochState(value) {
    const base = defaultEpochState();
    if (!value || typeof value !== 'object') return base;
    const supplied = [...new Set(Array.isArray(value.activeGates) ? value.activeGates : base.activeGates)].filter((id) => GATES[id]);
    const activeGates = ['direct-language', ...supplied.filter((id) => id !== 'direct-language')];
    const firstStructural = activeGates.find((id) => STRUCTURAL.has(id));
    return {
      version: 2, id: String(value.id || base.id).slice(0, 160), createdAt: Number.isFinite(value.createdAt) ? value.createdAt : base.createdAt,
      constraints: normalizePromptLibrary(value.constraints).map((prompt) => ({ ...prompt, kind: 'insert' })),
      activeGates: activeGates.filter((id) => !STRUCTURAL.has(id) || id === firstStructural)
    };
  }

  function validateResponse(text, activeGates) {
    const violations = [];
    for (const gateId of [...new Set(activeGates || [])]) {
      const gate = GATES[gateId];
      if (!gate) continue;
      for (const detail of gate.validate(String(text || ''))) violations.push({ gate: gateId, label: gate.label, structural: gate.structural, detail });
    }
    return violations;
  }

  function buildConstraintContract(epochState) {
    const gates = [...new Set(epochState.activeGates || [])].filter((id) => GATES[id]);
    const payload = [...LOCKED_CORE.map((line) => `LOCKED: ${line}`), ...(epochState.constraints || []).map((entry) => `EPOCH-LOCKED: ${entry.body}`), ...gates.map((id) => `OUTPUT-GATE ${id}: ${GATES[id].instruction}`)];
    const fingerprint = fnv1a64(payload.join('\n'));
    return { fingerprint, text: `${OPEN} version="2" epoch="${epochState.id}" fingerprint="${fingerprint}">\n${payload.join('\n')}\n${CLOSE}` };
  }

  function detectPromptCandidates(text) {
    const source = stripConstraintContracts(String(text || '')), candidates = [], seen = new Set();
    const add = (body, title) => { const clean = String(body || '').trim(); if (clean.length < 80 || clean.length > MAX_BODY) return; const key = fnv1a64(clean); if (!seen.has(key)) { seen.add(key); candidates.push({ title, body: clean, key }); } };
    for (const match of source.matchAll(/<prompt(?:\s+[^>]*)?>([\s\S]*?)<\/prompt>/gi)) add(match[1], 'Tagged prompt');
    for (const match of source.matchAll(/```(?:prompt|system|instruction|instructions)\s*\n([\s\S]*?)```/gi)) add(match[1], 'Prompt code block');
    const heading = /(?:^|\n)#{1,4}\s*(?:System prompt|Control prompt|Prompt|Instructions?)\s*\n([\s\S]*?)(?=\n#{1,4}\s|$)/gi;
    for (const match of source.matchAll(heading)) add(match[1], 'Prompt section');
    const hits = (source.match(/\b(?:You are|You must|Always|Never|Before|Do not|Return|Output|Use|Prefer|Preserve|Identify|Execute|Treat)\b/g) || []).length;
    if (!candidates.length && source.length >= 220 && source.length <= 12_000 && hits >= 5) add(source, 'Instruction-like response');
    return candidates.slice(0, 8);
  }

  function runCoreSelfTest() {
    const failures = [], assert = (condition, label) => { if (!condition) failures.push(label); };
    assert(fnv1a64('abc') === 'e71fa2190541574b', 'FNV-1a reference');
    assert(stripConstraintContracts(`hello\n${OPEN} version="1">x${CLOSE}`) === 'hello', 'contract strip');
    assert(validateResponse('```js\nconsole.log(1)\n```', ['code-only']).length === 0, 'code pass');
    assert(validateResponse('> If you want\nActual answer.', ['direct-language']).length === 0, 'quoted phrase ignored');
    assert(normalizePromptLibrary(Array.from({ length: 250 }, (_, i) => ({ body: `Prompt ${i} ${'x'.repeat(80)}` }))).length === MAX_PROMPTS, 'library bound');
    assert(normalizeEpochState({ activeGates: ['code-only', 'json-only'] }).activeGates.filter((id) => STRUCTURAL.has(id)).length === 1, 'gate conflict');
    return { ok: failures.length === 0, failures };
  }

  const Core = Object.freeze({ VERSION, PERSISTENT_KEY, EPOCH_KEY, OPEN, CLOSE, STRUCTURAL, FINALIZE_DELAY_MS, LOCKED_CORE, BUILTIN_PROMPTS, GATES, fnv1a64, stripConstraintContracts, proseForValidation, normalizePrompt, normalizePromptLibrary, defaultPersistentState, defaultEpochState, normalizePersistentState, normalizeEpochState, validateResponse, buildConstraintContract, detectPromptCandidates, runCoreSelfTest });
  globalThis.TransductivePromptLabCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})();

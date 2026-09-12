export const EVENT_RULES_STORAGE_KEY = "tf.eventRules.v1";
export const EVENT_RULES_SCHEMA = "tf-event-rules/v1";

export interface EventRule {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  scope: string;
  actionSummary: string;
  detectorCode: string;
  actionCode: string;
  debounceMs: number;
  cooldownMs: number;
  backoffMs: number;
}

export interface EventRulesConfig {
  schema: typeof EVENT_RULES_SCHEMA;
  rules: EventRule[];
}

const TOO_MANY_REQUESTS_DETECTOR = `function detect(ctx) {
  const roots = [
    ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
  ];

  if (!roots.length) {
    for (const el of document.querySelectorAll('body > div')) {
      const text = ctx.norm(el.textContent);
      if (
        text.includes('too many requests') &&
        text.includes('temporarily limited access')
      ) {
        roots.push(el);
      }
    }
  }

  for (const root of roots) {
    const text = ctx.norm(root.textContent);
    if (!text.includes('too many requests')) continue;
    if (!text.includes('making requests too quickly')) continue;
    if (!text.includes('temporarily limited access')) continue;

    const button = [...root.querySelectorAll('button')]
      .find((node) => ctx.norm(node.textContent) === 'got it');
    if (!button) continue;

    return {
      matched: true,
      root,
      button,
      evidence: {
        title: 'Too many requests',
        action: 'Got it',
      },
    };
  }

  return { matched: false };
}`;

const TOO_MANY_REQUESTS_ACTION = `async function act(ctx, match) {
  const backoffMs = ctx.rule.backoffMs;

  await ctx.globalPause?.({
    reason: 'RATE_LIMIT',
    backoffMs,
    sourceRuleId: ctx.rule.id,
  });

  match.button?.click();

  return {
    action: 'dismiss_and_backoff',
    backoffMs,
  };
}`;

export function defaultEventRulesConfig(): EventRulesConfig {
  return {
    schema: EVENT_RULES_SCHEMA,
    rules: [
      {
        id: "too-many-requests",
        name: "Too many requests",
        enabled: true,
        type: "blocking_dialog",
        scope: "browser-global",
        actionSummary: "Pause globally, click ‘Got it’, back off, then canary retry",
        detectorCode: TOO_MANY_REQUESTS_DETECTOR,
        actionCode: TOO_MANY_REQUESTS_ACTION,
        debounceMs: 250,
        cooldownMs: 5_000,
        backoffMs: 5 * 60_000,
      },
    ],
  };
}

export function normalizeEventRulesConfig(value: unknown): EventRulesConfig {
  if (!value || typeof value !== "object") return defaultEventRulesConfig();
  const candidate = value as Partial<EventRulesConfig>;
  if (!Array.isArray(candidate.rules)) return defaultEventRulesConfig();

  return {
    schema: EVENT_RULES_SCHEMA,
    rules: candidate.rules.map((rule, index) => {
      const r = (rule ?? {}) as Partial<EventRule>;
      return {
        id: String(r.id || `event-${index + 1}`),
        name: String(r.name || `Event ${index + 1}`),
        enabled: r.enabled !== false,
        type: String(r.type || "page_event"),
        scope: String(r.scope || "tab"),
        actionSummary: String(r.actionSummary || ""),
        detectorCode: String(r.detectorCode || "function detect() { return { matched: false }; }"),
        actionCode: String(r.actionCode || "async function act() {}"),
        debounceMs: Number.isFinite(r.debounceMs) ? Number(r.debounceMs) : 250,
        cooldownMs: Number.isFinite(r.cooldownMs) ? Number(r.cooldownMs) : 5_000,
        backoffMs: Number.isFinite(r.backoffMs) ? Number(r.backoffMs) : 0,
      };
    }),
  };
}

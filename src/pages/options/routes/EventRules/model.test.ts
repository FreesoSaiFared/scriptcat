import { describe, expect, it } from "vitest";
import {
  EVENT_RULES_SCHEMA,
  EVENT_RULES_STORAGE_KEY,
  defaultEventRulesConfig,
  normalizeEventRulesConfig,
} from "./model";

describe("event rule model", () => {
  it("ships the Too many requests rule as the first default", () => {
    const config = defaultEventRulesConfig();
    expect(EVENT_RULES_STORAGE_KEY).toBe("tf.eventRules.v1");
    expect(config.schema).toBe(EVENT_RULES_SCHEMA);
    expect(config.rules).toHaveLength(1);

    const rule = config.rules[0];
    expect(rule.id).toBe("too-many-requests");
    expect(rule.enabled).toBe(true);
    expect(rule.type).toBe("blocking_dialog");
    expect(rule.scope).toBe("browser-global");
    expect(rule.detectorCode).toContain("too many requests");
    expect(rule.detectorCode).toContain("temporarily limited access");
    expect(rule.detectorCode).toContain("got it");
    expect(rule.actionCode).toContain("globalPause");
    expect(rule.backoffMs).toBe(300_000);
  });

  it("falls back to defaults for missing or invalid configuration", () => {
    expect(normalizeEventRulesConfig(undefined)).toEqual(defaultEventRulesConfig());
    expect(normalizeEventRulesConfig({ rules: "bad" })).toEqual(defaultEventRulesConfig());
  });

  it("normalizes partial persisted rules without losing source", () => {
    const config = normalizeEventRulesConfig({
      rules: [
        {
          id: "custom",
          name: "Custom event",
          enabled: false,
          detectorCode: "function detect() { return { matched: true }; }",
          actionCode: "async function act() { return 1; }",
          debounceMs: 100,
        },
      ],
    });

    expect(config.schema).toBe(EVENT_RULES_SCHEMA);
    expect(config.rules[0]).toMatchObject({
      id: "custom",
      name: "Custom event",
      enabled: false,
      type: "page_event",
      scope: "tab",
      debounceMs: 100,
      cooldownMs: 5_000,
      backoffMs: 0,
    });
    expect(config.rules[0].detectorCode).toContain("matched: true");
  });
});

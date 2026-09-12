import { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { i18nName } from "@App/locales/locales";
import { Button } from "@App/pages/components/ui/button";
import { Input } from "@App/pages/components/ui/input";
import { notify } from "@App/pages/components/ui/toast";
import { fetchScript, valueClient } from "@App/pages/store/features/script";
import { useScriptDataManagement } from "../ScriptList/hooks";
import { StorageValueEditor } from "../ScriptEditor/tabs/StorageValueEditor";
import {
  EVENT_RULES_STORAGE_KEY,
  defaultEventRulesConfig,
  normalizeEventRulesConfig,
  type EventRule,
  type EventRulesConfig,
} from "./model";

const newRule = (index: number): EventRule => ({
  id: `event-${Date.now()}-${index}`,
  name: `Event ${index}`,
  enabled: true,
  type: "page_event",
  scope: "tab",
  actionSummary: "",
  detectorCode: "function detect(ctx) {\n  return { matched: false };\n}",
  actionCode: "async function act(ctx, match) {\n}\n",
  debounceMs: 250,
  cooldownMs: 5_000,
  backoffMs: 0,
});

export default function EventRules() {
  const { scriptList, loadingList } = useScriptDataManagement();
  const preferredUuid = useMemo(() => {
    const continuation = scriptList.find((script) =>
      i18nName(script).toLowerCase().includes("chatgpt continuation controller")
    );
    return continuation?.uuid ?? scriptList[0]?.uuid ?? "";
  }, [scriptList]);

  const [uuid, setUuid] = useState("");
  const [config, setConfig] = useState<EventRulesConfig>(defaultEventRulesConfig);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!uuid && preferredUuid) setUuid(preferredUuid);
  }, [preferredUuid, uuid]);

  useEffect(() => {
    if (!uuid) return;
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        const script = await fetchScript(uuid);
        if (!script) throw new Error("Script not found");
        const values = await valueClient.getScriptValue(script);
        if (!active) return;
        const next = normalizeEventRulesConfig(values[EVENT_RULES_STORAGE_KEY]);
        setConfig(next);
        setSelected(0);
      } catch (error) {
        if (active) notify.error(`Could not load event rules: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [uuid]);

  const rule = config.rules[selected];
  const patchRule = (patch: Partial<EventRule>) => {
    setConfig((current) => ({
      ...current,
      rules: current.rules.map((item, index) => (index === selected ? { ...item, ...patch } : item)),
    }));
  };

  const save = async () => {
    if (!uuid) return;
    setSaving(true);
    try {
      await valueClient.setScriptValue({
        uuid,
        key: EVENT_RULES_STORAGE_KEY,
        value: config,
        ts: Date.now(),
      });
      notify.success("Event rules saved");
    } catch (error) {
      notify.error(`Could not save event rules: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setConfig(defaultEventRulesConfig());
    setSelected(0);
  };

  const addRule = () => {
    setConfig((current) => {
      const next = [...current.rules, newRule(current.rules.length + 1)];
      setSelected(next.length - 1);
      return { ...current, rules: next };
    });
  };

  const deleteRule = () => {
    setConfig((current) => {
      const next = current.rules.filter((_, index) => index !== selected);
      setSelected(Math.max(0, Math.min(selected, next.length - 1)));
      return { ...current, rules: next };
    });
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-custom px-8 py-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-80 flex-1">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Target userscript</div>
            <select
              value={uuid}
              onChange={(event) => setUuid(event.target.value)}
              disabled={loadingList}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {scriptList.map((script) => (
                <option key={script.uuid} value={script.uuid}>
                  {i18nName(script)}
                </option>
              ))}
            </select>
          </div>
          <Button variant="outline" onClick={reset} disabled={loading || saving}>
            <RotateCcw className="size-4" /> Reset defaults
          </Button>
          <Button onClick={() => void save()} disabled={!uuid || loading || saving}>
            <Save className="size-4" /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>

        <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
          Rules are stored in the selected userscript as <code>{EVENT_RULES_STORAGE_KEY}</code>. The runtime owns observation,
          debounce, execution, backoff and postcondition checks; this page only edits the rule source and parameters.
        </div>

        <div className="grid min-h-[680px] grid-cols-[260px_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card">
          <aside className="border-r border-border p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">Event rules</div>
              <Button size="sm" variant="outline" onClick={addRule} disabled={loading}>
                <Plus className="size-3.5" /> Add
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              {config.rules.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelected(index)}
                  className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    index === selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                  }`}
                >
                  <div className="truncate font-medium">{item.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.enabled ? "enabled" : "disabled"} · {item.type}
                  </div>
                </button>
              ))}
              {!config.rules.length && <div className="px-3 py-8 text-center text-xs text-muted-foreground">No rules</div>}
            </div>
          </aside>

          <main className="min-w-0 p-5">
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading event rules…</div>
            ) : rule ? (
              <div className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => patchRule({ enabled: event.target.checked })}
                    />
                    Enabled
                  </label>
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" onClick={deleteRule}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Event">
                    <Input value={rule.name} onChange={(event) => patchRule({ name: event.target.value })} />
                  </Field>
                  <Field label="Rule ID">
                    <Input value={rule.id} onChange={(event) => patchRule({ id: event.target.value })} />
                  </Field>
                  <Field label="Type">
                    <Input value={rule.type} onChange={(event) => patchRule({ type: event.target.value })} />
                  </Field>
                  <Field label="Scope">
                    <Input value={rule.scope} onChange={(event) => patchRule({ scope: event.target.value })} />
                  </Field>
                </div>

                <Field label="Actions">
                  <Input
                    value={rule.actionSummary}
                    placeholder="Human-readable action summary"
                    onChange={(event) => patchRule({ actionSummary: event.target.value })}
                  />
                </Field>

                <div className="grid grid-cols-3 gap-4">
                  <NumberField label="Debounce (ms)" value={rule.debounceMs} onChange={(value) => patchRule({ debounceMs: value })} />
                  <NumberField label="Cooldown (ms)" value={rule.cooldownMs} onChange={(value) => patchRule({ cooldownMs: value })} />
                  <NumberField label="Backoff (ms)" value={rule.backoffMs} onChange={(value) => patchRule({ backoffMs: value })} />
                </div>

                <Field label="Detection code" hint="function detect(ctx) → { matched, ...evidence }">
                  <StorageValueEditor
                    id={`event-detector-${uuid}-${rule.id}`}
                    value={rule.detectorCode}
                    language="plaintext"
                    ariaLabel="Detection code"
                    className="h-[330px]"
                    onChange={(value) => patchRule({ detectorCode: value })}
                  />
                </Field>

                <Field label="Action code" hint="async function act(ctx, match) → result">
                  <StorageValueEditor
                    id={`event-action-${uuid}-${rule.id}`}
                    value={rule.actionCode}
                    language="plaintext"
                    ariaLabel="Action code"
                    className="h-[260px]"
                    onChange={(value) => patchRule({ actionCode: value })}
                  />
                </Field>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Add an event rule to begin.</div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline gap-2 text-xs font-medium text-foreground">
        {label}
        {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
      />
    </Field>
  );
}

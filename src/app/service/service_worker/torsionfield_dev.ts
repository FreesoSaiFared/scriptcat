import type { Script, ScriptDAO } from "@App/app/repo/scripts";
import { parseMetadata } from "@App/pkg/utils/script";
import type { Group } from "@Packages/message/server";
import { v5 as uuidv5 } from "uuid";
import type { ScriptService } from "./script";

export const TORSIONFIELD_PROTOCOL_VERSION = "torsionfield-script-v1" as const;

const RECEIPTS_KEY = "torsionfield_dev_receipts_v1";
const RELOAD_KEY = "torsionfield_dev_reload_v1";
const FIXTURE_URL_KEY = "torsionfield_dev_fixture_url_v1";
const MAX_RECEIPTS = 100;
const RELOAD_TTL_MS = 60_000;
const RELOAD_WAKE_ALARM = "torsionfield_dev_reload_wake_v1";
const RELOAD_WAKE_DELAY_MS = 1_500;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_INTERVAL_MS = 200;
const VERIFY_RELOAD_INTERVAL_MS = 2_000;
const TAB_INVOKE_TIMEOUT_MS = 5_000;
const TAB_ACTION_VALUE_MAX_BYTES = 256;
const FIXTURE_MARKER_SELECTOR = "#torsionfield-shared-marker" as const;
const FIXTURE_MARKER_ATTRIBUTE = "data-value" as const;

export type TorsionfieldDevAction =
  | "install"
  | "update"
  | "status"
  | "reload"
  | "disable"
  | "enable"
  | "remove"
  | "tab.register"
  | "tab.list"
  | "tab.invoke";

export interface TorsionfieldFixtureTab {
  tabId: number;
  url: string;
}

export interface TorsionfieldTabPostcondition {
  tabId: number;
  url: string;
  selector: typeof FIXTURE_MARKER_SELECTOR;
  text: string | null;
  attribute: { name: typeof FIXTURE_MARKER_ATTRIBUTE; value: string | null };
  visible: boolean;
}

export interface TorsionfieldExecutionVerificationRequest {
  url: string;
  selector: string;
  attribute?: { name: string; value: string };
  text?: string;
  expectAbsent?: boolean;
}

export type TorsionfieldExecutionVerification =
  | { status: "not_run" }
  | {
      status: "passed" | "failed";
      url: string;
      selector: string;
      observed?: { present: boolean; attributeValue: string | null; text: string | null };
      error?: string;
    };

export interface TorsionfieldDevRequest {
  protocolVersion: typeof TORSIONFIELD_PROTOCOL_VERSION;
  operationId: string;
  requestedAction: TorsionfieldDevAction;
  token: string;
  sourceUri?: string;
  code?: string;
  subjectOperationId?: string;
  verification?: TorsionfieldExecutionVerificationRequest;
  fixtureUrl?: string;
  tabId?: number;
  tabAction?: string;
  value?: string;
}

export interface TorsionfieldDevResult {
  protocolVersion: typeof TORSIONFIELD_PROTOCOL_VERSION;
  operationId: string;
  requestedAction: TorsionfieldDevAction;
  subjectOperationId?: string;
  trustAccepted: boolean;
  trustClassification:
    | "trusted_local_file"
    | "trusted_loopback_url"
    | "trusted_local_channel"
    | "rejected_invalid_token"
    | "rejected_untrusted_source"
    | "transport_unavailable";
  scriptId: string | null;
  scriptName: string | null;
  requestedVersion: string | null;
  installedVersion: string | null;
  attemptCount: number;
  finalStatus: "in_progress" | "succeeded" | "failed" | "rejected";
  executionVerification: TorsionfieldExecutionVerification;
  fixtureUrl?: string | null;
  tabs?: TorsionfieldFixtureTab[];
  postcondition?: TorsionfieldTabPostcondition | null;
  error: string | null;
}

type ReceiptStore = Record<string, TorsionfieldDevResult>;

type ReloadMarker = { operationId: string; expiresAt: number };

interface FixtureProbe {
  accepted: boolean;
  url: string;
  readyState: DocumentReadyState;
}

interface FixtureDispatch {
  accepted: boolean;
  dispatched: boolean;
  url: string;
}

interface FixtureObservation {
  accepted: boolean;
  matched: boolean;
  url: string;
  text: string | null;
  attributeValue: string | null;
  visible: boolean;
}

interface TorsionfieldDevServiceOptions {
  token: string;
  verifyExecution?: (request: TorsionfieldExecutionVerificationRequest) => Promise<TorsionfieldExecutionVerification>;
  reloadExtension?: () => void;
  scheduleReloadWake?: () => Promise<void>;
}

const noVerification = (): TorsionfieldExecutionVerification => ({ status: "not_run" });

const scheduleTorsionfieldReloadWake = (): Promise<void> =>
  new Promise((resolveSchedule, rejectSchedule) => {
    chrome.alarms.create(RELOAD_WAKE_ALARM, { when: Date.now() + RELOAD_WAKE_DELAY_MS }, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        rejectSchedule(new Error(`failed to schedule Torsionfield reload wake: ${lastError.message}`));
        return;
      }
      resolveSchedule();
    });
  });

const preciseError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
};

const readReceipts = async (): Promise<ReceiptStore> => {
  const value = await chrome.storage.local.get(RECEIPTS_KEY);
  return (value[RECEIPTS_KEY] as ReceiptStore | undefined) ?? {};
};

const writeReceipt = async (receipt: TorsionfieldDevResult): Promise<void> => {
  const receipts = await readReceipts();
  delete receipts[receipt.operationId];
  receipts[receipt.operationId] = receipt;
  const entries = Object.entries(receipts);
  const trimmed = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_RECEIPTS)));
  await chrome.storage.local.set({ [RECEIPTS_KEY]: trimmed });
};

const readFixtureUrl = async (): Promise<string | null> => {
  const value = await chrome.storage.local.get(FIXTURE_URL_KEY);
  return typeof value[FIXTURE_URL_KEY] === "string" ? value[FIXTURE_URL_KEY] : null;
};

const normalizeLoopbackHttpUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback || url.username || url.password) {
    return null;
  }
  return url.href;
};

const fixtureTab = (tab: chrome.tabs.Tab): TorsionfieldFixtureTab | null =>
  tab.id === undefined || !tab.url ? null : { tabId: tab.id, url: tab.url };

// executeScript 会序列化函数体，因此每个函数都在目标页面内重新执行完整的 URL 边界检查。
const probeFixtureTab = (expectedUrl: string): FixtureProbe => {
  const currentUrl = location.href;
  let accepted = false;
  try {
    const url = new URL(currentUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    accepted =
      (url.protocol === "http:" || url.protocol === "https:") &&
      loopback &&
      !url.username &&
      !url.password &&
      url.href === expectedUrl;
  } catch {
    accepted = false;
  }
  return { accepted, url: currentUrl, readyState: document.readyState };
};

const dispatchFixtureChangeMarker = (expectedUrl: string, value: string): FixtureDispatch => {
  const currentUrl = location.href;
  let accepted = false;
  try {
    const url = new URL(currentUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    accepted =
      (url.protocol === "http:" || url.protocol === "https:") &&
      loopback &&
      !url.username &&
      !url.password &&
      url.href === expectedUrl;
  } catch {
    accepted = false;
  }
  if (!accepted) return { accepted: false, dispatched: false, url: currentUrl };
  document.dispatchEvent(new CustomEvent("torsionfield:fixture-change-marker", { detail: value }));
  return { accepted: true, dispatched: true, url: currentUrl };
};

const inspectFixtureChangeMarker = (expectedUrl: string, expectedValue: string): FixtureObservation => {
  const currentUrl = location.href;
  let accepted = false;
  try {
    const url = new URL(currentUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    accepted =
      (url.protocol === "http:" || url.protocol === "https:") &&
      loopback &&
      !url.username &&
      !url.password &&
      url.href === expectedUrl;
  } catch {
    accepted = false;
  }
  if (!accepted) {
    return {
      accepted: false,
      matched: false,
      url: currentUrl,
      text: null,
      attributeValue: null,
      visible: false,
    };
  }

  const marker = document.querySelector("#torsionfield-shared-marker");
  const style = marker instanceof HTMLElement ? getComputedStyle(marker) : null;
  const visible = Boolean(
    marker instanceof HTMLElement &&
      !marker.hidden &&
      style?.display !== "none" &&
      style?.visibility !== "hidden" &&
      style?.opacity !== "0"
  );
  const text = marker?.textContent ?? null;
  const attributeValue = marker?.getAttribute("data-value") ?? null;
  return {
    accepted: true,
    matched: visible && text === expectedValue && attributeValue === expectedValue,
    url: currentUrl,
    text,
    attributeValue,
    visible,
  };
};

export const consumeTorsionfieldDevReload = async (): Promise<boolean> => {
  const value = await chrome.storage.local.get(RELOAD_KEY);
  const marker = value[RELOAD_KEY] as ReloadMarker | undefined;
  await chrome.storage.local.remove(RELOAD_KEY);
  return Boolean(marker && marker.expiresAt >= Date.now());
};

const classifySource = (
  sourceUri: string | undefined
): Pick<TorsionfieldDevResult, "trustAccepted" | "trustClassification"> => {
  if (!sourceUri) {
    return { trustAccepted: false, trustClassification: "rejected_untrusted_source" };
  }
  let url: URL;
  try {
    url = new URL(sourceUri);
  } catch {
    return { trustAccepted: false, trustClassification: "rejected_untrusted_source" };
  }
  if (url.protocol === "file:") {
    return { trustAccepted: true, trustClassification: "trusted_local_file" };
  }
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol === "http:" || url.protocol === "https:") && isLoopback) {
    return { trustAccepted: true, trustClassification: "trusted_loopback_url" };
  }
  return { trustAccepted: false, trustClassification: "rejected_untrusted_source" };
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const inspectFixture = (
  selector: string,
  attribute: { name: string; value: string } | null,
  text: string | null,
  expectAbsent: boolean
) => {
  const elements = [...document.querySelectorAll(selector)];
  const element =
    elements.find(
      (candidate) =>
        (!attribute || candidate.getAttribute(attribute.name) === attribute.value) &&
        (!text || candidate.textContent?.includes(text) === true)
    ) ??
    elements[0] ??
    null;
  const observed = {
    present: element !== null,
    attributeValue: element && attribute ? element.getAttribute(attribute.name) : null,
    text: element?.textContent ?? null,
  };
  return {
    passed:
      document.readyState === "complete" &&
      (expectAbsent
        ? elements.length === 0
        : elements.some(
            (candidate) =>
              (!attribute || candidate.getAttribute(attribute.name) === attribute.value) &&
              (!text || candidate.textContent?.includes(text) === true)
          )),
    observed,
  };
};

export const verifyTorsionfieldExecution = async (
  request: TorsionfieldExecutionVerificationRequest
): Promise<TorsionfieldExecutionVerification> => {
  const trust = classifySource(request.url);
  if (!trust.trustAccepted || trust.trustClassification !== "trusted_loopback_url") {
    return {
      status: "failed",
      url: request.url,
      selector: request.selector,
      error: "verification URL must be a loopback HTTP(S) URL",
    };
  }

  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((candidate) => candidate.url === request.url && candidate.id !== undefined);
  if (!tab) {
    tab = await chrome.tabs.create({ url: request.url, active: false });
  } else {
    await chrome.tabs.reload(tab.id!);
  }
  if (tab.id === undefined) {
    return { status: "failed", url: request.url, selector: request.selector, error: "fixture tab has no id" };
  }

  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let nextReloadAt = Date.now() + VERIFY_RELOAD_INTERVAL_MS;
  const requiredConsecutiveMatches = request.expectAbsent ? 5 : 1;
  let consecutiveMatches = 0;
  let observed: { present: boolean; attributeValue: string | null; text: string | null } | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: inspectFixture,
        args: [request.selector, request.attribute ?? null, request.text ?? null, request.expectAbsent ?? false],
      });
      observed = result?.result?.observed;
      if (result?.result?.passed) {
        consecutiveMatches += 1;
        if (consecutiveMatches >= requiredConsecutiveMatches) {
          return { status: "passed", url: request.url, selector: request.selector, observed };
        }
      } else {
        consecutiveMatches = 0;
      }
    } catch (error) {
      lastError = preciseError(error);
    }
    if (Date.now() >= nextReloadAt) {
      try {
        await chrome.tabs.reload(tab.id);
        consecutiveMatches = 0;
      } catch (error) {
        lastError = preciseError(error);
      }
      nextReloadAt = Date.now() + VERIFY_RELOAD_INTERVAL_MS;
    }
    await wait(VERIFY_INTERVAL_MS);
  }

  return {
    status: "failed",
    url: request.url,
    selector: request.selector,
    observed,
    error: lastError ?? "expected fixture marker was not observed before timeout",
  };
};

export class TorsionfieldDevService {
  private readonly verifyExecution: (
    request: TorsionfieldExecutionVerificationRequest
  ) => Promise<TorsionfieldExecutionVerification>;

  constructor(
    private readonly group: Group,
    private readonly scriptService: Pick<ScriptService, "installByCode" | "enableScript" | "deleteScript">,
    private readonly scriptDAO: Pick<ScriptDAO, "get">,
    private readonly options: TorsionfieldDevServiceOptions
  ) {
    this.verifyExecution = options.verifyExecution ?? verifyTorsionfieldExecution;
  }

  init(): void {
    this.group.on("execute", (request: TorsionfieldDevRequest) => this.execute(request));
  }

  async execute(request: TorsionfieldDevRequest): Promise<TorsionfieldDevResult> {
    const previous = (await readReceipts())[request.operationId];
    if (previous && previous.finalStatus !== "in_progress") return previous;

    if (request.protocolVersion !== TORSIONFIELD_PROTOCOL_VERSION) {
      return this.reject(request, "rejected_invalid_token", "unsupported protocol version");
    }
    if (!this.options.token || request.token !== this.options.token) {
      return this.reject(request, "rejected_invalid_token", "invalid trusted development channel token");
    }
    if (request.requestedAction === "tab.register") return this.registerTab(request);
    if (request.requestedAction === "tab.list") return this.listTabs(request);
    if (request.requestedAction === "tab.invoke") return this.invokeTab(request);
    if (request.requestedAction === "status") return this.status(request);
    if (request.requestedAction === "reload") return this.reload(request);

    const trust = classifySource(request.sourceUri);
    if (!trust.trustAccepted) {
      return this.reject(request, "rejected_untrusted_source", "source must be a local file or loopback HTTP(S) URL");
    }

    const scriptId = uuidv5(request.sourceUri!, uuidv5.URL);
    const existing = await this.scriptDAO.get(scriptId);
    const metadata = request.code ? parseMetadata(request.code) : null;
    const scriptName = metadata?.name?.[0] ?? existing?.name ?? null;
    const requestedVersion = metadata?.version?.[0] ?? existing?.metadata.version?.[0] ?? null;
    const attemptCount = (previous?.attemptCount ?? 0) + 1;
    const base = this.result(request, {
      ...trust,
      scriptId,
      scriptName,
      requestedVersion,
      attemptCount,
      finalStatus: "in_progress",
    });
    await writeReceipt(base);

    try {
      if (
        request.requestedAction === "disable" ||
        request.requestedAction === "enable" ||
        request.requestedAction === "remove"
      ) {
        if (!existing) throw new Error(`script is not installed: ${scriptId}`);
        if (request.requestedAction === "remove") {
          await this.scriptService.deleteScript(scriptId, "torsionfield");
        } else {
          await this.scriptService.enableScript({ uuid: scriptId, enable: request.requestedAction === "enable" });
        }
        const remaining = await this.scriptDAO.get(scriptId);
        if (request.requestedAction === "remove" && remaining)
          throw new Error(`script removal did not persist: ${scriptId}`);
        const executionVerification = request.verification
          ? await this.verifyExecution(request.verification)
          : noVerification();
        const error =
          executionVerification.status === "failed" ? (executionVerification.error ?? "verification failed") : null;
        const result = this.result(request, {
          ...trust,
          scriptId,
          scriptName: existing.name,
          requestedVersion,
          installedVersion: remaining?.metadata.version?.[0] ?? null,
          attemptCount,
          finalStatus: error ? "failed" : "succeeded",
          executionVerification,
          error,
        });
        await writeReceipt(result);
        return result;
      }
      if (!request.code || !metadata) throw new Error("userscript code has no valid metadata block");
      if (request.requestedAction === "update" && !existing) {
        throw new Error(`script is not installed: ${scriptId}`);
      }
      const installedByService = await this.scriptService.installByCode({
        uuid: scriptId,
        code: request.code,
        upsertBy: "torsionfield",
        matchByNameAndNamespace: false,
      });
      const installed = ((await this.scriptDAO.get(scriptId)) as Script | undefined) ?? installedByService;
      if (installed.uuid !== scriptId) throw new Error(`installed script identity mismatch: ${installed.uuid}`);

      const executionVerification = request.verification
        ? await this.verifyExecution(request.verification)
        : noVerification();
      const error =
        executionVerification.status === "failed" ? (executionVerification.error ?? "verification failed") : null;
      const result = this.result(request, {
        ...trust,
        scriptId,
        scriptName: installed.name,
        requestedVersion,
        installedVersion: installed.metadata.version?.[0] ?? null,
        attemptCount,
        finalStatus: error ? "failed" : "succeeded",
        executionVerification,
        error,
      });
      await writeReceipt(result);
      return result;
    } catch (error) {
      const result = this.result(request, {
        ...trust,
        scriptId,
        scriptName,
        requestedVersion,
        attemptCount,
        finalStatus: "failed",
        error: preciseError(error),
      });
      await writeReceipt(result);
      return result;
    }
  }

  private async registerTab(request: TorsionfieldDevRequest): Promise<TorsionfieldDevResult> {
    const fixtureUrl = normalizeLoopbackHttpUrl(request.fixtureUrl);
    if (!fixtureUrl) {
      return this.reject(request, "rejected_untrusted_source", "fixture URL must be a loopback HTTP(S) URL");
    }
    if (request.tabId !== undefined && (!Number.isInteger(request.tabId) || request.tabId < 0)) {
      return this.reject(request, "rejected_untrusted_source", "tab id must be a non-negative integer");
    }

    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({});
    } catch (error) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_loopback_url",
        finalStatus: "failed",
        fixtureUrl,
        error: preciseError(error),
      });
      await writeReceipt(result);
      return result;
    }
    const matchingTabs = tabs
      .filter(
        (tab) =>
          tab.id !== undefined && tab.url === fixtureUrl && (request.tabId === undefined || tab.id === request.tabId)
      )
      .map(fixtureTab)
      .filter((tab): tab is TorsionfieldFixtureTab => tab !== null)
      .sort((left, right) => left.tabId - right.tabId);
    const selected = matchingTabs[0];
    if (!selected) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_loopback_url",
        finalStatus: "failed",
        fixtureUrl,
        tabs: [],
        error: request.tabId === undefined ? "fixture tab is not open" : `fixture tab is not open: ${request.tabId}`,
      });
      await writeReceipt(result);
      return result;
    }

    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: selected.tabId },
        func: probeFixtureTab,
        args: [fixtureUrl],
      });
      const probe = injection?.result as FixtureProbe | undefined;
      if (!probe?.accepted || probe.url !== fixtureUrl) {
        return this.reject(
          request,
          "rejected_untrusted_source",
          "selected tab no longer matches the requested loopback fixture URL",
          { fixtureUrl, tabs: [selected] }
        );
      }
      if (probe.readyState === "loading") {
        const result = this.result(request, {
          trustAccepted: true,
          trustClassification: "trusted_loopback_url",
          finalStatus: "failed",
          fixtureUrl,
          tabs: [selected],
          error: "fixture tab is still loading",
        });
        await writeReceipt(result);
        return result;
      }
    } catch (error) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_loopback_url",
        finalStatus: "failed",
        fixtureUrl,
        tabs: [selected],
        error: preciseError(error),
      });
      await writeReceipt(result);
      return result;
    }

    await chrome.storage.local.set({ [FIXTURE_URL_KEY]: fixtureUrl });
    const result = this.result(request, {
      trustAccepted: true,
      trustClassification: "trusted_loopback_url",
      finalStatus: "succeeded",
      fixtureUrl,
      tabs: [selected],
    });
    await writeReceipt(result);
    return result;
  }

  private async listTabs(request: TorsionfieldDevRequest): Promise<TorsionfieldDevResult> {
    const storedFixtureUrl = await readFixtureUrl();
    if (!storedFixtureUrl) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_local_channel",
        finalStatus: "succeeded",
      });
      await writeReceipt(result);
      return result;
    }
    const fixtureUrl = normalizeLoopbackHttpUrl(storedFixtureUrl);
    if (!fixtureUrl || fixtureUrl !== storedFixtureUrl) {
      return this.reject(request, "rejected_untrusted_source", "registered fixture URL is not trusted");
    }

    try {
      const tabs = (await chrome.tabs.query({}))
        .filter((tab) => tab.id !== undefined && tab.url === fixtureUrl)
        .map(fixtureTab)
        .filter((tab): tab is TorsionfieldFixtureTab => tab !== null)
        .sort((left, right) => left.tabId - right.tabId);
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_local_channel",
        finalStatus: "succeeded",
        fixtureUrl,
        tabs,
      });
      await writeReceipt(result);
      return result;
    } catch (error) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_local_channel",
        finalStatus: "failed",
        fixtureUrl,
        error: preciseError(error),
      });
      await writeReceipt(result);
      return result;
    }
  }

  private async invokeTab(request: TorsionfieldDevRequest): Promise<TorsionfieldDevResult> {
    if (request.tabAction !== "fixture.change-marker") {
      return this.reject(
        request,
        "rejected_untrusted_source",
        `unsupported tab action: ${request.tabAction ?? "missing"}`
      );
    }
    const value = request.value;
    if (typeof value !== "string") {
      return this.reject(
        request,
        "rejected_untrusted_source",
        `tab action value must contain 1 to ${TAB_ACTION_VALUE_MAX_BYTES} UTF-8 bytes`
      );
    }
    const valueBytes = new TextEncoder().encode(value).byteLength;
    if (valueBytes < 1 || valueBytes > TAB_ACTION_VALUE_MAX_BYTES) {
      return this.reject(
        request,
        "rejected_untrusted_source",
        `tab action value must contain 1 to ${TAB_ACTION_VALUE_MAX_BYTES} UTF-8 bytes`
      );
    }
    const tabId = request.tabId;
    if (tabId === undefined || !Number.isInteger(tabId) || tabId < 0) {
      return this.reject(request, "rejected_untrusted_source", "tab id must be a non-negative integer");
    }

    const storedFixtureUrl = await readFixtureUrl();
    const fixtureUrl = normalizeLoopbackHttpUrl(storedFixtureUrl);
    if (!storedFixtureUrl) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_local_channel",
        finalStatus: "failed",
        error: "fixture tab is not registered",
      });
      await writeReceipt(result);
      return result;
    }
    if (!fixtureUrl || fixtureUrl !== storedFixtureUrl) {
      return this.reject(request, "rejected_untrusted_source", "registered fixture URL is not trusted");
    }

    let selectedTab: chrome.tabs.Tab | undefined;
    try {
      selectedTab = (await chrome.tabs.query({})).find((tab) => tab.id === tabId);
    } catch (error) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_loopback_url",
        finalStatus: "failed",
        fixtureUrl,
        error: preciseError(error),
      });
      await writeReceipt(result);
      return result;
    }
    if (!selectedTab) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_loopback_url",
        finalStatus: "failed",
        fixtureUrl,
        error: `fixture tab is not open: ${tabId}`,
      });
      await writeReceipt(result);
      return result;
    }
    const selected = fixtureTab(selectedTab);
    if (!selected || selected.url !== fixtureUrl) {
      return this.reject(
        request,
        "rejected_untrusted_source",
        "selected tab no longer matches the registered loopback fixture URL",
        { fixtureUrl, tabs: selected ? [selected] : [] }
      );
    }

    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: selected.tabId },
        func: dispatchFixtureChangeMarker,
        args: [fixtureUrl, value],
      });
      const dispatch = injection?.result as FixtureDispatch | undefined;
      if (!dispatch?.accepted || !dispatch.dispatched || dispatch.url !== fixtureUrl) {
        return this.reject(
          request,
          "rejected_untrusted_source",
          "selected tab no longer matches the registered loopback fixture URL",
          { fixtureUrl, tabs: [selected] }
        );
      }
    } catch (error) {
      const result = this.result(request, {
        trustAccepted: true,
        trustClassification: "trusted_loopback_url",
        finalStatus: "failed",
        fixtureUrl,
        tabs: [selected],
        error: preciseError(error),
      });
      await writeReceipt(result);
      return result;
    }

    const deadline = Date.now() + TAB_INVOKE_TIMEOUT_MS;
    let lastObservation: FixtureObservation | undefined;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId: selected.tabId },
          func: inspectFixtureChangeMarker,
          args: [fixtureUrl, value],
        });
        const observation = injection?.result as FixtureObservation | undefined;
        if (!observation?.accepted || observation.url !== fixtureUrl) {
          return this.reject(
            request,
            "rejected_untrusted_source",
            "selected tab no longer matches the registered loopback fixture URL",
            { fixtureUrl, tabs: [selected] }
          );
        }
        lastObservation = observation;
        if (observation.matched) {
          const result = this.result(request, {
            trustAccepted: true,
            trustClassification: "trusted_loopback_url",
            finalStatus: "succeeded",
            fixtureUrl,
            tabs: [selected],
            postcondition: this.postcondition(selected.tabId, observation),
          });
          await writeReceipt(result);
          return result;
        }
      } catch (error) {
        lastError = preciseError(error);
      }
      await wait(VERIFY_INTERVAL_MS);
    }

    const result = this.result(request, {
      trustAccepted: true,
      trustClassification: "trusted_loopback_url",
      finalStatus: "failed",
      fixtureUrl,
      tabs: [selected],
      postcondition: lastObservation ? this.postcondition(selected.tabId, lastObservation) : null,
      error: lastError ?? "fixture userscript marker was not observed before timeout",
    });
    await writeReceipt(result);
    return result;
  }

  private postcondition(tabId: number, observation: FixtureObservation): TorsionfieldTabPostcondition {
    return {
      tabId,
      url: observation.url,
      selector: FIXTURE_MARKER_SELECTOR,
      text: observation.text,
      attribute: { name: FIXTURE_MARKER_ATTRIBUTE, value: observation.attributeValue },
      visible: observation.visible,
    };
  }

  private async status(request: TorsionfieldDevRequest): Promise<TorsionfieldDevResult> {
    const subjectOperationId = request.subjectOperationId;
    const subject = subjectOperationId ? (await readReceipts())[subjectOperationId] : undefined;
    const result = subject
      ? {
          ...subject,
          operationId: request.operationId,
          requestedAction: "status" as const,
          subjectOperationId,
          trustAccepted: true,
          trustClassification: "trusted_local_channel" as const,
          attemptCount: 1,
        }
      : this.result(request, {
          trustAccepted: true,
          trustClassification: "trusted_local_channel",
          attemptCount: 1,
          finalStatus: "failed",
          error: subjectOperationId
            ? `operation receipt not found: ${subjectOperationId}`
            : "subject operation id is required",
        });
    await writeReceipt(result);
    return result;
  }

  private async reload(request: TorsionfieldDevRequest): Promise<TorsionfieldDevResult> {
    const result = this.result(request, {
      trustAccepted: true,
      trustClassification: "trusted_local_channel",
      attemptCount: 1,
      finalStatus: "succeeded",
    });
    await writeReceipt(result);
    await chrome.storage.local.set({
      [RELOAD_KEY]: { operationId: request.operationId, expiresAt: Date.now() + RELOAD_TTL_MS } satisfies ReloadMarker,
    });
    const scheduleReloadWake = this.options.scheduleReloadWake ?? scheduleTorsionfieldReloadWake;
    try {
      await scheduleReloadWake();
    } catch (error) {
      const failed = {
        ...result,
        finalStatus: "failed" as const,
        error: preciseError(error),
      };
      await chrome.storage.local.remove(RELOAD_KEY);
      await writeReceipt(failed);
      return failed;
    }
    const reloadExtension = this.options.reloadExtension ?? (() => chrome.runtime.reload());
    setTimeout(reloadExtension, 250);
    return result;
  }

  private async reject(
    request: TorsionfieldDevRequest,
    trustClassification: "rejected_invalid_token" | "rejected_untrusted_source",
    error: string,
    overrides: Partial<TorsionfieldDevResult> = {}
  ): Promise<TorsionfieldDevResult> {
    const result = this.result(request, {
      trustAccepted: false,
      trustClassification,
      attemptCount: 1,
      finalStatus: "rejected",
      error,
      ...overrides,
    });
    await writeReceipt(result);
    return result;
  }

  private result(request: TorsionfieldDevRequest, overrides: Partial<TorsionfieldDevResult>): TorsionfieldDevResult {
    return {
      protocolVersion: TORSIONFIELD_PROTOCOL_VERSION,
      operationId: request.operationId,
      requestedAction: request.requestedAction,
      ...(request.subjectOperationId ? { subjectOperationId: request.subjectOperationId } : {}),
      trustAccepted: false,
      trustClassification: "rejected_untrusted_source",
      scriptId: null,
      scriptName: null,
      requestedVersion: null,
      installedVersion: null,
      attemptCount: 1,
      finalStatus: "failed",
      executionVerification: noVerification(),
      fixtureUrl: null,
      tabs: [],
      postcondition: null,
      error: null,
      ...overrides,
    };
  }
}

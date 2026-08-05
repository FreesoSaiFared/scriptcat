import type { Script, ScriptDAO } from "@App/app/repo/scripts";
import { parseMetadata } from "@App/pkg/utils/script";
import type { Group } from "@Packages/message/server";
import { v5 as uuidv5 } from "uuid";
import type { ScriptService } from "./script";

export const TORSIONFIELD_PROTOCOL_VERSION = "torsionfield-script-v1" as const;

const RECEIPTS_KEY = "torsionfield_dev_receipts_v1";
const RELOAD_KEY = "torsionfield_dev_reload_v1";
const MAX_RECEIPTS = 100;
const RELOAD_TTL_MS = 60_000;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_INTERVAL_MS = 200;
const VERIFY_RELOAD_INTERVAL_MS = 2_000;

export type TorsionfieldDevAction = "install" | "update" | "status" | "reload" | "disable" | "enable" | "remove";

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
  error: string | null;
}

type ReceiptStore = Record<string, TorsionfieldDevResult>;

type ReloadMarker = { operationId: string; expiresAt: number };

interface TorsionfieldDevServiceOptions {
  token: string;
  verifyExecution?: (request: TorsionfieldExecutionVerificationRequest) => Promise<TorsionfieldExecutionVerification>;
  reloadExtension?: () => void;
}

const noVerification = (): TorsionfieldExecutionVerification => ({ status: "not_run" });

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
    const reloadExtension = this.options.reloadExtension ?? (() => chrome.runtime.reload());
    setTimeout(reloadExtension, 250);
    return result;
  }

  private async reject(
    request: TorsionfieldDevRequest,
    trustClassification: "rejected_invalid_token" | "rejected_untrusted_source",
    error: string
  ): Promise<TorsionfieldDevResult> {
    const result = this.result(request, {
      trustAccepted: false,
      trustClassification,
      attemptCount: 1,
      finalStatus: "rejected",
      error,
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
      error: null,
      ...overrides,
    };
  }
}

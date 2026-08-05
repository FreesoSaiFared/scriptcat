import { beforeEach, describe, expect, it, vi } from "vitest";
import { v5 as uuidv5 } from "uuid";
import { initTestEnv } from "@Tests/utils";
import type { Script } from "@App/app/repo/scripts";
import {
  consumeTorsionfieldDevReload,
  TorsionfieldDevService,
  verifyTorsionfieldExecution,
  type TorsionfieldDevRequest,
  type TorsionfieldExecutionVerification,
  type TorsionfieldExecutionVerificationRequest,
} from "./torsionfield_dev";

initTestEnv();

const token = "torsionfield-test-token";
const sourceUri = "file:///E:/Transductive_MCP_Work/scriptcat-1.5/smoke.user.js";
const code = `// ==UserScript==
// @name ScriptCat Bootstrap Smoke Test
// @namespace https://scriptcat.org/verify
// @version 1.0.3
// @match http://127.0.0.1:18765/fixture.html
// @grant none
// ==/UserScript==
document.documentElement.dataset.torsionfieldVersion = "1.0.3";`;

const makeRequest = (overrides: Partial<TorsionfieldDevRequest> = {}): TorsionfieldDevRequest => ({
  protocolVersion: "torsionfield-script-v1",
  operationId: "op-install-103",
  requestedAction: "install",
  token,
  sourceUri,
  code,
  verification: {
    url: "http://127.0.0.1:18765/fixture.html",
    selector: "#scriptcat-bootstrap-smoke",
    attribute: { name: "data-version", value: "1.0.3" },
    text: "ScriptCat userscript update 1.0.3 executed",
  },
  ...overrides,
});

describe("Torsionfield trusted development service", () => {
  let installed: Script | undefined;
  let installByCode: ReturnType<typeof vi.fn>;
  let enableScript: ReturnType<typeof vi.fn>;
  let deleteScript: ReturnType<typeof vi.fn>;
  let getScript: ReturnType<typeof vi.fn>;
  let verifyExecution: (
    request: TorsionfieldExecutionVerificationRequest
  ) => Promise<TorsionfieldExecutionVerification>;

  beforeEach(async () => {
    await chrome.storage.local.clear();
    installed = undefined;
    installByCode = vi.fn(async ({ uuid, code: nextCode }: { uuid: string; code: string }) => {
      const version = nextCode.match(/@version\s+([^\s]+)/)?.[1] || "0.0.0";
      installed = {
        uuid,
        name: "ScriptCat Bootstrap Smoke Test",
        namespace: "https://scriptcat.org/verify",
        metadata: { name: ["ScriptCat Bootstrap Smoke Test"], version: [version] },
      } as unknown as Script;
      return installed;
    });
    enableScript = vi.fn(async ({ enable }: { uuid: string; enable: boolean }) => {
      if (!installed) throw new Error("script not found");
      installed = { ...installed, status: enable ? 1 : 2 } as Script;
      return true;
    });
    deleteScript = vi.fn(async () => {
      installed = undefined;
      return true;
    });
    getScript = vi.fn(async () => installed);
    verifyExecution = vi.fn(async () => ({
      status: "passed" as const,
      url: "http://127.0.0.1:18765/fixture.html",
      selector: "#scriptcat-bootstrap-smoke",
      observed: {
        present: true,
        attributeValue: "1.0.3",
        text: "ScriptCat userscript update 1.0.3 executed",
      },
    }));
  });

  const createService = (reloadExtension?: () => void) =>
    new TorsionfieldDevService(
      { on: vi.fn() } as never,
      { installByCode, enableScript, deleteScript } as never,
      { get: getScript } as never,
      {
        token,
        verifyExecution,
        reloadExtension,
      }
    );

  it("installs an authenticated local script and returns a complete machine receipt", async () => {
    const service = createService();

    const result = await service.execute(makeRequest());

    const expectedId = uuidv5(sourceUri, uuidv5.URL);
    expect(installByCode).toHaveBeenCalledWith({
      uuid: expectedId,
      code,
      upsertBy: "torsionfield",
      matchByNameAndNamespace: false,
    });
    expect(result).toMatchObject({
      protocolVersion: "torsionfield-script-v1",
      operationId: "op-install-103",
      requestedAction: "install",
      trustAccepted: true,
      trustClassification: "trusted_local_file",
      scriptId: expectedId,
      scriptName: "ScriptCat Bootstrap Smoke Test",
      requestedVersion: "1.0.3",
      installedVersion: "1.0.3",
      attemptCount: 1,
      finalStatus: "succeeded",
      executionVerification: { status: "passed" },
      error: null,
    });
  });

  it("updates the same source identity repeatedly", async () => {
    const service = createService();
    await service.execute(makeRequest());
    const updatedCode = code.replaceAll("1.0.3", "1.0.4");

    const result = await service.execute(
      makeRequest({ operationId: "op-update-104", requestedAction: "update", code: updatedCode })
    );

    expect(result.scriptId).toBe(uuidv5(sourceUri, uuidv5.URL));
    expect(result.requestedVersion).toBe("1.0.4");
    expect(result.installedVersion).toBe("1.0.4");
    expect(result.finalStatus).toBe("succeeded");
  });

  it("disables, enables, and removes the stable local script through core-only actions", async () => {
    const service = createService();
    const installedResult = await service.execute(makeRequest());
    const expectedId = installedResult.scriptId!;

    const disabled = await service.execute(
      makeRequest({
        operationId: "op-disable",
        requestedAction: "disable",
        code: undefined,
      })
    );
    expect(enableScript).toHaveBeenLastCalledWith({ uuid: expectedId, enable: false });
    expect(disabled).toMatchObject({ scriptId: expectedId, installedVersion: "1.0.3", finalStatus: "succeeded" });

    const enabled = await service.execute(
      makeRequest({
        operationId: "op-enable",
        requestedAction: "enable",
        code: undefined,
      })
    );
    expect(enableScript).toHaveBeenLastCalledWith({ uuid: expectedId, enable: true });
    expect(enabled).toMatchObject({ scriptId: expectedId, installedVersion: "1.0.3", finalStatus: "succeeded" });

    const removed = await service.execute(
      makeRequest({
        operationId: "op-remove",
        requestedAction: "remove",
        code: undefined,
      })
    );
    expect(deleteScript).toHaveBeenLastCalledWith(expectedId, "torsionfield");
    expect(removed).toMatchObject({
      scriptId: expectedId,
      scriptName: "ScriptCat Bootstrap Smoke Test",
      installedVersion: null,
      finalStatus: "succeeded",
    });
  });

  it("rejects a remote source even when it carries the correct token", async () => {
    const service = createService();

    const result = await service.execute(
      makeRequest({ sourceUri: "https://example.com/untrusted.user.js", code: undefined })
    );

    expect(result).toMatchObject({
      trustAccepted: false,
      trustClassification: "rejected_untrusted_source",
      finalStatus: "rejected",
      executionVerification: { status: "not_run" },
      error: "source must be a local file or loopback HTTP(S) URL",
    });
    expect(installByCode).not.toHaveBeenCalled();
  });

  it("rejects an invalid channel token before touching script storage", async () => {
    const service = createService();

    const result = await service.execute(makeRequest({ token: "wrong-token" }));

    expect(result.trustClassification).toBe("rejected_invalid_token");
    expect(result.finalStatus).toBe("rejected");
    expect(installByCode).not.toHaveBeenCalled();
    expect(getScript).not.toHaveBeenCalled();
  });

  it("returns a precise failure when update targets an identity that is not installed", async () => {
    const service = createService();

    const result = await service.execute(makeRequest({ requestedAction: "update" }));

    expect(result.finalStatus).toBe("failed");
    expect(result.error).toBe(`script is not installed: ${uuidv5(sourceUri, uuidv5.URL)}`);
    expect(installByCode).not.toHaveBeenCalled();
  });

  it("retrieves a durable receipt after a new service instance is created", async () => {
    const firstService = createService();
    const installedResult = await firstService.execute(makeRequest());
    const restartedService = createService();

    const status = await restartedService.execute({
      protocolVersion: "torsionfield-script-v1",
      operationId: "op-status-after-restart",
      requestedAction: "status",
      subjectOperationId: installedResult.operationId,
      token,
    });

    expect(status).toMatchObject({
      operationId: "op-status-after-restart",
      requestedAction: "status",
      subjectOperationId: "op-install-103",
      trustAccepted: true,
      scriptId: installedResult.scriptId,
      scriptName: installedResult.scriptName,
      requestedVersion: "1.0.3",
      installedVersion: "1.0.3",
      finalStatus: "succeeded",
      executionVerification: { status: "passed" },
      error: null,
    });
  });

  it("persists a reload receipt before asking Chrome to reload the extension", async () => {
    vi.useFakeTimers();
    const reloadExtension = vi.fn();
    const service = createService(reloadExtension);

    const result = await service.execute({
      protocolVersion: "torsionfield-script-v1",
      operationId: "op-reload",
      requestedAction: "reload",
      token,
    });

    expect(result.finalStatus).toBe("succeeded");
    expect(await consumeTorsionfieldDevReload()).toBe(true);
    expect(await consumeTorsionfieldDevReload()).toBe(false);
    expect(reloadExtension).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(reloadExtension).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("verifies the element matching the requested version when an older fixture marker also exists", async () => {
    document.body.innerHTML = `
      <div id="scriptcat-bootstrap-smoke" data-version="1.0.2">ScriptCat userscript update 1.0.2 executed</div>
      <div id="scriptcat-bootstrap-smoke" data-version="1.0.3">ScriptCat userscript update 1.0.3 executed</div>
    `;
    const previousQuery = chrome.tabs.query;
    const query = vi.fn(async () => [{ id: 7, url: "http://127.0.0.1:18765/fixture.html" } as chrome.tabs.Tab]);
    const reload = vi.fn(async () => undefined);
    const previousScripting = chrome.scripting;
    chrome.tabs.query = query as unknown as typeof chrome.tabs.query;
    (chrome.tabs as typeof chrome.tabs & { reload: typeof reload }).reload = reload;
    chrome.scripting = {
      executeScript: vi.fn(async ({ func, args }) => [{ result: func(...(args ?? [])) }]),
    } as unknown as typeof chrome.scripting;

    try {
      const result = await verifyTorsionfieldExecution({
        url: "http://127.0.0.1:18765/fixture.html",
        selector: "#scriptcat-bootstrap-smoke",
        attribute: { name: "data-version", value: "1.0.3" },
        text: "ScriptCat userscript update 1.0.3 executed",
      });

      expect(result).toMatchObject({
        status: "passed",
        observed: {
          present: true,
          attributeValue: "1.0.3",
          text: "ScriptCat userscript update 1.0.3 executed",
        },
      });
      expect(reload).toHaveBeenCalledWith(7);
    } finally {
      chrome.tabs.query = previousQuery;
      Reflect.deleteProperty(chrome.tabs, "reload");
      chrome.scripting = previousScripting;
      document.body.innerHTML = "";
    }
  });
});

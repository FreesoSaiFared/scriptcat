import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { TORSIONFIELD_CHANNEL_PROTOCOL, readTorsionfieldChannelConfig } from "./torsionfield-channel-config.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markerSelector = "#torsionfield-core-smoke";
const runId = randomUUID();
const operationId = (phase) => `torsionfield-core-${runId}-${phase}`;
let fixtureUrl;

const run = (command, args, options = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (exitCode) => resolveRun({ command, args, exitCode, stdout, stderr }));
  });

const runRequired = async (command, args) => {
  const result = await run(command, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result;
};

const config = readTorsionfieldChannelConfig(rootDir);

const executeDirect = async (request) => {
  const url = new URL(config.url);
  const channel = new WebSocketServer({
    host: url.hostname.replaceAll("[", "").replaceAll("]", ""),
    port: Number(url.port),
  });
  return await new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let connectionCount = 0;
    let pendingReloadResult;
    const timeout = setTimeout(
      () =>
        finish(
          undefined,
          new Error(
            pendingReloadResult
              ? "ScriptCat acknowledged reload but the core channel did not reconnect"
              : "timed out waiting for ScriptCat core channel"
          )
        ),
      45_000
    );
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const client of channel.clients) client.close();
      channel.close(() => (error ? rejectResult(error) : resolveResult(result)));
    };
    channel.on("error", (error) => finish(undefined, error));
    channel.on("connection", (socket) => {
      connectionCount += 1;
      let sent = false;
      const send = () => {
        if (sent || socket.readyState !== WebSocket.OPEN) return;
        sent = true;
        socket.send(JSON.stringify({ action: "torsionfield", data: request }));
      };
      socket.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.action === "hello") {
          const authenticated =
            message.data?.protocolVersion === TORSIONFIELD_CHANNEL_PROTOCOL &&
            message.data?.role === "extension" &&
            message.data?.token === config.token;
          socket.send(
            JSON.stringify({
              action: "hello/ack",
              data: {
                protocolVersion: "torsionfield-node-v1",
                role: "node",
                nodeId: "torsionfield-core-smoke",
                authenticated,
              },
            })
          );
          if (!authenticated) {
            socket.close();
            return;
          }
          if (pendingReloadResult) {
            finish({
              ...pendingReloadResult,
              channelReconnection: { status: "passed", connectionCount },
            });
          } else {
            send();
          }
        } else if (message.action === "torsionfield/result" && message.data?.operationId === request.operationId) {
          if (request.requestedAction === "reload" && message.data.finalStatus === "succeeded") {
            pendingReloadResult = message.data;
          } else {
            finish(message.data);
          }
        }
      });
    });
  });
};

const runCoreAction = async ({ requestedAction, id, source = false, subjectOperationId, verification }) => {
  const request = {
    protocolVersion: TORSIONFIELD_CHANNEL_PROTOCOL,
    operationId: id,
    requestedAction,
    token: config.token,
  };
  if (source) {
    request.sourceUri = pathToFileURL(sourcePath).href;
    if (requestedAction === "install" || requestedAction === "update") {
      request.code = await readFile(sourcePath, "utf8");
    }
  }
  if (subjectOperationId) request.subjectOperationId = subjectOperationId;
  if (verification) request.verification = verification;
  const receipt = await executeDirect(request);
  if (receipt.finalStatus !== "succeeded") throw new Error(JSON.stringify(receipt));
  return receipt;
};

const scriptCode = (version) => `// ==UserScript==
// @name         ScriptCat Torsionfield Core Smoke
// @namespace    https://scriptcat.org/verify/torsionfield-core
// @version      ${version}
// @description  Verifies the private Torsionfield ScriptCat lifecycle.
// @match        ${fixtureUrl}
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  const marker = document.createElement("div");
  marker.id = "torsionfield-core-smoke";
  marker.dataset.version = "${version}";
  marker.textContent = "Torsionfield core ${version} executed";
  document.body.append(marker);
  document.querySelector("#fixture-status")?.setAttribute("data-version", "${version}");
  console.log("[torsionfield-core] PASS ${version}");
})();
`;

const verification = (version) => ({
  url: fixtureUrl,
  selector: markerSelector,
  attribute: { name: "data-version", value: version },
  text: `Torsionfield core ${version} executed`,
});

const absentVerification = () => ({ url: fixtureUrl, selector: markerSelector, expectAbsent: true });

const listen = (server) =>
  new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("fixture server did not expose a TCP port"));
        return;
      }
      resolveListen(address.port);
    });
  });

const close = (server) => new Promise((resolveClose) => server.close(resolveClose));

const evidenceDir = join(rootDir, "test-results", "verify", "torsionfield-core");
const sourcePath = join(evidenceDir, "core-smoke.user.js");
const server = createServer((request, response) => {
  if (request.url !== "/fixture.html") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Torsionfield Core Fixture</title></head><body><h1>Torsionfield Core Fixture</h1><p id="fixture-status">waiting</p></body></html>`
  );
});

try {
  await mkdir(evidenceDir, { recursive: true });
  const fixturePort = await listen(server);
  fixtureUrl = `http://127.0.0.1:${fixturePort}/fixture.html`;
  const corepack = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
  const build = await runRequired(process.execPath, [corepack, "pnpm", "run", "build:torsionfield"]);
  const loaded = await runCoreAction({ requestedAction: "reload", id: operationId("load-build") });

  await writeFile(sourcePath, scriptCode("1.0.0"), "utf8");
  const installed = await runCoreAction({
    requestedAction: "install",
    id: operationId("install"),
    source: true,
    verification: verification("1.0.0"),
  });

  await writeFile(sourcePath, scriptCode("1.0.1"), "utf8");
  const updated = await runCoreAction({
    requestedAction: "update",
    id: operationId("update"),
    source: true,
    verification: verification("1.0.1"),
  });
  const disabled = await runCoreAction({
    requestedAction: "disable",
    id: operationId("disable"),
    source: true,
    verification: absentVerification(),
  });
  const enabled = await runCoreAction({
    requestedAction: "enable",
    id: operationId("enable"),
    source: true,
    verification: verification("1.0.1"),
  });
  const reloaded = await runCoreAction({ requestedAction: "reload", id: operationId("reload") });
  const persistent = await runCoreAction({
    requestedAction: "enable",
    id: operationId("persistence"),
    source: true,
    verification: verification("1.0.1"),
  });
  const status = await runCoreAction({
    requestedAction: "status",
    id: operationId("status-after-reload"),
    subjectOperationId: updated.operationId,
  });
  const removed = await runCoreAction({
    requestedAction: "remove",
    id: operationId("remove"),
    source: true,
    verification: absentVerification(),
  });

  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: "torsionfield-core-smoke-v1",
      runId,
      finalStatus: "succeeded",
      build: { exitCode: build.exitCode },
      phases: { loaded, installed, updated, disabled, enabled, reloaded, persistent, status, removed },
    })}\n`
  );
} finally {
  await close(server);
  await rm(sourcePath, { force: true });
}

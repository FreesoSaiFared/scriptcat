import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { TORSIONFIELD_CHANNEL_PROTOCOL, readTorsionfieldChannelConfig } from "./torsionfield-channel-config.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const operationId = randomUUID();
const [action, ...commandArgs] = process.argv.slice(2);
const optionValues = new Map();
const positionalArgs = [];
for (let index = 0; index < commandArgs.length; index += 1) {
  const value = commandArgs[index];
  if (value.startsWith("--")) {
    if (value === "--verify-absent") {
      optionValues.set(value, true);
    } else {
      optionValues.set(value, commandArgs[index + 1]);
      index += 1;
    }
  } else {
    positionalArgs.push(value);
  }
}
const subject = positionalArgs[0];

const option = (name) => optionValues.get(name);

const resultFailure = (error, requestedAction = action ?? "status") => ({
  protocolVersion: TORSIONFIELD_CHANNEL_PROTOCOL,
  operationId: option("--operation-id") ?? operationId,
  requestedAction,
  trustAccepted: false,
  trustClassification: "transport_unavailable",
  scriptId: null,
  scriptName: null,
  requestedVersion: null,
  installedVersion: null,
  attemptCount: 1,
  finalStatus: "failed",
  executionVerification: { status: "not_run" },
  error: error instanceof Error ? error.message : String(error),
});

const isLoopbackHttpUrl = (value) => {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  return (url.protocol === "http:" || url.protocol === "https:") && loopback;
};

const resolveSource = async (value) => {
  if (!value) throw new Error(`${action} requires a userscript file or URL`);
  if (existsSync(value)) {
    const path = resolve(value);
    return { sourceUri: pathToFileURL(path).href, code: readFileSync(path, "utf8") };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    const path = resolve(value);
    if (!existsSync(path)) throw new Error(`userscript file does not exist: ${path}`);
    return { sourceUri: pathToFileURL(path).href, code: readFileSync(path, "utf8") };
  }
  if (url.protocol === "file:") {
    const path = fileURLToPath(url);
    if (!existsSync(path)) {
      if (action === "install" || action === "update") throw new Error(`userscript file does not exist: ${path}`);
      return { sourceUri: url.href };
    }
    return { sourceUri: url.href, code: readFileSync(path, "utf8") };
  }
  if (isLoopbackHttpUrl(url.href)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`userscript fetch failed: HTTP ${response.status}`);
    return { sourceUri: url.href, code: await response.text() };
  }
  return { sourceUri: url.href };
};

const buildRequest = async (token) => {
  if (!new Set(["install", "update", "status", "reload", "disable", "enable", "remove"]).has(action)) {
    throw new Error(
      "usage: torsionfield-script <install|update|status|reload|disable|enable|remove> [file-or-url|operation-id]"
    );
  }
  const request = {
    protocolVersion: TORSIONFIELD_CHANNEL_PROTOCOL,
    operationId: option("--operation-id") ?? operationId,
    requestedAction: action,
    token,
  };
  if (action === "status") {
    if (!subject) throw new Error("status requires an operation id");
    request.subjectOperationId = subject;
  }
  if (
    action === "install" ||
    action === "update" ||
    action === "disable" ||
    action === "enable" ||
    action === "remove"
  ) {
    const source = await resolveSource(subject);
    request.sourceUri = source.sourceUri;
    if (action === "install" || action === "update") request.code = source.code;
    const verifyUrl = option("--verify-url");
    const verifySelector = option("--verify-selector");
    const verifyAttribute = option("--verify-attribute");
    const verifyText = option("--verify-text");
    const verifyAbsent = option("--verify-absent") === true;
    if (verifyUrl || verifySelector || verifyAttribute || verifyText || verifyAbsent) {
      if (!verifyUrl || !verifySelector) {
        throw new Error("execution verification requires --verify-url and --verify-selector");
      }
      request.verification = { url: verifyUrl, selector: verifySelector };
      if (verifyAttribute) {
        const separator = verifyAttribute.indexOf("=");
        if (separator <= 0) throw new Error("--verify-attribute must use name=value");
        request.verification.attribute = {
          name: verifyAttribute.slice(0, separator),
          value: verifyAttribute.slice(separator + 1),
        };
      }
      if (verifyText) request.verification.text = verifyText;
      if (verifyAbsent) request.verification.expectAbsent = true;
    }
  }
  return request;
};

const execute = async (config, request) => {
  const url = new URL(config.url);
  const server = new WebSocketServer({
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
              ? "ScriptCat acknowledged reload but the development channel did not reconnect"
              : "timed out waiting for ScriptCat development channel"
          )
        ),
      45_000
    );

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const client of server.clients) client.close();
      server.close(() => (error ? rejectResult(error) : resolveResult(result)));
    };

    server.on("error", (error) => finish(undefined, error));
    server.on("connection", (socket) => {
      connectionCount += 1;
      let sent = false;
      const send = () => {
        if (sent || socket.readyState !== WebSocket.OPEN) return;
        sent = true;
        socket.send(JSON.stringify({ action: "torsionfield", data: request }));
      };
      const fallback = setTimeout(send, 500);
      socket.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (message.action === "hello") {
          clearTimeout(fallback);
          if (pendingReloadResult) {
            finish({
              ...pendingReloadResult,
              channelReconnection: { status: "passed", connectionCount },
            });
          } else {
            send();
          }
        } else if (message.action === "torsionfield/result" && message.data?.operationId === request.operationId) {
          clearTimeout(fallback);
          if (request.requestedAction === "reload" && message.data.finalStatus === "succeeded") {
            pendingReloadResult = message.data;
          } else {
            finish(message.data);
          }
        }
      });
      socket.on("close", () => clearTimeout(fallback));
    });
  });
};

try {
  const config = readTorsionfieldChannelConfig(rootDir);
  const request = await buildRequest(config.token);
  const result = await execute(config, request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.finalStatus !== "succeeded") process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify(resultFailure(error))}\n`);
  process.exitCode = 1;
}

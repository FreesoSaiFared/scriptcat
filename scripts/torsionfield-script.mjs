import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTorsionfieldChannelConfig } from "./torsionfield-channel-config.mjs";
import { executeTorsionfieldNodeRequest, TORSIONFIELD_NODE_PROTOCOL } from "./torsionfield-node-client.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const operationId = randomUUID();
const [command, ...commandArgs] = process.argv.slice(2);
const aliases = new Map([
  ["install", "script.install"],
  ["update", "script.update"],
  ["status", "script.status"],
  ["reload", "extension.reload"],
]);
const requestedAction = aliases.get(command) ?? command;
const optionValues = new Map();
const positionalArgs = [];
for (let index = 0; index < commandArgs.length; index += 1) {
  const value = commandArgs[index];
  if (value.startsWith("--")) {
    const values = optionValues.get(value) ?? [];
    if (value === "--verify-absent") {
      values.push(true);
    } else {
      values.push(commandArgs[index + 1]);
      index += 1;
    }
    optionValues.set(value, values);
  } else {
    positionalArgs.push(value);
  }
}
const subject = positionalArgs[0];

const options = (name) => optionValues.get(name) ?? [];
const option = (name) => options(name).at(-1);

const resultFailure = (error) => ({
  protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
  operationId: option("--operation-id") ?? operationId,
  requestedAction: requestedAction ?? "node.status",
  actor: null,
  trustAccepted: false,
  trustClassification: "transport_unavailable",
  attemptCount: 1,
  finalStatus: "failed",
  result: null,
  outputEvidence: null,
  error: error instanceof Error ? error.message : String(error),
  startedAt: null,
  finishedAt: new Date().toISOString(),
});

const isLoopbackHttpUrl = (value) => {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  return (url.protocol === "http:" || url.protocol === "https:") && loopback;
};

const resolveSource = async (value) => {
  if (!value) throw new Error(`${requestedAction} requires a userscript file or URL`);
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
      if (requestedAction === "script.install" || requestedAction === "script.update") {
        throw new Error(`userscript file does not exist: ${path}`);
      }
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

const buildRequest = async () => {
  const allowedActions = new Set([
    "node.status",
    "script.install",
    "script.update",
    "script.status",
    "extension.reload",
    "tab.register",
    "tab.list",
    "tab.invoke",
    "worker.register",
    "worker.run",
  ]);
  if (!allowedActions.has(requestedAction)) {
    throw new Error(
      "usage: torsionfield-script <node.status|script.install|script.update|script.status|extension.reload|tab.register|tab.list|tab.invoke|worker.register|worker.run> [subject]"
    );
  }
  const request = {
    protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
    operationId: option("--operation-id") ?? operationId,
    requestedAction,
  };
  const targetNodeId = option("--target-node");
  if (targetNodeId) request.targetNodeId = targetNodeId;

  if (requestedAction === "node.status") {
    request.input = subject ? { subjectOperationId: subject } : {};
  }
  if (requestedAction === "script.status") {
    if (!subject) throw new Error("script.status requires an operation id");
    request.input = { subjectOperationId: subject };
  }
  if (requestedAction === "script.install" || requestedAction === "script.update") {
    const source = await resolveSource(subject);
    request.input = { sourceUri: source.sourceUri, code: source.code };
    const verifyUrl = option("--verify-url");
    const verifySelector = option("--verify-selector");
    const verifyAttribute = option("--verify-attribute");
    const verifyText = option("--verify-text");
    const verifyAbsent = option("--verify-absent") === true;
    if (verifyUrl || verifySelector || verifyAttribute || verifyText || verifyAbsent) {
      if (!verifyUrl || !verifySelector) {
        throw new Error("execution verification requires --verify-url and --verify-selector");
      }
      request.input.verification = { url: verifyUrl, selector: verifySelector };
      if (verifyAttribute) {
        const separator = verifyAttribute.indexOf("=");
        if (separator <= 0) throw new Error("--verify-attribute must use name=value");
        request.input.verification.attribute = {
          name: verifyAttribute.slice(0, separator),
          value: verifyAttribute.slice(separator + 1),
        };
      }
      if (verifyText) request.input.verification.text = verifyText;
      if (verifyAbsent) request.input.verification.expectAbsent = true;
    }
  }
  if (requestedAction === "extension.reload" || requestedAction === "tab.list") request.input = {};
  if (requestedAction === "tab.register") {
    const fixtureUrl = option("--url");
    if (!subject || !fixtureUrl) throw new Error("tab.register requires an actor id and --url");
    request.actorId = subject;
    request.input = { fixtureUrl };
    const tabId = option("--tab-id");
    if (tabId !== undefined) request.input.tabId = Number(tabId);
  }
  if (requestedAction === "tab.invoke") {
    const value = option("--value");
    if (!subject || !value) throw new Error("tab.invoke requires an actor id and --value");
    request.actorId = subject;
    request.input = { value };
  }
  if (requestedAction === "worker.register") {
    const cwd = option("--cwd");
    const executable = option("--command");
    if (!subject || !cwd || !executable) {
      throw new Error("worker.register requires an actor id, --cwd, and --command");
    }
    request.actorId = subject;
    request.input = { cwd, argv: [executable, ...options("--arg")] };
    const timeoutMs = option("--timeout-ms");
    if (timeoutMs !== undefined) request.input.timeoutMs = Number(timeoutMs);
  }
  if (requestedAction === "worker.run") {
    if (!subject) throw new Error("worker.run requires an actor id");
    request.actorId = subject;
    request.input = {};
  }
  return request;
};

try {
  const config = readTorsionfieldChannelConfig(rootDir);
  const request = await buildRequest();
  const result = await executeTorsionfieldNodeRequest({
    url: option("--node-url") ?? config.url,
    token: config.token,
    request,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.finalStatus !== "succeeded") process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify(resultFailure(error))}\n`);
  process.exitCode = 1;
}

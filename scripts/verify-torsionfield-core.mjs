import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(rootDir, "scripts", "torsionfield-script.mjs");
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

const runCli = async (args) => {
  const result = await runRequired(process.execPath, [cliPath, ...args]);
  const line = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error(`torsionfield-script returned no receipt for ${args[0]}`);
  const receipt = JSON.parse(line);
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

const verificationArgs = (version) => [
  "--verify-url",
  fixtureUrl,
  "--verify-selector",
  markerSelector,
  "--verify-attribute",
  `data-version=${version}`,
  "--verify-text",
  `Torsionfield core ${version} executed`,
];

const absentVerificationArgs = () => [
  "--verify-url",
  fixtureUrl,
  "--verify-selector",
  markerSelector,
  "--verify-absent",
];

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
  const loaded = await runCli(["reload", "--operation-id", operationId("load-build")]);

  await writeFile(sourcePath, scriptCode("1.0.0"), "utf8");
  const installed = await runCli([
    "install",
    sourcePath,
    "--operation-id",
    operationId("install"),
    ...verificationArgs("1.0.0"),
  ]);

  await writeFile(sourcePath, scriptCode("1.0.1"), "utf8");
  const updated = await runCli([
    "update",
    sourcePath,
    "--operation-id",
    operationId("update"),
    ...verificationArgs("1.0.1"),
  ]);
  const disabled = await runCli([
    "disable",
    sourcePath,
    "--operation-id",
    operationId("disable"),
    ...absentVerificationArgs(),
  ]);
  const enabled = await runCli([
    "enable",
    sourcePath,
    "--operation-id",
    operationId("enable"),
    ...verificationArgs("1.0.1"),
  ]);
  const reloaded = await runCli(["reload", "--operation-id", operationId("reload")]);
  const persistent = await runCli([
    "enable",
    sourcePath,
    "--operation-id",
    operationId("persistence"),
    ...verificationArgs("1.0.1"),
  ]);
  const status = await runCli(["status", updated.operationId, "--operation-id", operationId("status-after-reload")]);
  const removed = await runCli([
    "remove",
    sourcePath,
    "--operation-id",
    operationId("remove"),
    ...absentVerificationArgs(),
  ]);

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

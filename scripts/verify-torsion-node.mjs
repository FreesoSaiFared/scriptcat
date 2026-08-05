import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTorsionfieldChannelConfig } from "./torsionfield-channel-config.mjs";
import { TORSIONFIELD_NODE_PROTOCOL } from "./torsionfield-node-client.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const channelConfigPath = join(rootDir, ".torsionfield-channel.json");
const nodeManifestPath = join(rootDir, "torsion-node", "Cargo.toml");
const cliPath = join(rootDir, "scripts", "torsionfield-script.mjs");
const evidenceDir = join(rootDir, "test-results", "verify", "torsion-node-v0.1");
const resourcesDir = join(evidenceDir, "resources");
const receiptsPath = join(evidenceDir, "receipts.jsonl");
const summaryPath = join(evidenceDir, "summary.json");
const userscriptPath = join(resourcesDir, "torsion-node-fixture.user.js");
const markerSelector = "#torsionfield-shared-marker";
const markerAttribute = "data-value";
const firstPeerMarker = "node-b-accepted";
const restartPeerMarker = "node-b-after-restart";
const focusedTestPath = "src/app/service/service_worker/torsionfield_dev.test.ts";
const startupTimeoutMs = 60_000;
const processStopTimeoutMs = 10_000;
const commandTimeoutMs = 180_000;
const logLimit = 2 * 1024 * 1024;

const assumptions = [
  "Regular Chrome already has the current authenticated Torsionfield extension build loaded with userScripts access enabled.",
  "Node A must bind the WebSocket URL baked into the loaded extension via .torsionfield-channel.json; one-listener v0.1 cannot use an unrelated ephemeral A port and still exercise resident Chrome.",
  "Node B and the fixture server use freshly reserved loopback ports; Node B reaches A through its explicit one-hop peer entry.",
  "Both nodes authenticate from the same existing .torsionfield-channel.json token, which is never copied into evidence or printed.",
  "The Rust v0.1 public operation set and torsionfield-node-v1 receipt schema are the acceptance contract.",
  "Node state persists below the repository's ignored .torsionfield-node directory; unique node and actor IDs preserve prior runs.",
  "The harmless fixture userscript remains installed at v0.1.1 because the v0.1 public API has no remove operation; reruns upsert the same local source URI.",
  "tab.invoke owns its lease lifecycle internally; a successful postcondition and a second invocation after restart are the observable lease-safety evidence.",
];

const usage = `Usage: node scripts/verify-torsion-node.mjs [options]

Options:
  --node-bin <path>          Use an already-built torsion-node binary.
  --print-assumptions        Print the acceptance inputs without running it.
  --help                     Print this help.

Environment:
  TORSION_NODE_BIN           Alternative to --node-bin.
`;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const preciseError = (error) => (error instanceof Error ? error.message : String(error));

const parseOptions = () => {
  const options = { nodeBin: process.env.TORSION_NODE_BIN, printAssumptions: false, help: false };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--node-bin") {
      const nodeBin = args[index + 1];
      if (!nodeBin) throw new Error("--node-bin requires a path");
      options.nodeBin = nodeBin;
      index += 1;
    } else if (value === "--print-assumptions") {
      options.printAssumptions = true;
    } else if (value === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${value}`);
    }
  }
  return options;
};

const appendBounded = (current, chunk) => {
  if (current.length >= logLimit) return current;
  return `${current}${chunk}`.slice(0, logLimit);
};

const redactText = (value, token) => {
  let redacted = String(value);
  if (token) redacted = redacted.replaceAll(token, "<redacted>");
  return redacted.replace(/("token"\s*:\s*")[^"]+("\s*[},])/gi, "$1<redacted>$2");
};

const redactValue = (value, token) => {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, token));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|secret|authorization/i.test(key) ? "<redacted>" : redactValue(entry, token),
      ])
    );
  }
  return typeof value === "string" ? redactText(value, token) : value;
};

const runCommand = (command, args, { cwd = rootDir, timeoutMs = commandTimeoutMs } = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString());
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveRun({ command, args, exitCode, signal, stdout, stderr, timedOut });
    });
  });

const runRequired = async (command, args, options) => {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed${result.timedOut ? " after timing out" : ""} with exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result;
};

const resolveNodeBinary = async (requestedPath) => {
  if (requestedPath) {
    const binaryPath = resolve(requestedPath);
    if (!existsSync(binaryPath)) throw new Error(`torsion-node binary does not exist: ${binaryPath}`);
    return { binaryPath, build: { status: "skipped", reason: "explicit binary" } };
  }
  if (!existsSync(nodeManifestPath)) throw new Error(`torsion-node manifest does not exist: ${nodeManifestPath}`);
  const metadataRun = await runRequired("cargo", [
    "metadata",
    "--format-version",
    "1",
    "--no-deps",
    "--manifest-path",
    nodeManifestPath,
  ]);
  const metadata = JSON.parse(metadataRun.stdout);
  const packageEntry = metadata.packages.find((entry) => resolve(entry.manifest_path) === resolve(nodeManifestPath));
  const binaryTarget = packageEntry?.targets.find((target) => target.kind.includes("bin"));
  if (!binaryTarget) throw new Error("torsion-node Cargo metadata does not expose a binary target");
  const build = await runRequired(
    "cargo",
    ["build", "--locked", "--manifest-path", nodeManifestPath, "--bin", binaryTarget.name],
    { timeoutMs: 300_000 }
  );
  const executableName = process.platform === "win32" ? `${binaryTarget.name}.exe` : binaryTarget.name;
  const binaryPath = join(metadata.target_directory, "debug", executableName);
  if (!existsSync(binaryPath)) throw new Error(`cargo succeeded but the torsion-node binary is missing: ${binaryPath}`);
  return {
    binaryPath,
    build: {
      status: "succeeded",
      command: ["cargo", "build", "--locked", "--manifest-path", nodeManifestPath, "--bin", binaryTarget.name],
      exitCode: build.exitCode,
    },
  };
};

const normalizeLoopbackHost = (hostname) => {
  if (hostname === "[::1]") return "::1";
  if (hostname === "localhost") return "127.0.0.1";
  return hostname;
};

const assertLoopbackWebSocketUrl = (value) => {
  const url = new URL(value);
  if (url.protocol !== "ws:") throw new Error(`Torsion Node v0.1 requires a ws:// listener: ${value}`);
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) {
    throw new Error(`Torsion Node acceptance refuses a non-loopback listener: ${value}`);
  }
  if (!url.port) throw new Error(`Torsion Node listener must include a port: ${value}`);
  return url;
};

const assertPortAvailable = async (value) => {
  const url = assertLoopbackWebSocketUrl(value);
  const host = normalizeLoopbackHost(url.hostname);
  await new Promise((resolveAvailable, rejectAvailable) => {
    const server = createNetServer();
    const finish = (error) => {
      server.removeAllListeners();
      if (error) rejectAvailable(error);
      else resolveAvailable();
    };
    server.once("error", (error) =>
      finish(new Error(`Node A cannot own the resident extension channel ${value}: ${preciseError(error)}`))
    );
    server.listen(Number(url.port), host, () => server.close((error) => finish(error)));
  });
};

const reserveLoopbackPort = () =>
  new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("ephemeral port reservation did not expose a TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });

const assertNodeStateIsIgnored = async () => {
  const result = await runCommand("git", ["check-ignore", "--quiet", "--no-index", ".torsionfield-node/probe"]);
  if (result.exitCode !== 0) {
    throw new Error("refusing to create persistent node state because .torsionfield-node/ is not git-ignored");
  }
};

const startFixtureServer = async () => {
  const sockets = new Set();
  const server = createHttpServer((request, response) => {
    if (request.url === "/fixture.html") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>Torsion Node v0.1 fixture</title></head><body><h1>Torsion Node v0.1 fixture</h1><p id="fixture-status">waiting for userscript</p></body></html>'
      );
      return;
    }
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("fixture server did not expose a TCP port"));
        return;
      }
      resolveListen(address.port);
    });
  });
  return {
    url: `http://127.0.0.1:${port}/fixture.html`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
};

const userscriptCode = (fixtureUrl, version) => {
  const readyValue = `fixture-ready-${version}`;
  return `// ==UserScript==
// @name         Torsion Node v0.1 Acceptance Fixture
// @namespace    https://scriptcat.org/verify/torsion-node-v0.1
// @version      ${version}
// @description  Harmless loopback-only marker actor for Torsion Node acceptance.
// @match        ${fixtureUrl}
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  const eventName = "torsionfield:fixture-change-marker";
  const listenerKey = "__torsionfieldNodeV01FixtureListener";
  const publish = (value, source) => {
    let marker = document.querySelector("${markerSelector}");
    if (!marker) {
      marker = document.createElement("div");
      marker.id = "torsionfield-shared-marker";
      document.body.append(marker);
    }
    marker.setAttribute("${markerAttribute}", value);
    marker.textContent = value;
    let receipt = document.querySelector("#torsionfield-fixture-receipt");
    if (!receipt) {
      receipt = document.createElement("pre");
      receipt.id = "torsionfield-fixture-receipt";
      document.body.append(receipt);
    }
    receipt.setAttribute("data-value", value);
    receipt.textContent = JSON.stringify({ eventName, source, value, version: "${version}", observedAt: new Date().toISOString() });
    document.querySelector("#fixture-status")?.replaceChildren(document.createTextNode("accepted: " + value));
  };
  const previous = window[listenerKey];
  if (typeof previous === "function") document.removeEventListener(eventName, previous);
  const listener = (event) => {
    if (typeof event.detail === "string" && event.detail.length > 0) publish(event.detail, "tab.invoke");
  };
  window[listenerKey] = listener;
  document.addEventListener(eventName, listener);
  publish("${readyValue}", "userscript");
})();
`;
};

const startManagedNode = (label, binaryPath, args) => {
  const child = spawn(binaryPath, args, {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const managed = { label, child, args, stdout: "", stderr: "", stopped: false };
  child.stdout.on("data", (chunk) => {
    managed.stdout = appendBounded(managed.stdout, chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    managed.stderr = appendBounded(managed.stderr, chunk.toString());
  });
  return managed;
};

const stopManagedNode = async (managed) => {
  if (!managed || managed.stopped) return;
  managed.stopped = true;
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) return;
  const closed = new Promise((resolveClosed) => managed.child.once("close", resolveClosed));
  managed.child.kill("SIGTERM");
  const stopped = await Promise.race([closed.then(() => true), delay(processStopTimeoutMs).then(() => false)]);
  if (!stopped) {
    managed.child.kill("SIGKILL");
    await closed;
  }
};

const writeProcessLogs = async (processes, token) => {
  await Promise.all(
    processes.flatMap((managed) => [
      writeFile(join(evidenceDir, `${managed.label}.stdout.log`), redactText(managed.stdout, token), "utf8"),
      writeFile(join(evidenceDir, `${managed.label}.stderr.log`), redactText(managed.stderr, token), "utf8"),
    ])
  );
};

const parseCliReceipt = (result, args) => {
  const line = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error(
      `torsionfield-script returned no JSON receipt for ${args[0]} (exit ${result.exitCode})\n${result.stdout}\n${result.stderr}`
    );
  }
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`torsionfield-script returned invalid JSON for ${args[0]}: ${preciseError(error)}\n${line}`);
  }
};

const assertSuccessfulReceipt = (receipt, request) => {
  if (receipt.protocolVersion !== TORSIONFIELD_NODE_PROTOCOL) {
    throw new Error(`${request.phase} returned protocol ${receipt.protocolVersion ?? "<missing>"}`);
  }
  if (receipt.operationId !== request.operationId || receipt.requestedAction !== request.operation) {
    throw new Error(`${request.phase} returned a mismatched operation receipt`);
  }
  if (receipt.finalStatus !== "succeeded" || receipt.trustAccepted !== true) {
    throw new Error(`${request.phase} failed: ${receipt.error ?? JSON.stringify(receipt.result)}`);
  }
  if (!Number.isInteger(receipt.attemptCount) || receipt.attemptCount < 1) {
    throw new Error(`${request.phase} returned an invalid attemptCount`);
  }
};

const writeReceipt = async (phase, viaNodeId, targetNodeId, receipt, token) => {
  const record = {
    recordType: "torsion-node-receipt",
    capturedAt: new Date().toISOString(),
    phase,
    viaNodeId,
    targetNodeId: targetNodeId ?? viaNodeId,
    receipt: redactValue(receipt, token),
  };
  await appendFile(receiptsPath, `${JSON.stringify(record)}\n`, "utf8");
};

const createOperationRunner = ({ runId, token }) => {
  let sequence = 0;
  const nextOperationId = (phase) => {
    sequence += 1;
    const name = phase
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    return `torsion-node-${runId}-${sequence}-${name}`;
  };
  const execute = async ({ phase, operation, viaUrl, viaNodeId, targetNodeId, positional = [], options = [] }) => {
    const operationId = nextOperationId(phase);
    const args = [operation, ...positional, "--operation-id", operationId, "--node-url", viaUrl];
    if (targetNodeId) args.push("--target-node", targetNodeId);
    args.push(...options);
    const command = await runCommand(process.execPath, [cliPath, ...args], { timeoutMs: commandTimeoutMs });
    const receipt = parseCliReceipt(command, args);
    return { phase, operation, operationId, viaNodeId, targetNodeId, command, receipt };
  };
  const invoke = async (request) => {
    const result = await execute(request);
    await writeReceipt(result.phase, result.viaNodeId, result.targetNodeId, result.receipt, token);
    assertSuccessfulReceipt(result.receipt, result);
    return result.receipt;
  };
  const waitFor = async (request, predicate, managedNode) => {
    const deadline = Date.now() + startupTimeoutMs;
    let lastObservation = "no receipt";
    while (Date.now() < deadline) {
      if (managedNode && (managedNode.child.exitCode !== null || managedNode.child.signalCode !== null)) {
        throw new Error(
          `${managedNode.label} exited before ${request.phase}\n${managedNode.stdout}\n${managedNode.stderr}`
        );
      }
      try {
        const result = await execute(request);
        lastObservation = result.receipt.error ?? JSON.stringify(result.receipt.result);
        if (
          result.receipt.finalStatus === "succeeded" &&
          result.receipt.trustAccepted === true &&
          predicate(result.receipt)
        ) {
          await writeReceipt(result.phase, result.viaNodeId, result.targetNodeId, result.receipt, token);
          assertSuccessfulReceipt(result.receipt, result);
          return result.receipt;
        }
      } catch (error) {
        lastObservation = preciseError(error);
      }
      await delay(400);
    }
    throw new Error(`${request.phase} was not observed before timeout: ${lastObservation}`);
  };
  return { invoke, waitFor };
};

const assertExecutionVerification = (receipt, expectedValue) => {
  const verification = receipt.result?.executionVerification;
  if (verification?.status !== "passed") {
    throw new Error(`${receipt.requestedAction} did not pass real fixture execution verification`);
  }
  if (
    verification.observed?.attributeValue !== expectedValue ||
    !verification.observed?.text?.includes(expectedValue)
  ) {
    throw new Error(`${receipt.requestedAction} did not observe ${expectedValue} in regular Chrome`);
  }
};

const tabActors = (receipt) => {
  const actors = receipt.result?.actors;
  if (!Array.isArray(actors)) throw new Error("tab.list did not return an actors array");
  return actors;
};

const assertTabActor = (receipt, actorId, fixtureUrl) => {
  const actor = tabActors(receipt).find((entry) => entry.actorId === actorId);
  if (!actor || actor.kind !== "tab" || actor.fixtureUrl !== fixtureUrl || !Number.isInteger(actor.tabId)) {
    throw new Error(`tab.list did not expose the live fixture actor ${actorId}`);
  }
  return actor;
};

const assertTabPostcondition = (receipt, expectedValue) => {
  const postcondition =
    receipt.result?.postcondition ?? receipt.outputEvidence?.postcondition ?? receipt.outputEvidence;
  if (
    postcondition?.selector !== markerSelector ||
    postcondition?.text !== expectedValue ||
    postcondition?.attribute?.name !== markerAttribute ||
    postcondition?.attribute?.value !== expectedValue ||
    postcondition?.visible !== true
  ) {
    throw new Error(`tab.invoke did not prove the visible ${expectedValue} marker`);
  }
  const lease = receipt.outputEvidence?.lease ?? receipt.result?.lease;
  if (lease?.acquired !== true || lease?.released !== true) {
    throw new Error("tab.invoke exposed an incomplete actor lease lifecycle");
  }
};

const assertOfferedActors = (receipt, tabActorId, workerActorId, fixtureUrl) => {
  const offered = receipt.result?.actors?.offered;
  if (!Array.isArray(offered)) throw new Error("node.status did not expose discoverable actor records");
  const tab = offered.find((actor) => actor.actorId === tabActorId);
  if (tab?.kind !== "tab" || tab.fixtureUrl !== fixtureUrl || !Number.isInteger(tab.tabId)) {
    throw new Error(`node.status did not expose the exact fixture actor ${tabActorId}`);
  }
  const worker = offered.find((actor) => actor.actorId === workerActorId);
  if (worker?.kind !== "worker" || !Array.isArray(worker.argv) || worker.argv.length === 0) {
    throw new Error(`node.status did not expose the exact worker actor ${workerActorId}`);
  }
};

const assertNodeStatus = (receipt, nodeId, { extensionConnected, tabCount, workerCount } = {}) => {
  const status = receipt.result;
  if (status?.nodeId !== nodeId)
    throw new Error(`node.status returned ${status?.nodeId ?? "<missing>"}, not ${nodeId}`);
  if (extensionConnected !== undefined && status.extensionConnected !== extensionConnected) {
    throw new Error(`node.status extensionConnected is ${status.extensionConnected}, expected ${extensionConnected}`);
  }
  if (tabCount !== undefined && status.actors?.tabs < tabCount) {
    throw new Error(`node.status restored ${status.actors?.tabs ?? 0} tab actors, expected at least ${tabCount}`);
  }
  if (workerCount !== undefined && status.actors?.workers < workerCount) {
    throw new Error(
      `node.status restored ${status.actors?.workers ?? 0} worker actors, expected at least ${workerCount}`
    );
  }
};

const assertWorkerResult = (receipt) => {
  const result = receipt.result;
  if (
    !Array.isArray(result?.command) ||
    result.exitCode !== 0 ||
    result.timedOut !== false ||
    !Number.isInteger(result.testCount) ||
    result.testCount < 1 ||
    typeof result.resultHash !== "string" ||
    result.resultHash.length !== 64
  ) {
    throw new Error(`worker.run did not return a passing bounded test result: ${JSON.stringify(result)}`);
  }
  if (!result.command.includes(focusedTestPath)) {
    throw new Error("worker.run receipt does not identify the focused Torsionfield test file");
  }
};

const main = async () => {
  const options = parseOptions();
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (options.printAssumptions) {
    process.stdout.write(
      `${JSON.stringify({ protocolVersion: "torsion-node-acceptance-v0.1", finalStatus: "not_run", assumptions })}\n`
    );
    return;
  }

  const runId = randomUUID();
  const suffix = runId.slice(0, 8);
  const nodeAId = `node-a-${suffix}`;
  const nodeBId = `node-b-${suffix}`;
  const tabActorId = `fixture-tab-${suffix}`;
  const workerActorId = `focused-tests-${suffix}`;
  const processes = [];
  const phases = {};
  let nodeA;
  let nodeB;
  let fixture;
  let channelConfig;
  let binary;
  let nodeBUrl;
  let failure;

  await mkdir(resourcesDir, { recursive: true });
  await writeFile(receiptsPath, "", "utf8");

  try {
    channelConfig = readTorsionfieldChannelConfig(rootDir);
    assertLoopbackWebSocketUrl(channelConfig.url);
    await assertPortAvailable(channelConfig.url);
    await assertNodeStateIsIgnored();
    fixture = await startFixtureServer();
    binary = await resolveNodeBinary(options.nodeBin);
    const nodeBPort = await reserveLoopbackPort();
    nodeBUrl = `ws://127.0.0.1:${nodeBPort}`;

    const corepackPath = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
    if (!existsSync(corepackPath)) throw new Error(`shellless Corepack entrypoint is missing: ${corepackPath}`);
    const workerArgv = [process.execPath, corepackPath, "pnpm", "exec", "vitest", "--run", focusedTestPath];
    const operations = createOperationRunner({ runId, token: channelConfig.token });

    await writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          protocolVersion: "torsion-node-acceptance-v0.1",
          runId,
          finalStatus: "in_progress",
          liveAcceptanceExecuted: false,
          inputs: {
            repository: rootDir,
            channelConfigPath,
            nodeA: { nodeId: nodeAId, url: channelConfig.url, portSource: "existing extension config" },
            nodeB: { nodeId: nodeBId, url: nodeBUrl, portSource: "ephemeral loopback reservation" },
            fixtureUrl: fixture.url,
            userscriptPath,
            tabActorId,
            workerActorId,
            focusedWorkerArgv: workerArgv,
            binaryPath: binary.binaryPath,
            build: binary.build,
          },
          assumptions,
          phases: {},
          evidence: { receipts: receiptsPath, summary: summaryPath },
          error: null,
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    nodeA = startManagedNode("node-a-initial", binary.binaryPath, [
      "--repo",
      rootDir,
      "--node-id",
      nodeAId,
      "--listen",
      channelConfig.url,
    ]);
    processes.push(nodeA);
    const nodeAReady = await operations.waitFor(
      {
        phase: "node-a-ready",
        operation: "node.status",
        viaUrl: channelConfig.url,
        viaNodeId: nodeAId,
      },
      (receipt) => receipt.result?.nodeId === nodeAId,
      nodeA
    );
    assertNodeStatus(nodeAReady, nodeAId);
    phases.nodeAReady = nodeAReady.operationId;

    const extensionReady = await operations.waitFor(
      {
        phase: "extension-connected-to-node-a",
        operation: "node.status",
        viaUrl: channelConfig.url,
        viaNodeId: nodeAId,
      },
      (receipt) => receipt.result?.nodeId === nodeAId && receipt.result?.extensionConnected === true,
      nodeA
    );
    assertNodeStatus(extensionReady, nodeAId, { extensionConnected: true });
    phases.extensionReady = extensionReady.operationId;

    nodeB = startManagedNode("node-b", binary.binaryPath, [
      "--repo",
      rootDir,
      "--node-id",
      nodeBId,
      "--listen",
      nodeBUrl,
      "--peer",
      `${nodeAId}=${channelConfig.url}`,
    ]);
    processes.push(nodeB);
    const nodeBReady = await operations.waitFor(
      {
        phase: "node-b-ready",
        operation: "node.status",
        viaUrl: nodeBUrl,
        viaNodeId: nodeBId,
      },
      (receipt) => receipt.result?.nodeId === nodeBId,
      nodeB
    );
    assertNodeStatus(nodeBReady, nodeBId);
    phases.nodeBReady = nodeBReady.operationId;

    const peerDiscovered = await operations.waitFor(
      {
        phase: "node-b-discovers-node-a",
        operation: "node.status",
        viaUrl: nodeBUrl,
        viaNodeId: nodeBId,
        targetNodeId: nodeAId,
      },
      (receipt) => receipt.result?.nodeId === nodeAId,
      nodeB
    );
    assertNodeStatus(peerDiscovered, nodeAId);
    phases.peerDiscovered = peerDiscovered.operationId;

    await writeFile(userscriptPath, userscriptCode(fixture.url, "0.1.0"), "utf8");
    const sourceUri = pathToFileURL(userscriptPath).href;
    const installValue = "fixture-ready-0.1.0";
    const installed = await operations.invoke({
      phase: "fixture-script-install",
      operation: "script.install",
      viaUrl: channelConfig.url,
      viaNodeId: nodeAId,
      positional: [sourceUri],
      options: [
        "--verify-url",
        fixture.url,
        "--verify-selector",
        markerSelector,
        "--verify-attribute",
        `${markerAttribute}=${installValue}`,
        "--verify-text",
        installValue,
      ],
    });
    assertExecutionVerification(installed, installValue);
    phases.scriptInstalled = installed.operationId;

    await writeFile(userscriptPath, userscriptCode(fixture.url, "0.1.1"), "utf8");
    const updateValue = "fixture-ready-0.1.1";
    const updated = await operations.invoke({
      phase: "fixture-script-update",
      operation: "script.update",
      viaUrl: channelConfig.url,
      viaNodeId: nodeAId,
      positional: [sourceUri],
      options: [
        "--verify-url",
        fixture.url,
        "--verify-selector",
        markerSelector,
        "--verify-attribute",
        `${markerAttribute}=${updateValue}`,
        "--verify-text",
        updateValue,
      ],
    });
    assertExecutionVerification(updated, updateValue);
    phases.scriptUpdated = updated.operationId;

    const scriptStatus = await operations.invoke({
      phase: "fixture-script-status",
      operation: "script.status",
      viaUrl: channelConfig.url,
      viaNodeId: nodeAId,
      positional: [updated.operationId],
    });
    if (
      scriptStatus.result?.subjectOperationId !== updated.operationId ||
      scriptStatus.result?.finalStatus !== "succeeded"
    ) {
      throw new Error("script.status did not recover the durable update receipt");
    }
    phases.scriptStatus = scriptStatus.operationId;

    const tabRegistered = await operations.invoke({
      phase: "fixture-tab-register",
      operation: "tab.register",
      viaUrl: channelConfig.url,
      viaNodeId: nodeAId,
      positional: [tabActorId],
      options: ["--url", fixture.url],
    });
    phases.tabRegistered = tabRegistered.operationId;

    const workerOptions = ["--cwd", rootDir, "--command", workerArgv[0]];
    for (const argument of workerArgv.slice(1)) workerOptions.push("--arg", argument);
    workerOptions.push("--timeout-ms", "120000");
    const workerRegistered = await operations.invoke({
      phase: "focused-worker-register",
      operation: "worker.register",
      viaUrl: channelConfig.url,
      viaNodeId: nodeAId,
      positional: [workerActorId],
      options: workerOptions,
    });
    phases.workerRegistered = workerRegistered.operationId;

    const actorsReady = await operations.invoke({
      phase: "node-b-observes-node-a-actors",
      operation: "node.status",
      viaUrl: nodeBUrl,
      viaNodeId: nodeBId,
      targetNodeId: nodeAId,
    });
    assertNodeStatus(actorsReady, nodeAId, { extensionConnected: true, tabCount: 1, workerCount: 1 });
    assertOfferedActors(actorsReady, tabActorId, workerActorId, fixture.url);
    phases.actorsReady = actorsReady.operationId;
    const extensionConnectionId = actorsReady.result?.extensionConnectionId;
    if (!Number.isInteger(extensionConnectionId)) {
      throw new Error("node.status did not expose the authenticated extension connection identity");
    }

    const extensionReloaded = await operations.invoke({
      phase: "node-b-reloads-node-a-extension",
      operation: "extension.reload",
      viaUrl: nodeBUrl,
      viaNodeId: nodeBId,
      targetNodeId: nodeAId,
    });
    phases.extensionReloaded = extensionReloaded.operationId;

    const extensionReconnected = await operations.waitFor(
      {
        phase: "node-b-observes-extension-reconnection",
        operation: "node.status",
        viaUrl: nodeBUrl,
        viaNodeId: nodeBId,
        targetNodeId: nodeAId,
      },
      (receipt) =>
        receipt.result?.nodeId === nodeAId &&
        receipt.result?.extensionConnected === true &&
        receipt.result?.extensionConnectionId > extensionConnectionId,
      nodeB
    );
    phases.extensionReconnected = extensionReconnected.operationId;

    const listed = await operations.invoke({
      phase: "node-b-lists-node-a-tabs",
      operation: "tab.list",
      viaUrl: nodeBUrl,
      viaNodeId: nodeBId,
      targetNodeId: nodeAId,
    });
    assertTabActor(listed, tabActorId, fixture.url);
    phases.tabListed = listed.operationId;

    const invoked = await operations.invoke({
      phase: "node-b-invokes-node-a-tab",
      operation: "tab.invoke",
      viaUrl: nodeBUrl,
      viaNodeId: nodeBId,
      targetNodeId: nodeAId,
      positional: [tabActorId],
      options: ["--value", firstPeerMarker],
    });
    assertTabPostcondition(invoked, firstPeerMarker);
    phases.tabInvoked = invoked.operationId;

    const workerRun = await operations.invoke({
      phase: "node-b-runs-focused-tests-on-node-a",
      operation: "worker.run",
      viaUrl: nodeBUrl,
      viaNodeId: nodeBId,
      targetNodeId: nodeAId,
      positional: [workerActorId],
    });
    assertWorkerResult(workerRun);
    phases.focusedTests = workerRun.operationId;

    await stopManagedNode(nodeA);
    nodeA = undefined;
    await assertPortAvailable(channelConfig.url);
    nodeA = startManagedNode("node-a-restarted", binary.binaryPath, [
      "--repo",
      rootDir,
      "--node-id",
      nodeAId,
      "--listen",
      channelConfig.url,
    ]);
    processes.push(nodeA);

    const restarted = await operations.waitFor(
      {
        phase: "node-b-observes-node-a-restart",
        operation: "node.status",
        viaUrl: nodeBUrl,
        viaNodeId: nodeBId,
        targetNodeId: nodeAId,
      },
      (receipt) =>
        receipt.result?.nodeId === nodeAId &&
        receipt.result?.extensionConnected === true &&
        receipt.result?.actors?.tabs >= 1 &&
        receipt.result?.actors?.workers >= 1,
      nodeB
    );
    assertNodeStatus(restarted, nodeAId, { extensionConnected: true, tabCount: 1, workerCount: 1 });
    assertOfferedActors(restarted, tabActorId, workerActorId, fixture.url);
    phases.nodeARestarted = restarted.operationId;

    const relisted = await operations.invoke({
      phase: "node-b-lists-restored-node-a-tabs",
      operation: "tab.list",
      viaUrl: nodeBUrl,
      viaNodeId: nodeBId,
      targetNodeId: nodeAId,
    });
    assertTabActor(relisted, tabActorId, fixture.url);
    phases.tabRelisted = relisted.operationId;

    const invokedAfterRestart = await operations.invoke({
      phase: "node-b-invokes-node-a-after-restart",
      operation: "tab.invoke",
      viaUrl: nodeBUrl,
      viaNodeId: nodeBId,
      targetNodeId: nodeAId,
      positional: [tabActorId],
      options: ["--value", restartPeerMarker],
    });
    assertTabPostcondition(invokedAfterRestart, restartPeerMarker);
    phases.tabInvokedAfterRestart = invokedAfterRestart.operationId;
  } catch (error) {
    failure = error;
  }

  const cleanupErrors = [];
  for (const managed of [nodeB, nodeA]) {
    try {
      await stopManagedNode(managed);
    } catch (error) {
      cleanupErrors.push(preciseError(error));
    }
  }
  if (fixture) {
    try {
      await fixture.close();
    } catch (error) {
      cleanupErrors.push(preciseError(error));
    }
  }
  try {
    await writeProcessLogs(processes, channelConfig?.token);
  } catch (error) {
    cleanupErrors.push(preciseError(error));
  }
  if (!failure && cleanupErrors.length > 0) failure = new Error(`cleanup failed: ${cleanupErrors.join("; ")}`);

  const summary = redactValue(
    {
      protocolVersion: "torsion-node-acceptance-v0.1",
      runId,
      finalStatus: failure ? "failed" : "succeeded",
      liveAcceptanceExecuted: Object.keys(phases).length > 0,
      inputs: {
        repository: rootDir,
        channelConfigPath,
        nodeA: { nodeId: nodeAId, url: channelConfig?.url ?? null, portSource: "existing extension config" },
        nodeB: { nodeId: nodeBId, url: nodeBUrl ?? null, portSource: "ephemeral loopback reservation" },
        fixtureUrl: fixture?.url ?? null,
        userscriptPath,
        tabActorId,
        workerActorId,
        focusedWorkerArgv: channelConfig
          ? [
              process.execPath,
              join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js"),
              "pnpm",
              "exec",
              "vitest",
              "--run",
              focusedTestPath,
            ]
          : null,
        binaryPath: binary?.binaryPath ?? null,
        build: binary?.build ?? null,
      },
      assumptions,
      phases,
      evidence: {
        receipts: receiptsPath,
        summary: summaryPath,
        processLogs: processes.flatMap((managed) => [
          join(evidenceDir, `${managed.label}.stdout.log`),
          join(evidenceDir, `${managed.label}.stderr.log`),
        ]),
      },
      error: failure ? preciseError(failure) : null,
      cleanupErrors,
    },
    channelConfig?.token
  );
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (failure) process.exitCode = 1;
};

await main();

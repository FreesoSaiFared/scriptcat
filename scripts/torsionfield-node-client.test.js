import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeTorsionfieldNodeRequest,
  TORSIONFIELD_NODE_PROTOCOL,
  TORSIONFIELD_NODE_REQUEST_TIMEOUT_MS,
} from "./torsionfield-node-client.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(resolve);
        })
    )
  );
});

const listen = async (onMessage) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket) => socket.on("message", (raw) => onMessage(socket, JSON.parse(raw.toString()))));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return `ws://127.0.0.1:${address.port}`;
};

describe("resident Torsion Node client", () => {
  it("allows the node's maximum bounded worker runtime plus transport cleanup", () => {
    expect(TORSIONFIELD_NODE_REQUEST_TIMEOUT_MS).toBeGreaterThan(300_000);
  });

  it("authenticates then returns the matching durable node receipt", async () => {
    const token = randomBytes(32).toString("hex");
    const operationId = randomUUID();
    const messages = [];
    const url = await listen((socket, message) => {
      messages.push(message);
      if (message.action === "hello") {
        socket.send(
          JSON.stringify({
            action: "hello/ack",
            data: {
              protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
              role: "node",
              nodeId: "node-a",
              authenticated: true,
            },
          })
        );
      } else if (message.action === "node/request") {
        socket.send(
          JSON.stringify({
            action: "node/result",
            data: {
              protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
              operationId,
              requestedAction: "node.status",
              actor: { nodeId: "node-a", actorId: "node-a", kind: "node" },
              trustAccepted: true,
              trustClassification: "installation_secret",
              attemptCount: 1,
              finalStatus: "succeeded",
              result: { nodeId: "node-a", extensionConnected: true },
              outputEvidence: null,
              error: null,
              startedAt: "2026-08-05T00:00:00.000Z",
              finishedAt: "2026-08-05T00:00:00.001Z",
            },
          })
        );
      }
    });

    const receipt = await executeTorsionfieldNodeRequest({
      url,
      token,
      request: {
        protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
        operationId,
        requestedAction: "node.status",
      },
    });

    expect(receipt).toMatchObject({ operationId, requestedAction: "node.status", finalStatus: "succeeded" });
    expect(messages).toEqual([
      {
        action: "hello",
        data: { protocolVersion: "torsionfield-script-v1", role: "client", token },
      },
      {
        action: "node/request",
        data: { protocolVersion: TORSIONFIELD_NODE_PROTOCOL, operationId, requestedAction: "node.status" },
      },
    ]);
  });

  it("rejects an unauthenticated acknowledgement without sending work", async () => {
    const token = randomBytes(32).toString("hex");
    const messages = [];
    const url = await listen((socket, message) => {
      messages.push(message);
      socket.send(
        JSON.stringify({
          action: "hello/ack",
          data: {
            protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
            role: "node",
            nodeId: "node-a",
            authenticated: false,
          },
        })
      );
    });

    await expect(
      executeTorsionfieldNodeRequest({
        url,
        token,
        request: {
          protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
          operationId: randomUUID(),
          requestedAction: "node.status",
        },
      })
    ).rejects.toThrow("authentication rejected");
    expect(messages).toHaveLength(1);
  });

  it("rejects an acknowledgement that does not identify a resident node", async () => {
    const token = randomBytes(32).toString("hex");
    const url = await listen((socket) => {
      socket.send(
        JSON.stringify({
          action: "hello/ack",
          data: {
            protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
            role: "client",
            nodeId: "",
            authenticated: true,
          },
        })
      );
    });

    await expect(
      executeTorsionfieldNodeRequest({
        url,
        token,
        request: {
          protocolVersion: TORSIONFIELD_NODE_PROTOCOL,
          operationId: randomUUID(),
          requestedAction: "node.status",
        },
      })
    ).rejects.toThrow("invalid resident-node identity");
  });
});

import { WebSocket } from "ws";
import { TORSIONFIELD_CHANNEL_PROTOCOL } from "./torsionfield-channel-config.mjs";

export const TORSIONFIELD_NODE_PROTOCOL = "torsionfield-node-v1";
export const TORSIONFIELD_NODE_REQUEST_TIMEOUT_MS = 330_000;

export const executeTorsionfieldNodeRequest = ({
  url,
  token,
  request,
  timeoutMs = TORSIONFIELD_NODE_REQUEST_TIMEOUT_MS,
}) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let authenticated = false;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    };

    const timeout = setTimeout(
      () => finish(undefined, new Error(`timed out waiting for resident Torsion Node at ${url}`)),
      timeoutMs
    );

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          action: "hello",
          data: { protocolVersion: TORSIONFIELD_CHANNEL_PROTOCOL, role: "client", token },
        })
      );
    });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        finish(undefined, new Error("resident Torsion Node returned invalid JSON"));
        return;
      }
      if (message.action === "hello/ack") {
        if (message.data?.protocolVersion !== TORSIONFIELD_NODE_PROTOCOL) {
          finish(undefined, new Error("resident Torsion Node protocol mismatch"));
          return;
        }
        if (message.data?.authenticated !== true) {
          finish(undefined, new Error("resident Torsion Node authentication rejected"));
          return;
        }
        if (message.data?.role !== "node" || typeof message.data?.nodeId !== "string" || !message.data.nodeId) {
          finish(undefined, new Error("resident Torsion Node returned an invalid resident-node identity"));
          return;
        }
        if (!authenticated) {
          authenticated = true;
          socket.send(JSON.stringify({ action: "node/request", data: request }));
        }
        return;
      }
      if (message.action === "node/result" && message.data?.operationId === request.operationId) {
        finish(message.data);
      }
    });
    socket.on("error", (error) => finish(undefined, error));
    socket.on("close", () => {
      if (!settled) finish(undefined, new Error("resident Torsion Node connection closed before returning a result"));
    });
  });

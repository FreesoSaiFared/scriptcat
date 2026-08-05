import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const TORSIONFIELD_CHANNEL_CONFIG = ".torsionfield-channel.json";
export const TORSIONFIELD_CHANNEL_PROTOCOL = "torsionfield-script-v1";
export const DEFAULT_TORSIONFIELD_CHANNEL_URL = "ws://127.0.0.1:8642";

const assertLoopbackWebSocketUrl = (value) => {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !loopback) {
    throw new Error("Torsionfield development channel URL must be a loopback WebSocket URL");
  }
  if (!url.port) throw new Error("Torsionfield development channel URL must specify a port");
};

export const readTorsionfieldChannelConfig = (rootDir) => {
  const configPath = join(rootDir, TORSIONFIELD_CHANNEL_CONFIG);
  if (!existsSync(configPath)) {
    throw new Error(`Torsionfield development channel is not configured: ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.protocolVersion !== TORSIONFIELD_CHANNEL_PROTOCOL) {
    throw new Error("Torsionfield development channel protocol is invalid");
  }
  assertLoopbackWebSocketUrl(config.url);
  if (typeof config.token !== "string" || config.token.length < 32) {
    throw new Error("Torsionfield development channel token is invalid");
  }
  return config;
};

export const ensureTorsionfieldChannelConfig = (rootDir, enabled) => {
  if (!enabled) return null;
  const configPath = join(rootDir, TORSIONFIELD_CHANNEL_CONFIG);
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          protocolVersion: TORSIONFIELD_CHANNEL_PROTOCOL,
          url: DEFAULT_TORSIONFIELD_CHANNEL_URL,
          token: randomBytes(32).toString("hex"),
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  return readTorsionfieldChannelConfig(rootDir);
};

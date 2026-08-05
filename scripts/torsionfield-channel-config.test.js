import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TORSIONFIELD_CHANNEL_CONFIG,
  TORSIONFIELD_CHANNEL_PROTOCOL,
  ensureTorsionfieldChannelConfig,
  readTorsionfieldChannelConfig,
} from "./torsionfield-channel-config.mjs";

describe("Torsionfield development channel configuration", () => {
  const directories = [];

  const temporaryDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "scriptcat-torsionfield-"));
    directories.push(directory);
    return directory;
  };

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("does not create a trusted channel for an ordinary build", () => {
    const directory = temporaryDirectory();

    expect(ensureTorsionfieldChannelConfig(directory, false)).toBeNull();
    expect(() => readTorsionfieldChannelConfig(directory)).toThrow("is not configured");
  });

  it("creates and reuses one loopback-only authenticated channel", () => {
    const directory = temporaryDirectory();

    const first = ensureTorsionfieldChannelConfig(directory, true);
    const second = ensureTorsionfieldChannelConfig(directory, true);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      protocolVersion: TORSIONFIELD_CHANNEL_PROTOCOL,
      url: "ws://127.0.0.1:8642",
    });
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a non-loopback channel even when it has a strong token", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, TORSIONFIELD_CHANNEL_CONFIG),
      JSON.stringify({
        protocolVersion: TORSIONFIELD_CHANNEL_PROTOCOL,
        url: "wss://example.com/control",
        token: "a".repeat(64),
      })
    );

    expect(() => readTorsionfieldChannelConfig(directory)).toThrow("must be a loopback WebSocket URL");
  });
});

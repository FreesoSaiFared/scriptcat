import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  cacheGet: vi.fn(async () => false),
  cacheSet: vi.fn(async () => undefined),
  cacheTx: vi.fn(),
}));

vi.mock("../offscreen/client", () => ({
  VscodeConnectClient: class {
    connect = mocks.connect;
  },
}));

vi.mock("@App/app/cache", () => ({
  cacheInstance: {
    get: mocks.cacheGet,
    set: mocks.cacheSet,
    tx: mocks.cacheTx,
  },
}));

vi.mock("@App/app/const", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TorsionfieldDevToken: "torsionfield-channel-token",
  TorsionfieldDevUrl: "ws://127.0.0.1:8642",
}));

import { SystemService } from "./system";

describe("SystemService Torsionfield connection ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the build-gated authenticated session from being replaced by ordinary VSCode auto-connect", async () => {
    const subscriptions = new Map<string, () => void>();
    const mq = {
      subscribe: vi.fn((event: string, listener: () => void) => {
        subscriptions.set(event, listener);
      }),
    };
    const systemConfig = {
      getVscodeReconnect: vi.fn(async () => true),
      getVscodeUrl: vi.fn(async () => "ws://127.0.0.1:9000"),
    };
    const service = new SystemService(
      systemConfig as never,
      { on: vi.fn() } as never,
      {} as never,
      mq as never,
      {} as never,
      {} as never
    );

    service.init();
    subscriptions.get("offscreenDocumentReady")?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:8642",
      reconnect: true,
      torsionfield: { token: "torsionfield-channel-token" },
    });
    expect(systemConfig.getVscodeReconnect).not.toHaveBeenCalled();
    expect(systemConfig.getVscodeUrl).not.toHaveBeenCalled();
  });
});

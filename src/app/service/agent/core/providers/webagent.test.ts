import { describe, expect, it } from "vitest";
import type { AgentModelConfig, ChatRequest, ChatStreamEvent } from "../types";
import { MockWebAgentDriver, normalizeWebAgentConfig, webagentProvider } from "./webagent";

const webagentModel: AgentModelConfig = {
  id: "webagent-chatgpt",
  name: "ChatGPT Browser Session",
  provider: "webagent",
  apiBaseUrl: "",
  apiKey: "",
  model: "chatgpt",
  target: "chatgpt",
  transport: "tab-dom",
  mockResponse: "Hello from a logged-in ChatGPT tab",
};

const request: ChatRequest = {
  conversationId: "conv-webagent",
  modelId: "webagent-chatgpt",
  messages: [{ role: "user", content: "hello" }],
};

describe("webagent provider seam", () => {
  it("normalizes keyless browser-session config", () => {
    const config = normalizeWebAgentConfig(webagentModel);

    expect(config.provider).toBe("webagent");
    expect(config.apiKey).toBe("");
    expect(config.target).toBe("chatgpt");
    expect(config.transport).toBe("tab-dom");
  });

  it("mock driver implements health, tab, message, abort, and conversation contract", async () => {
    const driver = new MockWebAgentDriver(normalizeWebAgentConfig(webagentModel));

    await expect(driver.health()).resolves.toMatchObject({ ok: true, target: "chatgpt", transport: "tab-dom" });
    await expect(driver.ensureTab()).resolves.toMatchObject({ target: "chatgpt", transport: "tab-dom" });

    const events: ChatStreamEvent[] = [];
    for await (const event of driver.sendMessage({ request, model: webagentModel })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "content_delta", delta: "Hello from a logged-in ChatGPT tab" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 7 } },
    ]);

    await driver.abort();
    await expect(driver.readConversation()).resolves.toMatchObject({
      target: "chatgpt",
      messages: [{ role: "assistant", content: "Hello from a logged-in ChatGPT tab" }],
    });
  });

  it("direct provider execution adapts mock driver output to ChatStreamEvent without API keys", async () => {
    const events: ChatStreamEvent[] = [];

    await webagentProvider.execute!(
      { model: webagentModel, request, resolver: () => null },
      (event) => events.push(event),
      new AbortController().signal
    );

    expect(events.map((event) => event.type)).toEqual(["content_delta", "done"]);
    expect(events[0]).toEqual({ type: "content_delta", delta: "Hello from a logged-in ChatGPT tab" });
  });
});

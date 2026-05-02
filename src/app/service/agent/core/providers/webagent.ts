import { getTextContent } from "../content_utils";
import type {
  AgentModelConfig,
  ChatRequest,
  ChatStreamEvent,
  MessageContent,
  MessageRole,
  WebAgentTarget,
  WebAgentTransport,
} from "../types";
import type { LLMProvider, ProviderBuildRequestInput, ProviderStreamEventHandler } from "./types";

const WEBAGENT_TARGETS: WebAgentTarget[] = ["chatgpt", "gemini", "claude"];
const WEBAGENT_TRANSPORTS: WebAgentTransport[] = ["tab-dom", "cdp", "local-bridge"];

export type WebAgentModelConfig = AgentModelConfig & {
  provider: "webagent";
  target: WebAgentTarget;
  transport: WebAgentTransport;
};

export type WebAgentHealth = {
  ok: boolean;
  target: WebAgentTarget;
  transport: WebAgentTransport;
  message?: string;
};

export type WebAgentTabRef = {
  tabId: number;
  target: WebAgentTarget;
  transport: WebAgentTransport;
  url?: string;
};

export type WebAgentConversationMessage = {
  role: Extract<MessageRole, "user" | "assistant">;
  content: MessageContent;
};

export type WebAgentConversation = {
  target: WebAgentTarget;
  transport: WebAgentTransport;
  messages: WebAgentConversationMessage[];
};

export type WebAgentSendMessageInput = {
  model: AgentModelConfig;
  request: ChatRequest;
};

export interface WebAgentDriver {
  health(): Promise<WebAgentHealth>;
  ensureTab(): Promise<WebAgentTabRef>;
  sendMessage(input: WebAgentSendMessageInput, signal?: AbortSignal): AsyncIterable<ChatStreamEvent>;
  abort(): Promise<void>;
  readConversation(): Promise<WebAgentConversation>;
}

export type WebAgentDriverFactory = (config: WebAgentModelConfig) => WebAgentDriver;

function isWebAgentTarget(value: string | undefined): value is WebAgentTarget {
  return !!value && WEBAGENT_TARGETS.includes(value as WebAgentTarget);
}

function isWebAgentTransport(value: string | undefined): value is WebAgentTransport {
  return !!value && WEBAGENT_TRANSPORTS.includes(value as WebAgentTransport);
}

export function normalizeWebAgentConfig(model: AgentModelConfig): WebAgentModelConfig {
  const target = isWebAgentTarget(model.target)
    ? model.target
    : isWebAgentTarget(model.model)
      ? model.model
      : "chatgpt";
  const transport = isWebAgentTransport(model.transport) ? model.transport : "tab-dom";

  return {
    ...model,
    provider: "webagent",
    apiBaseUrl: model.apiBaseUrl || "",
    apiKey: model.apiKey || "",
    model: model.model || target,
    target,
    transport,
  };
}

function estimateTokens(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, words.length);
}

export class MockWebAgentDriver implements WebAgentDriver {
  private aborted = false;
  private messages: WebAgentConversationMessage[] = [];

  constructor(private config: WebAgentModelConfig) {}

  async health(): Promise<WebAgentHealth> {
    return {
      ok: true,
      target: this.config.target,
      transport: this.config.transport,
      message: "mock WebAgent driver ready",
    };
  }

  async ensureTab(): Promise<WebAgentTabRef> {
    return {
      tabId: -1,
      target: this.config.target,
      transport: this.config.transport,
      url: `mock://${this.config.target}`,
    };
  }

  async *sendMessage(input: WebAgentSendMessageInput, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    if (this.aborted || signal?.aborted) return;

    const lastUserText =
      [...input.request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const response =
      this.config.mockResponse ||
      `[WebAgent mock:${this.config.target}/${this.config.transport}] ${getTextContent(lastUserText) || "ready"}`;

    this.messages = [{ role: "assistant", content: response }];

    yield { type: "content_delta", delta: response };
    if (this.aborted || signal?.aborted) return;
    yield {
      type: "done",
      usage: {
        inputTokens: estimateTokens(getTextContent(lastUserText)),
        outputTokens: estimateTokens(response) + 1,
      },
    };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async readConversation(): Promise<WebAgentConversation> {
    return {
      target: this.config.target,
      transport: this.config.transport,
      messages: this.messages,
    };
  }
}

export function createMockWebAgentDriver(config: WebAgentModelConfig): WebAgentDriver {
  return new MockWebAgentDriver(config);
}

export function createWebAgentProvider(driverFactory: WebAgentDriverFactory = createMockWebAgentDriver): LLMProvider {
  return {
    name: "webagent",

    buildRequest(): never {
      throw new Error("WebAgent provider uses direct browser-session driver execution, not API-key HTTP fetch");
    },

    async execute(
      input: ProviderBuildRequestInput,
      onEvent: ProviderStreamEventHandler,
      signal: AbortSignal
    ): Promise<void> {
      const config = normalizeWebAgentConfig(input.model);
      const driver = driverFactory(config);
      const health = await driver.health();
      if (!health.ok) {
        onEvent({ type: "error", message: health.message || "WebAgent driver is not healthy" });
        return;
      }

      await driver.ensureTab();

      try {
        for await (const event of driver.sendMessage({ model: input.model, request: input.request }, signal)) {
          if (signal.aborted) {
            await driver.abort();
            return;
          }
          onEvent(event);
        }
      } finally {
        if (signal.aborted) {
          await driver.abort();
        }
      }
    },

    async parseStream(): Promise<void> {
      throw new Error("WebAgent provider streams through execute(), not parseStream()");
    },
  };
}

export const webagentProvider = createWebAgentProvider();

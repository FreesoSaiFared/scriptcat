import LoggerCore from "@App/app/logger/core";
import Logger from "@App/app/logger/logger";
import { type Group } from "@Packages/message/server";
import type { MessageSend } from "@Packages/message/types";
import { ScriptClient, TorsionfieldDevClient } from "../service_worker/client";
import { v5 as uuidv5 } from "uuid";
import type { TorsionfieldDevRequest, TorsionfieldDevResult } from "../service_worker/torsionfield_dev";

/**
 * VSCode ↔ ScriptCat 连接管理器
 *
 * 在 offscreen 下与 scriptcat-vscode 建立 WebSocket 连接，实现热重载和即时安装。
 * 使用 epoch 机制防止旧连接回调干扰新连接，支持断线自动重连和连接超时。
 *
 * @see https://github.com/scriptscat/scriptcat-vscode
 */

const CONFIG = {
  CONNECT_TIMEOUT: 30_000,
  BASE_RECONNECT_DELAY: 1000,
  MAX_RECONNECT_DELAY: 10_000,
  NAMESPACE: uuidv5.URL, // 缓存 UUID Namespace
} as const;

export interface VSCodeConnectParam {
  url: string;
  reconnect: boolean;
  torsionfield?: { token: string };
}

type VSCodeMessage =
  | {
      action: "hello";
      data?: {
        protocolVersion: "torsionfield-script-v1";
        role: "extension" | "node";
        token?: string;
        nodeId?: string;
      };
    }
  | {
      action: "hello/ack";
      data: {
        protocolVersion: "torsionfield-node-v1";
        role: "node";
        nodeId: string;
        authenticated: boolean;
      };
    }
  | { action: "onchange"; data?: { script?: string; uri?: string } }
  | { action: "torsionfield"; data: TorsionfieldDevRequest }
  | { action: "torsionfield/result"; data: TorsionfieldDevResult };

export class VSCodeConnect {
  private readonly logger = LoggerCore.logger().with({ service: "VSCodeConnect" });
  private readonly scriptClient: ScriptClient;
  private readonly torsionfieldClient: TorsionfieldDevClient;

  // 连接状态
  private ws: WebSocket | null = null;
  private epoch = 0; // 用于废弃旧连接的回调
  private currentParams: VSCodeConnectParam | null = null;
  private torsionfieldAuthenticated = false;

  // 重连策略
  private reconnectDelay: number = CONFIG.BASE_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly messageGroup: Group,
    messageSender: MessageSend
  ) {
    this.scriptClient = new ScriptClient(messageSender);
    this.torsionfieldClient = new TorsionfieldDevClient(messageSender);
  }

  public init(): void {
    this.messageGroup.on("connect", (params: VSCodeConnectParam) => {
      this.reconnectDelay = CONFIG.BASE_RECONNECT_DELAY;
      this.startSession(params);
    });
  }

  /**
   * 启动一个新的连接会话
   * 每次调用都会递增 epoch，自动使旧的连接和定时器失效
   */
  private startSession(params: VSCodeConnectParam): void {
    this.dispose(); // 彻底清理旧资源
    this.currentParams = params;

    // 开启新一轮连接
    this.epoch++;
    this.connect(this.epoch);
  }

  /**
   * 执行实际连接逻辑
   */
  private connect(sessionEpoch: number): void {
    const url = this.currentParams?.url;
    if (!url) return;

    try {
      this.logger.debug(`Attempting connection (Epoch: ${sessionEpoch})`, { url });
      this.ws = new WebSocket(url);

      // 设置连接超时看门狗
      this.connectTimeoutTimer = setTimeout(() => {
        if (sessionEpoch === this.epoch) {
          this.logger.warn("Connection timeout");
          this.ws?.close();
        }
      }, CONFIG.CONNECT_TIMEOUT);

      // 绑定事件
      this.ws.onopen = () => this.handleOpen(sessionEpoch);
      this.ws.onmessage = (ev) => this.handleMessage(ev, sessionEpoch);
      this.ws.onclose = () => this.handleClose(sessionEpoch);
      this.ws.onerror = (ev) => this.handleError(ev, sessionEpoch);
    } catch (e) {
      this.logger.error("WebSocket creation failed", Logger.E(e));
      this.handleError(e, sessionEpoch);
    }
  }

  private handleOpen(sessionEpoch: number): void {
    if (sessionEpoch !== this.epoch) return;

    this.logger.info("WebSocket connected");
    this.torsionfieldAuthenticated = false;

    // 清除超时检测
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }

    // 重置重连指数退避
    this.reconnectDelay = CONFIG.BASE_RECONNECT_DELAY;

    // 发送握手
    const torsionfield = this.currentParams?.torsionfield;
    this.send(
      torsionfield
        ? {
            action: "hello",
            data: {
              protocolVersion: "torsionfield-script-v1",
              role: "extension",
              token: torsionfield.token,
            },
          }
        : { action: "hello" }
    );
  }

  private handleMessage(ev: MessageEvent, sessionEpoch: number): void {
    if (sessionEpoch !== this.epoch) return;

    try {
      const msg = JSON.parse(ev.data as string) as VSCodeMessage;

      switch (msg.action) {
        case "hello":
          this.logger.debug("Handshake confirmed");
          break;
        case "hello/ack":
          if (
            this.currentParams?.torsionfield &&
            msg.data.protocolVersion === "torsionfield-node-v1" &&
            msg.data.role === "node" &&
            typeof msg.data.nodeId === "string" &&
            msg.data.nodeId.length > 0 &&
            msg.data.authenticated === true
          ) {
            this.torsionfieldAuthenticated = true;
            this.logger.debug("Torsionfield handshake confirmed", { nodeId: msg.data.nodeId });
          } else {
            this.torsionfieldAuthenticated = false;
            this.logger.warn("Invalid Torsionfield handshake acknowledgment", {
              protocolVersion: msg.data.protocolVersion,
              role: msg.data.role,
              nodeId: msg.data.nodeId,
              authenticated: msg.data.authenticated,
            });
            this.ws?.close();
          }
          break;
        case "onchange":
          void this.handleScriptUpdate(msg.data);
          break;
        case "torsionfield":
          if (!this.currentParams?.torsionfield || !this.torsionfieldAuthenticated) {
            this.logger.warn("Ignored command from an unauthenticated Torsionfield connection");
            break;
          }
          void this.handleTorsionfieldCommand(msg.data);
          break;
        default:
          this.logger.warn("Unknown action received", { action: msg.action });
      }
    } catch (e) {
      this.logger.warn("Failed to parse message", Logger.E(e));
    }
  }

  private handleClose(sessionEpoch: number): void {
    if (sessionEpoch !== this.epoch) return;

    // 关闭时不仅置空 ws，也要清理超时定时器
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }

    this.ws = null;
    this.logger.debug("WebSocket connection closed");

    // 无论是由 onerror 还是 onclose 触发，scheduleReconnect 会通过 reconnectTimer
    // 判断是否已有重连定时器，避免重复调度。
    this.scheduleReconnect();
  }

  private handleError(ev: Event | Error | unknown, sessionEpoch: number): void {
    if (sessionEpoch !== this.epoch) return;
    this.logger.error("WebSocket error", {
      event: ev instanceof Event ? ev.type : undefined,
      error: ev instanceof Error ? ev.message : String(ev),
    });
    // 发生错误时立即尝试介入重连，无需等待 onclose 事件。
    // reconnectTimer 会拦截后续 handleClose 发起的重复请求。
    this.scheduleReconnect();
  }

  private async handleScriptUpdate(data: { script?: string; uri?: string } | undefined): Promise<void> {
    const { script, uri } = data || {};
    if (!script || !uri) {
      this.logger.warn("Invalid script update payload", { uri });
      return;
    }

    try {
      const stableId = uuidv5(uri, CONFIG.NAMESPACE);
      await this.scriptClient.installByCode(stableId, script, "vscode");
      this.logger.info("Script installed/updated", { uuid: stableId, uri });
    } catch (e) {
      this.logger.error("Install failed", Logger.E(e));
    }
  }

  private async handleTorsionfieldCommand(request: TorsionfieldDevRequest): Promise<void> {
    try {
      const result = await this.torsionfieldClient.execute(request);
      this.send({ action: "torsionfield/result", data: result });
    } catch (error) {
      this.send({
        action: "torsionfield/result",
        data: {
          protocolVersion: "torsionfield-script-v1",
          operationId: request.operationId,
          requestedAction: request.requestedAction,
          trustAccepted: false,
          trustClassification: "transport_unavailable",
          scriptId: null,
          scriptName: null,
          requestedVersion: null,
          installedVersion: null,
          attemptCount: 1,
          finalStatus: "failed",
          executionVerification: { status: "not_run" },
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private send(msg: VSCodeMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (!this.currentParams?.reconnect || this.reconnectTimer) return;
    const sessionEpoch = this.epoch;
    this.logger.debug(`Scheduling reconnect in ${this.reconnectDelay}ms`);

    this.reconnectTimer = setTimeout(() => {
      // 双重检查 epoch，确保在等待重连期间没有开启新的会话
      if (sessionEpoch !== this.epoch) return;

      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, CONFIG.MAX_RECONNECT_DELAY);

      this.connect(sessionEpoch);
    }, this.reconnectDelay);
  }

  /**
   * 销毁当前连接资源
   */
  private dispose(): void {
    this.torsionfieldAuthenticated = false;
    // 停止所有定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }

    // 2. 关闭 Socket 并移除事件监听 (通过设为 null 配合 GC)
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

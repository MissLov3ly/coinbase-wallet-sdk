// Copyright (c) 2018-2023 Coinbase, Inc. <https://www.coinbase.com/>
// Licensed under the Apache License, version 2.0

import { ServerMessage } from '../type/ServerMessage';

export interface WalletLinkWebSocketUpdateListener {
  websocketConnectionUpdated(connected: boolean): void;
  websocketMessageReceived(message: ServerMessage): void;
}

interface WalletLinkWebSocketParams {
  url: string;
  listener: WalletLinkWebSocketUpdateListener;
  WebSocketClass?: typeof WebSocket;
}

export class WalletLinkWebSocket {
  private readonly url: string;
  private readonly WebSocketClass: typeof WebSocket;
  private webSocket: WebSocket | null = null;
  private pendingData: string[] = [];

  private listener?: WalletLinkWebSocketUpdateListener;

  /**
   * Constructor
   * @param url WebSocket server URL
   * @param listener WalletLinkWebSocketUpdateListener
   * @param [WebSocketClass] Custom WebSocket implementation
   */
  constructor({ url, listener, WebSocketClass = WebSocket }: WalletLinkWebSocketParams) {
    this.url = url.replace(/^http/, 'ws');
    this.listener = listener;
    this.WebSocketClass = WebSocketClass;
  }

  /**
   * Make a websocket connection
   * @returns a Promise that resolves when connected
   */
  public async connect() {
    if (this.webSocket) {
      throw new Error('webSocket object is not null');
    }
    return new Promise<void>((resolve, reject) => {
      let webSocket: WebSocket;
      try {
        this.webSocket = webSocket = new this.WebSocketClass(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      webSocket.onclose = (evt) => {
        this.clearWebSocket();
        reject(new Error(`websocket error ${evt.code}: ${evt.reason}`));
        this.listener?.websocketConnectionUpdated(false);
      };
      webSocket.onopen = (_) => {
        resolve();
        this.listener?.websocketConnectionUpdated(true);

        if (this.pendingData.length > 0) {
          const pending = [...this.pendingData];
          pending.forEach((data) => this.sendData(data));
          this.pendingData = [];
        }
      };
      webSocket.onmessage = (evt) => {
        if (evt.data === 'h') {
          this.listener?.websocketMessageReceived({
            type: 'Heartbeat',
          });
        } else {
          try {
            const message = JSON.parse(evt.data) as ServerMessage;
            this.listener?.websocketMessageReceived(message);
          } catch {
            /* empty */
          }
        }
      };
    });
  }

  /**
   * Disconnect from server
   */
  public disconnect(): void {
    const { webSocket } = this;
    if (!webSocket) {
      return;
    }
    this.clearWebSocket();

    this.listener?.websocketConnectionUpdated(false);
    this.listener = undefined;

    try {
      webSocket.close();
    } catch {
      // noop
    }
  }

  /**
   * Send data to server
   * @param data text to send
   */
  public sendData(data: string): void {
    const { webSocket } = this;
    if (!webSocket) {
      this.pendingData.push(data);
      this.connect();
      return;
    }
    webSocket.send(data);
  }

  private clearWebSocket(): void {
    const { webSocket } = this;
    if (!webSocket) {
      return;
    }
    this.webSocket = null;
    webSocket.onclose = null;
    webSocket.onerror = null;
    webSocket.onmessage = null;
    webSocket.onopen = null;
  }
}

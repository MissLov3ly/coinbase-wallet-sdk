// Copyright (c) 2018-2023 Coinbase, Inc. <https://www.coinbase.com/>
// Licensed under the Apache License, version 2.0

import { IntNumber } from '../../../core/type';
import { Cipher } from '../../../lib/Cipher';
import { DiagnosticLogger, EVENTS } from '../../../provider/DiagnosticLogger';
import { APP_VERSION_KEY, WALLET_USER_NAME_KEY } from '../../RelayAbstract';
import { Session } from '../../Session';
import { ClientMessage } from '../type/ClientMessage';
import { ServerMessage, ServerMessageType } from '../type/ServerMessage';
import { SessionConfig } from '../type/SessionConfig';
import { WalletLinkEventData, WalletLinkResponseEventData } from '../type/WalletLinkEventData';
import { WalletLinkHTTP } from './WalletLinkHTTP';
import {
  ConnectionState,
  WalletLinkWebSocket,
  WalletLinkWebSocketUpdateListener,
} from './WalletLinkWebSocket';

export interface WalletLinkConnectionUpdateListener {
  linkedUpdated: (linked: boolean) => void;
  connectedUpdated: (connected: boolean) => void;
  handleWeb3ResponseMessage: (message: WalletLinkResponseEventData) => void;
  chainUpdated: (chainId: string, jsonRpcUrl: string) => void;
  accountUpdated: (selectedAddress: string) => void;
  metadataUpdated: (key: string, metadataValue: string) => void;
  resetAndReload: () => void;
}

interface WalletLinkConnectionParams {
  session: Session;
  linkAPIUrl: string;
  listener: WalletLinkConnectionUpdateListener;
  diagnostic?: DiagnosticLogger;
  WebSocketClass?: typeof WebSocket;
}

/**
 * Coinbase Wallet Connection
 */
export class WalletLinkConnection implements WalletLinkWebSocketUpdateListener {
  private destroyed = false;

  private readonly session: Session;
  private listener?: WalletLinkConnectionUpdateListener;
  private diagnostic?: DiagnosticLogger;
  private cipher: Cipher;
  private ws: WalletLinkWebSocket;
  private http: WalletLinkHTTP;

  /**
   * Constructor
   * @param session Session
   * @param linkAPIUrl Coinbase Wallet link server URL
   * @param listener WalletLinkConnectionUpdateListener
   * @param [WebSocketClass] Custom WebSocket implementation
   */
  constructor({
    session,
    linkAPIUrl,
    listener,
    diagnostic,
    WebSocketClass = WebSocket,
  }: WalletLinkConnectionParams) {
    this.session = session;
    this.cipher = new Cipher(session.secret);
    this.diagnostic = diagnostic;
    this.listener = listener;

    this.ws = new WalletLinkWebSocket({
      linkAPIUrl,
      session,
      WebSocketClass,
      listener: this,
    });

    this.http = new WalletLinkHTTP(linkAPIUrl, session.id, session.key);
  }

  /**
   * @param state ConnectionState;
   * ConnectionState.CONNECTING is used for logging only
   * TODO: Revisit if the logging is necessary. If not, deprecate the enum and use boolean instead.
   */
  websocketConnectionStateUpdated = async (state: ConnectionState) => {
    this.diagnostic?.log(EVENTS.CONNECTED_STATE_CHANGE, {
      state,
      sessionIdHash: Session.hash(this.session.id),
    });

    switch (state) {
      case ConnectionState.DISCONNECTED:
        if (this.destroyed) return;
        this.reconnect();
        break;
      case ConnectionState.CONNECTED:
        this.websocketConnected();
        break;
      case ConnectionState.CONNECTING:
        break;
    }
  };

  /**
   * This section of code implements a reconnect behavior that was ported from a legacy system.
   * Preserving original comments to maintain the rationale and context provided by the original author.
   * https://github.com/coinbase/coinbase-wallet-sdk/commit/2087ee4a7d40936cd965011bfacdb76ce3462894#diff-dd71e86752e2c20c0620eb0ba4c4b21674e55ae8afeb005b82906a3821e5023cR84
   * TOOD: Revisit this logic to assess its validity in the current system context.
   */
  private reconnect = async () => {
    // wait 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // check whether it's destroyed again
    if (!this.destroyed) {
      // reconnect
      this.ws.connect().catch(() => {
        this.reconnect();
      });
    }
  };

  private websocketConnected(): void {
    // check for unseen events
    if (this.shouldFetchUnseenEventsOnConnect) {
      this.fetchUnseenEventsAPI();
    }

    // distinctUntilChanged
    if (this.connected !== true) {
      this.connected = true;
    }
  }

  /**
   * @param msg Partial<ServerMessageIsLinkedOK>
   * Only for logging
   * TODO: Revisit if this is necessary
   */
  websocketLinkedUpdated = (
    linked: boolean,
    msg: ServerMessageIsLinkedOK | ServerMessageLinked
  ) => {
    this.diagnostic?.log(EVENTS.LINKED, {
      sessionIdHash: Session.hash(this.session.id),
      linked: msg.type === 'IsLinkedOK' ? msg.linked : false,
      type: msg.type,
      onlineGuests: msg.onlineGuests,
    });

    this.listener?.linkedUpdated(linked);
  };

  /**
   * Only for logging
   * TODO: Revisit if this is necessary. If not, call handleSessionMetadataUpdated directly.
   */
  websocketSessionMetadataUpdated = (metadata: SessionConfig['metadata']) => {
    this.diagnostic?.log(EVENTS.SESSION_CONFIG_RECEIVED, {
      sessionIdHash: Session.hash(this.session.id),
      metadata_keys: metadata ? Object.keys(metadata) : undefined,
    });

    this.handleSessionMetadataUpdated(metadata);
  };

  websocketServerMessageReceived = (m: ServerMessage) => {
    switch (m.type) {
      case 'Event': {
        this.handleIncomingEvent(m);
        break;
      }
    }

    // // resolve request promises
    // if (m.id !== undefined) {
    //   this.requestResolutions.get(m.id)?.(m);
    // }
  };

  /**
   * Make a connection to the server
   */
  public connect(): void {
    if (this.destroyed) {
      throw new Error('instance is destroyed');
    }
    this.diagnostic?.log(EVENTS.STARTED_CONNECTING, {
      sessionIdHash: Session.hash(this.session.id),
    });
    this.ws.connect();
  }

  /**
   * Terminate connection, and mark as destroyed. To reconnect, create a new
   * instance of WalletSDKConnection
   */
  public destroy(): void {
    this.destroyed = true;

    this.ws.disconnect();
    this.diagnostic?.log(EVENTS.DISCONNECTED, {
      sessionIdHash: Session.hash(this.session.id),
    });

    this.listener = undefined;
  }

  /**
   * true if connected and authenticated, else false
   * runs listener when connected status changes
   */
  private _connected = false;
  private get connected(): boolean {
    return this._connected;
  }
  private set connected(connected: boolean) {
    this._connected = connected;
    if (connected) this.onceConnected?.();
    this.listener?.connectedUpdated(connected);
  }

  /**
   * Execute once when connected
   */
  private onceConnected?: () => void;
  private setOnceConnected<T>(callback: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      if (this.connected) {
        callback().then(resolve);
      } else {
        this.onceConnected = () => {
          callback().then(resolve);
          this.onceConnected = undefined;
        };
      }
    });
  }

  private async handleIncomingEvent(m: ServerMessage) {
    if (m.type !== 'Event' || m.event !== 'Web3Response') {
      return;
    }

    try {
      const decryptedData = await this.cipher.decrypt(m.data);
      const message = JSON.parse(decryptedData);

      if (message.type !== 'WEB3_RESPONSE') return;

      this.listener?.handleWeb3ResponseMessage(message);
    } catch {
      this.diagnostic?.log(EVENTS.GENERAL_ERROR, {
        message: 'Had error decrypting',
        value: 'incomingEvent',
      });
    }
  }

  private shouldFetchUnseenEventsOnConnect = false;

  public async checkUnseenEvents() {
    if (!this.connected) {
      this.shouldFetchUnseenEventsOnConnect = true;
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      await this.fetchUnseenEventsAPI();
    } catch (e) {
      console.error('Unable to check for unseen events', e);
    }
  }

  private async fetchUnseenEventsAPI() {
    this.shouldFetchUnseenEventsOnConnect = false;

    const responseEvents = await this.http.fetchUnseenEvents();
    responseEvents.forEach((e) => this.handleIncomingEvent(e));
  }

  /**
   * Set session metadata in SessionConfig object
   * @param key
   * @param value
   * @returns a Promise that completes when successful
   */
  public async setSessionMetadata(key: string, value: string | null) {
    const message: ClientMessage = {
      type: 'SetSessionConfig',
      id: IntNumber(this.nextReqId++),
      sessionId: this.session.id,
      metadata: { [key]: value },
    };

    return this.setOnceConnected(async () => {
      const res = await this.makeRequest<'OK' | 'Fail'>(message);
      if (res.type === 'Fail') {
        throw new Error(res.error || 'failed to set session metadata');
      }
    });
  }

  /**
   * Publish an event and emit event ID when successful
   * @param event event name
   * @param unencryptedData unencrypted event data
   * @param callWebhook whether the webhook should be invoked
   * @returns a Promise that emits event ID when successful
   */
  public async publishEvent(
    event: string,
    unencryptedData: WalletLinkEventData,
    callWebhook = false
  ) {
    const data = await this.cipher.encrypt(
      JSON.stringify({
        ...unencryptedData,
        origin: location.origin,
        relaySource: window.coinbaseWalletExtension ? 'injected_sdk' : 'sdk',
      })
    );

    const message: ClientMessage = {
      type: 'PublishEvent',
      id: IntNumber(this.nextReqId++),
      sessionId: this.session.id,
      event,
      data,
      callWebhook,
    };

    return this.setOnceLinked(async () => {
      const res = await this.makeRequest<'PublishEventOK' | 'Fail'>(message);
      if (res.type === 'Fail') {
        throw new Error(res.error || 'failed to publish event');
      }
      return res.eventId;
    });
  }

  private sendData(message: ClientMessage): void {
    this.ws.sendData(JSON.stringify(message));
  }

  private updateLastHeartbeat(): void {
    this.lastHeartbeatResponse = Date.now();
  }

  private heartbeat(): void {
    if (Date.now() - this.lastHeartbeatResponse > HEARTBEAT_INTERVAL * 2) {
      this.ws.disconnect();
      return;
    }
    try {
      this.ws.sendData('h');
    } catch {
      // noop
    }
  }

  private requestResolutions = new Map<IntNumber, (_: ServerMessage) => void>();

  private async makeRequest<T extends ServerMessageType, M = ServerMessage<T>>(
    message: ClientMessage,
    timeout: number = REQUEST_TIMEOUT
  ): Promise<M> {
    const reqId = message.id;
    this.sendData(message);

    // await server message with corresponding id
    let timeoutId: number;
    return Promise.race([
      new Promise<M>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`request ${reqId} timed out`));
        }, timeout);
      }),
      new Promise<M>((resolve) => {
        this.requestResolutions.set(reqId, (m) => {
          clearTimeout(timeoutId); // clear the timeout
          resolve(m as M);
          this.requestResolutions.delete(reqId);
        });
      }),
    ]);
  }

  private async authenticate() {
    const m: ClientMessage = {
      type: 'HostSession',
      id: IntNumber(this.nextReqId++),
      sessionId: this.session.id,
      sessionKey: this.session.key,
    };
    const res = await this.makeRequest<'OK' | 'Fail'>(m);
    if (res.type === 'Fail') {
      throw new Error(res.error || 'failed to authentcate');
    }
  }

  private sendIsLinked(): void {
    const m: ClientMessage = {
      type: 'IsLinked',
      id: IntNumber(this.nextReqId++),
      sessionId: this.session.id,
    };
    this.sendData(m);
  }

  public sendGetSessionConfig(): Promise<ServerMessage> {
    const m: ClientMessage = {
      type: 'GetSessionConfig',
      id: IntNumber(this.nextReqId++),
      sessionId: this.session.id,
    };
    return this.makeRequest(m);
  }

  private handleSessionMetadataUpdated = (metadata: SessionConfig['metadata']) => {
    if (!metadata) return;

    // Map of metadata key to handler function
    const handlers = new Map<string, (value: string) => void>([
      ['__destroyed', this.handleDestroyed],
      ['EthereumAddress', this.handleAccountUpdated],
      ['WalletUsername', this.handleWalletUsernameUpdated],
      ['AppVersion', this.handleAppVersionUpdated],
      [
        'ChainId', // ChainId and JsonRpcUrl are always updated together
        (v: string) => metadata.JsonRpcUrl && this.handleChainUpdated(v, metadata.JsonRpcUrl),
      ],
    ]);

    // call handler for each metadata key if value is defined
    handlers.forEach((handler, key) => {
      const value = metadata[key];
      if (value === undefined) return;
      handler(value);
    });
  };

  private handleDestroyed = (__destroyed: string) => {
    if (__destroyed !== '1') return;

    this.listener?.resetAndReload();
    this.diagnostic?.log(EVENTS.METADATA_DESTROYED, {
      alreadyDestroyed: this.destroyed,
      sessionIdHash: Session.hash(this.session.id),
    });
  };

  private handleAccountUpdated = async (encryptedEthereumAddress: string) => {
    try {
      const address = await this.cipher.decrypt(encryptedEthereumAddress);
      this.listener?.accountUpdated(address);
    } catch {
      this.diagnostic?.log(EVENTS.GENERAL_ERROR, {
        message: 'Had error decrypting',
        value: 'selectedAddress',
      });
    }
  };

  private handleMetadataUpdated = async (key: string, encryptedMetadataValue: string) => {
    try {
      const decryptedValue = await this.cipher.decrypt(encryptedMetadataValue);
      this.listener?.metadataUpdated(key, decryptedValue);
    } catch {
      this.diagnostic?.log(EVENTS.GENERAL_ERROR, {
        message: 'Had error decrypting',
        value: key,
      });
    }
  };

  private handleWalletUsernameUpdated = async (walletUsername: string) => {
    this.handleMetadataUpdated(WALLET_USER_NAME_KEY, walletUsername);
  };

  private handleAppVersionUpdated = async (appVersion: string) => {
    this.handleMetadataUpdated(APP_VERSION_KEY, appVersion);
  };

  private handleChainUpdated = async (encryptedChainId: string, encryptedJsonRpcUrl: string) => {
    try {
      const chainId = await this.cipher.decrypt(encryptedChainId);
      const jsonRpcUrl = await this.cipher.decrypt(encryptedJsonRpcUrl);
      this.listener?.chainUpdated(chainId, jsonRpcUrl);
    } catch {
      this.diagnostic?.log(EVENTS.GENERAL_ERROR, {
        message: 'Had error decrypting',
        value: 'chainId|jsonRpcUrl',
      });
    }
  };
}

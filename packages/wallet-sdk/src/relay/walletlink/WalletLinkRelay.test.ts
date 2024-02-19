/* eslint-disable @typescript-eslint/no-explicit-any */

import { ServerMessage } from '../connection/ServerMessage';
import { SessionConfig } from '../connection/SessionConfig';
import { WalletLinkConnection } from '../connection/WalletLinkConnection';
import { WalletLinkConnectionCipher } from '../connection/WalletLinkConnectionCipher';
import { WalletLinkWebSocket } from '../connection/WalletLinkWebSocket';
import { ScopedLocalStorage } from '../lib/ScopedLocalStorage';
import { WalletLinkRelay, WalletLinkRelayOptions } from './WalletLinkRelay';
import { WALLET_USER_NAME_KEY } from './WalletSDKRelayAbstract';
import { WalletSDKRelayEventManager } from './WalletSDKRelayEventManager';

const decryptMock = jest.fn().mockImplementation((text) => Promise.resolve(`"decrypted ${text}"`));

jest.spyOn(WalletLinkConnectionCipher.prototype, 'decrypt').mockImplementation(decryptMock);

describe('WalletLinkRelay', () => {
  const options: WalletLinkRelayOptions = {
    linkAPIUrl: 'http://link-api-url',
    version: '0.0.0',
    darkMode: false,
    storage: new ScopedLocalStorage('test'),
    relayEventManager: new WalletSDKRelayEventManager(),
    uiConstructor: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(WalletLinkWebSocket.prototype, 'connect').mockReturnValue(Promise.resolve());
  });

  describe('resetAndReload', () => {
    it('should destroy the connection and connect again', async () => {
      const setSessionMetadataSpy = jest.spyOn(
        WalletLinkConnection.prototype,
        'setSessionMetadata'
      );

      const relay = new WalletLinkRelay(options);
      relay.resetAndReload();

      expect(setSessionMetadataSpy).toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('should call handleIncomingEvent', async () => {
      const serverMessageEvent: ServerMessage = {
        type: 'Event',
        sessionId: 'sessionId',
        eventId: 'eventId',
        event: 'Web3Response',
        data: 'data',
      };

      jest.spyOn(JSON, 'parse').mockImplementation(() => {
        return {
          type: 'WEB3_RESPONSE',
          data: 'decrypted data',
        };
      });

      const relay = new WalletLinkRelay(options);
      const connection: WalletLinkConnection = (relay as any).connection;

      const handleWeb3ResponseMessageSpy = jest.spyOn(relay, 'handleWeb3ResponseMessage');

      connection.websocketServerMessageReceived(serverMessageEvent);

      expect(handleWeb3ResponseMessageSpy).toHaveBeenCalledWith(
        JSON.parse(await decryptMock(serverMessageEvent.data))
      );
    });

    it('should set isLinked with LinkedListener', async () => {
      const relay = new WalletLinkRelay(options);
      const connection: WalletLinkConnection = (relay as any).connection;
      expect(relay.isLinked).toBeFalsy();

      connection.websocketLinkedUpdated(true);

      expect(relay.isLinked).toEqual(true);
    });
  });

  describe('setSessionConfigListener', () => {
    it('should update metadata with setSessionConfigListener', async () => {
      const metadata = {
        WalletUsername: 'username',
      };

      const relay = new WalletLinkRelay(options);
      const connection: WalletLinkConnection = (relay as any).connection;

      const metadataUpdatedSpy = jest.spyOn(relay, 'metadataUpdated');

      connection.websocketSessionMetadataUpdated(metadata);

      expect(metadataUpdatedSpy).toHaveBeenCalledWith(
        WALLET_USER_NAME_KEY,
        await decryptMock(metadata.WalletUsername)
      );
    });

    it('should update chainId and jsonRpcUrl only when distinct', async () => {
      const callback = jest.fn();
      const relay = new WalletLinkRelay(options);
      const connection: WalletLinkConnection = (relay as any).connection;
      relay.setChainCallback(callback);

      const metadata = {
        ChainId: 'ChainId',
        JsonRpcUrl: 'JsonRpcUrl',
      };

      // initial chain id and json rpc url
      connection.websocketSessionMetadataUpdated(metadata);
      expect(callback).toHaveBeenCalledWith(
        await decryptMock(metadata.ChainId),
        await decryptMock(metadata.JsonRpcUrl)
      );

      // same chain id and json rpc url
      connection.websocketSessionMetadataUpdated(metadata);
      expect(callback).toHaveBeenCalledTimes(1); // distinctUntilChanged

      // different chain id and json rpc url
      const newMetadata = {
        ChainId: 'ChainId2',
        JsonRpcUrl: 'JsonRpcUrl2',
      };
      connection.websocketSessionMetadataUpdated(newMetadata);

      expect(callback).toHaveBeenCalledWith(
        await decryptMock(newMetadata.ChainId),
        await decryptMock(newMetadata.JsonRpcUrl)
      );
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });
});

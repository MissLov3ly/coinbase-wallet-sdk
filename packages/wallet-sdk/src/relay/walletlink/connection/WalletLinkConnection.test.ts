import { Cipher } from '../../../lib/Cipher';
import { ScopedLocalStorage } from '../../../lib/ScopedLocalStorage';
import { APP_VERSION_KEY, WALLET_USER_NAME_KEY } from '../../RelayAbstract';
import { Session } from '../../Session';
import { SessionConfig } from '../type/SessionConfig';
import { WalletLinkConnection, WalletLinkConnectionUpdateListener } from './WalletLinkConnection';

const decryptMock = jest.fn().mockImplementation((text) => Promise.resolve(`decrypted ${text}`));

jest.spyOn(Cipher.prototype, 'decrypt').mockImplementation(decryptMock);

describe('WalletLinkConnection', () => {
  const session = new Session(new ScopedLocalStorage('test'));

  let connection: WalletLinkConnection;
  let listener: WalletLinkConnectionUpdateListener;

  beforeEach(() => {
    jest.clearAllMocks();

    listener = {
      linkedUpdated: jest.fn(),
      connectedUpdated: jest.fn(),
      handleWeb3ResponseMessage: jest.fn(),
      chainUpdated: jest.fn(),
      accountUpdated: jest.fn(),
      metadataUpdated: jest.fn(),
      resetAndReload: jest.fn(),
    };

    connection = new WalletLinkConnection({
      session,
      linkAPIUrl: 'http://link-api-url',
      listener,
    });
  });

  describe('handleSessionMetadataUpdated', () => {
    function invoke_handleSessionMetadataUpdated(metadata: SessionConfig['metadata']) {
      connection.websocketSessionMetadataUpdated(metadata);
    }

    it('should call listner.metadataUpdated when WalletUsername updated', async () => {
      const listener_metadataUpdatedSpy = jest.spyOn(listener, 'metadataUpdated');

      const newUsername = 'new username';

      invoke_handleSessionMetadataUpdated({ WalletUsername: newUsername });

      expect(listener_metadataUpdatedSpy).toHaveBeenCalledWith(
        WALLET_USER_NAME_KEY,
        await decryptMock(newUsername)
      );
    });

    it('should call listner.metadataUpdated when AppVersion updated', async () => {
      const listener_metadataUpdatedSpy = jest.spyOn(listener, 'metadataUpdated');

      const newAppVersion = 'new app version';

      invoke_handleSessionMetadataUpdated({ AppVersion: newAppVersion });

      expect(listener_metadataUpdatedSpy).toHaveBeenCalledWith(
        APP_VERSION_KEY,
        await decryptMock(newAppVersion)
      );
    });

    it('should call listner.resetAndReload when __destroyed: 1 is received', async () => {
      const listener_resetAndReloadSpy = jest.spyOn(listener, 'resetAndReload');

      invoke_handleSessionMetadataUpdated({ __destroyed: '1' });

      expect(listener_resetAndReloadSpy).toHaveBeenCalled();
    });

    it('should call listner.accountUpdated when Account updated', async () => {
      const listener_accountUpdatedSpy = jest.spyOn(listener, 'accountUpdated');

      const newAccount = 'new account';

      invoke_handleSessionMetadataUpdated({ EthereumAddress: newAccount });

      expect(listener_accountUpdatedSpy).toHaveBeenCalledWith(await decryptMock(newAccount));
    });

    describe('chain updates', () => {
      it('should NOT call listner.chainUpdated when only one changed', async () => {
        const listener_chainUpdatedSpy = jest.spyOn(listener, 'chainUpdated');

        const chainIdUpdate = { ChainId: 'new chain id' };
        const jsonRpcUrlUpdate = { JsonRpcUrl: 'new json rpc url' };

        invoke_handleSessionMetadataUpdated(chainIdUpdate);
        invoke_handleSessionMetadataUpdated(jsonRpcUrlUpdate);

        await decryptMock(chainIdUpdate.ChainId);

        expect(listener_chainUpdatedSpy).not.toHaveBeenCalled();
      });

      it('should call listner.chainUpdated when both ChainId and JsonRpcUrl changed', async () => {
        const listener_chainUpdatedSpy = jest.spyOn(listener, 'chainUpdated');

        const update = {
          ChainId: 'new chain id',
          JsonRpcUrl: 'new json rpc url',
        };

        invoke_handleSessionMetadataUpdated(update);

        expect(listener_chainUpdatedSpy).toHaveBeenCalledWith(
          await decryptMock(update.ChainId),
          await decryptMock(update.JsonRpcUrl)
        );
      });
    });
  });
});

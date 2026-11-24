// KeyStore on tizen.keymanager (verified on the TV, probe 2: saveData / getData / removeData).
// Data is saved without a per-item password (null), as in the probe: the key manager's own
// per-application access control protects it. Values are never logged or returned in errors.
import type { KeyStore } from './platform.ts';
import { checkAlias } from './common.ts';

function errName(e: unknown): string {
  return e && typeof e === 'object' && (e as { name?: string }).name ? (e as { name: string }).name : 'Error';
}

export function createTizenKeyStore(km: TizenKeyManager): KeyStore {
  function removeQuiet(alias: string): void {
    try { km.removeData({ name: alias }); } catch (e) { /* absent: fine */ }
  }
  return {
    persistent: true,
    save: function (alias, value) {
      try { checkAlias(alias); } catch (e) { return Promise.reject(e); }
      if (typeof value !== 'string') {
        return Promise.reject(new Error('secret must be a string'));
      }
      return new Promise<void>(function (resolve, reject) {
        // The key manager does not overwrite an existing alias, so remove it first.
        removeQuiet(alias);
        try {
          km.saveData(alias, value, null, function () { resolve(); }, function (e) {
            reject(new Error('keymanager save failed (' + errName(e) + ')'));
          });
        } catch (e) {
          reject(new Error('keymanager save failed (' + errName(e) + ')'));
        }
      });
    },
    load: function (alias) {
      try { checkAlias(alias); } catch (e) { return Promise.reject(e); }
      try {
        const v = km.getData({ name: alias }, null);
        return Promise.resolve(typeof v === 'string' ? v : null);
      } catch (e) {
        if (errName(e) === 'NotFoundError') {
          return Promise.resolve(null);
        }
        return Promise.reject(new Error('keymanager load failed (' + errName(e) + ')'));
      }
    },
    remove: function (alias) {
      try { checkAlias(alias); } catch (e) { return Promise.reject(e); }
      try {
        km.removeData({ name: alias });
      } catch (e) {
        if (errName(e) !== 'NotFoundError') {
          return Promise.reject(new Error('keymanager remove failed (' + errName(e) + ')'));
        }
      }
      return Promise.resolve();
    }
  };
}

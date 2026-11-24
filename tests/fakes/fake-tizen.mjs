// Simulations of the Tizen 3.0 filesystem and key-manager APIs, following the documented
// behaviour (and what probe 2 observed): async callbacks, NotFoundError on missing items,
// createFile refusing to overwrite, key manager refusing to overwrite an alias.
// These are simulations: passing tests against them is NOT evidence of TV behaviour.

function tizenError(name, message = name) {
  return { name, message };
}
const later = (fn) => setImmediate(fn);

export function createFakeTizenFs(options = {}) {
  const files = new Map(); // fullPath -> text
  const root = '/opt/usr/apps/SShelfDev1/res/wgt-private-fake';
  let moveCalls = 0;

  function fileObj(name) {
    const fullPath = root + '/' + name;
    return {
      name,
      fullPath,
      isFile: true,
      isDirectory: false,
      openStream(mode, ok, err) {
        later(() => {
          if (mode === 'w') {
            let buf = '';
            ok({
              eof: false,
              write(t) { buf += t; },
              read() { throw tizenError('IOError'); },
              close() { files.set(fullPath, buf); }
            });
          } else if (mode === 'r') {
            if (!files.has(fullPath)) { err && err(tizenError('NotFoundError')); return; }
            const text = files.get(fullPath);
            let pos = 0;
            const s = {
              eof: text.length === 0,
              read(n) { const part = text.substring(pos, pos + n); pos += part.length; s.eof = pos >= text.length; return part; },
              write() { throw tizenError('IOError'); },
              close() {}
            };
            ok(s);
          } else {
            err && err(tizenError('InvalidValuesError'));
          }
        });
      }
    };
  }

  const dir = {
    name: 'wgt-private',
    fullPath: root,
    isFile: false,
    isDirectory: true,
    resolve(name) {
      if (!files.has(root + '/' + name)) throw tizenError('NotFoundError');
      return fileObj(name);
    },
    createFile(name) {
      if (files.has(root + '/' + name)) throw tizenError('IOError', 'file exists');
      files.set(root + '/' + name, '');
      return fileObj(name);
    },
    deleteFile(path, ok, err) {
      later(() => {
        if (!files.has(path)) { err && err(tizenError('NotFoundError')); return; }
        files.delete(path);
        ok && ok();
      });
    },
    moveTo(from, to, overwrite, ok, err) {
      moveCalls++;
      if (options.moveToThrows) throw tizenError('NotSupportedError');
      later(() => {
        if (options.moveToFails) { err && err(tizenError('IOError')); return; }
        if (!files.has(from)) { err && err(tizenError('NotFoundError')); return; }
        if (files.has(to) && !overwrite) { err && err(tizenError('IOError', 'exists')); return; }
        files.set(to, files.get(from));
        files.delete(from);
        ok && ok();
      });
    },
    listFiles(ok) {
      later(() => ok([...files.keys()].map((p) => ({ name: p.substring(root.length + 1), fullPath: p, isFile: true }))));
    }
  };

  return {
    api: {
      resolve(location, ok, err, mode) {
        later(() => {
          if (location !== 'wgt-private' || mode !== 'rw') { err && err(tizenError('InvalidValuesError')); return; }
          ok(dir);
        });
      }
    },
    files,
    root,
    moveCalls: () => moveCalls
  };
}

export function createFakeKeyManager() {
  const data = new Map();
  return {
    data,
    api: {
      saveData(alias, raw, password, ok, err) {
        later(() => {
          if (data.has(alias)) { err && err(tizenError('InvalidValuesError', 'alias exists')); return; }
          data.set(alias, raw);
          ok && ok();
        });
      },
      getData(alias) {
        if (!data.has(alias.name)) throw tizenError('NotFoundError');
        return data.get(alias.name);
      },
      removeData(alias) {
        if (!data.has(alias.name)) throw tizenError('NotFoundError');
        data.delete(alias.name);
      }
    }
  };
}

import { ConnectionError } from './ssh.mjs';

const SERVICE = 'io.github.yulianjie.dsh.remote-ssh';
const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
const ERROR_NOT_FOUND = 1168;
const ERR_SEC_DUPLICATE_ITEM = -25299;
const ERR_SEC_ITEM_NOT_FOUND = -25300;
const CF_STRING_ENCODING_UTF8 = 0x08000100;

function operationFailed() {
  return new ConnectionError('SSH_PASSWORD_STORE_FAILED', 'The system credential store could not complete the SSH password request. Check the credential store and try again.');
}

function windowsCredentialStore(koffi) {
  const advapi = koffi.load('advapi32.dll');
  const kernel = koffi.load('kernel32.dll');
  const fileTime = koffi.struct({ low: 'uint32', high: 'uint32' });
  const credential = koffi.struct({
    flags: 'uint32', type: 'uint32', targetName: 'str16', comment: 'void *', lastWritten: fileTime,
    blobSize: 'uint32', blob: 'void *', persist: 'uint32', attributeCount: 'uint32',
    attributes: 'void *', targetAlias: 'void *', userName: 'void *',
  });
  const read = advapi.func('__stdcall', 'CredReadW', 'int', ['str16', 'uint32', 'uint32', koffi.out(koffi.pointer(credential, 2))]);
  const write = advapi.func('__stdcall', 'CredWriteW', 'int', [koffi.pointer(credential), 'uint32']);
  const remove = advapi.func('int __stdcall CredDeleteW(str16 target, uint32 type, uint32 flags)');
  const free = advapi.func('void __stdcall CredFree(void *buffer)');
  const lastError = kernel.func('uint32 __stdcall GetLastError()');
  const target = key => `${SERVICE}/ssh/${key}`;

  return {
    get(key) {
      const result = [null];
      if (!read(target(key), CRED_TYPE_GENERIC, 0, result)) {
        if (lastError() === ERROR_NOT_FOUND) return undefined;
        throw operationFailed();
      }
      try {
        const { blob, blobSize } = koffi.decode(result[0], credential);
        return blobSize === 0 ? '' : koffi.decode.string(blob, blobSize);
      } finally {
        free(result[0]);
      }
    },
    set(key, value) {
      const bytes = Buffer.from(value, 'utf8');
      try {
        if (!write({ flags: 0, type: CRED_TYPE_GENERIC, targetName: target(key), comment: null,
          lastWritten: { low: 0, high: 0 }, blobSize: bytes.length, blob: bytes, persist: CRED_PERSIST_LOCAL_MACHINE,
          attributeCount: 0, attributes: null, targetAlias: null, userName: null }, 0)) throw operationFailed();
      } finally {
        bytes.fill(0);
      }
    },
    delete(key) {
      if (!remove(target(key), CRED_TYPE_GENERIC, 0) && lastError() !== ERROR_NOT_FOUND) throw operationFailed();
    },
  };
}

function macCredentialStore(koffi) {
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const security = koffi.load('/System/Library/Frameworks/Security.framework/Security');
  const dictionary = cf.func('void *CFDictionaryCreateMutable(void *allocator, long capacity, void *keyCallbacks, void *valueCallbacks)');
  const setValue = cf.func('void CFDictionarySetValue(void *dictionary, void *key, void *value)');
  const string = cf.func('void *CFStringCreateWithCString(void *allocator, str value, uint32 encoding)');
  const data = cf.func('void *CFDataCreate(void *allocator, uint8 *bytes, long length)');
  const dataLength = cf.func('long CFDataGetLength(void *data)');
  const dataBytes = cf.func('void *CFDataGetBytePtr(void *data)');
  const release = cf.func('void CFRelease(void *object)');
  const read = security.func('int32 SecItemCopyMatching(void *query, _Out_ void **result)');
  const add = security.func('int32 SecItemAdd(void *attributes, void *result)');
  const update = security.func('int32 SecItemUpdate(void *query, void *attributes)');
  const remove = security.func('int32 SecItemDelete(void *query)');
  const constant = name => koffi.decode(security.symbol(name), 'void *');
  const keyCallbacks = cf.symbol('kCFTypeDictionaryKeyCallBacks');
  const valueCallbacks = cf.symbol('kCFTypeDictionaryValueCallBacks');
  const itemClass = constant('kSecClass');
  const genericPassword = constant('kSecClassGenericPassword');
  const serviceKey = constant('kSecAttrService');
  const accountKey = constant('kSecAttrAccount');
  const returnData = constant('kSecReturnData');
  const valueData = constant('kSecValueData');
  const cfTrue = koffi.decode(cf.symbol('kCFBooleanTrue'), 'void *');

  async function withDictionary(action) {
    const values = dictionary(null, 0, keyCallbacks, valueCallbacks);
    if (!values) throw operationFailed();
    const put = (key, value) => {
      if (!value) throw operationFailed();
      setValue(values, key, value);
    };
    try {
      return await action(values, put);
    } finally {
      release(values);
    }
  }

  function withItem(key, action) {
    return withDictionary(async (query, put) => {
      put(itemClass, genericPassword);
      for (const [attribute, value] of [[serviceKey, SERVICE], [accountKey, key]]) {
        const ref = string(null, value, CF_STRING_ENCODING_UTF8);
        if (!ref) throw operationFailed();
        try { put(attribute, ref); } finally { release(ref); }
      }
      return action(query, put);
    });
  }

  return {
    get(key) {
      return withItem(key, async (query, put) => {
        put(returnData, cfTrue);
        const result = [null];
        const status = await read.async(query, result);
        if (status === ERR_SEC_ITEM_NOT_FOUND) return undefined;
        if (status !== 0 || !result[0]) throw operationFailed();
        try {
          const length = dataLength(result[0]);
          return length === 0 ? '' : koffi.decode.string(dataBytes(result[0]), length);
        } finally {
          release(result[0]);
        }
      });
    },
    async set(key, value) {
      const bytes = Buffer.from(value, 'utf8');
      let secret;
      try { secret = data(null, bytes, bytes.length); } finally { bytes.fill(0); }
      if (!secret) throw operationFailed();
      try {
        const status = await withItem(key, (attributes, put) => {
          put(valueData, secret);
          return add.async(attributes, null);
        });
        if (status === 0) return;
        if (status !== ERR_SEC_DUPLICATE_ITEM) throw operationFailed();
        await withItem(key, query => withDictionary(async (attributes, put) => {
          put(valueData, secret);
          if (await update.async(query, attributes) !== 0) throw operationFailed();
        }));
      } finally {
        release(secret);
      }
    },
    delete(key) {
      return withItem(key, async query => {
        const status = await remove.async(query);
        if (status !== 0 && status !== ERR_SEC_ITEM_NOT_FOUND) throw operationFailed();
      });
    },
  };
}

/**
 * Provide the local desktop user's credential store. Passwords stay in the local host process and native vault.
 * @param {(() => Promise<typeof import('koffi')['default']>) | undefined} loadBindings Load Koffi from the desktop host's installed dependencies.
 * @returns {object | undefined} Async get, set and delete operations on opaque credential keys, or undefined on unsupported hosts.
 */
export function createCredentialStore(loadBindings) {
  if (!loadBindings || (process.platform !== 'win32' && process.platform !== 'darwin')) return undefined;
  let backend;
  async function run(operation) {
    backend ??= Promise.resolve().then(loadBindings).then(process.platform === 'win32' ? windowsCredentialStore : macCredentialStore)
      .catch(() => {
        backend = undefined;
        throw new ConnectionError('SSH_PASSWORD_STORE_UNAVAILABLE', 'The system credential store is unavailable.');
      });
    const store = await backend;
    try {
      return await operation(store);
    } catch (error) {
      // Native binding diagnostics can contain argument values.
      if (error instanceof ConnectionError) throw error;
      throw operationFailed();
    }
  }
  return {
    get: key => run(store => store.get(key)),
    set: (key, value) => run(store => store.set(key, value)),
    delete: key => run(store => store.delete(key)),
  };
}

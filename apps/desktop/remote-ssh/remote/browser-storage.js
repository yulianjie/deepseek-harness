// DSH 0.2.1-rc.5 persists the draft and session view together. Keep that
// record in this page's memory. The separate transcript width is a UI preference.
(() => {
  'use strict';

  let storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    return; // The browser already denies access to local storage.
  }
  if (!storage || !globalThis.Storage) return;

  const prototype = Storage.prototype;
  const properties = ['getItem', 'setItem', 'removeItem', 'clear', 'key', 'length'];
  const descriptors = Object.getOwnPropertyDescriptors(prototype);
  const native = {
    getItem: descriptors.getItem.value,
    setItem: descriptors.setItem.value,
    removeItem: descriptors.removeItem.value,
    clear: descriptors.clear.value,
    key: descriptors.key.value,
    length: descriptors.length.get,
  };
  const marker = Symbol.for('dsh.remote-ssh.draft-storage');
  if (native.getItem[marker]) return;

  const privateKey = key => key === 'dsh.conversation' ||
    (key.startsWith('dsh.conversation.') && key !== 'dsh.conversation.contentWidth');
  const drafts = new Map();
  const methods = {
    getItem(key) {
      if (this !== storage || arguments.length < 1) return native.getItem.apply(this, arguments);
      const name = `${key}`;
      return privateKey(name) ? drafts.get(name) ?? null : native.getItem.call(storage, name);
    },
    setItem(key, value) {
      if (this !== storage || arguments.length < 2) return native.setItem.apply(this, arguments);
      const name = `${key}`;
      if (privateKey(name)) drafts.set(name, `${value}`);
      else native.setItem.call(storage, name, value);
    },
    removeItem(key) {
      if (this !== storage || arguments.length < 1) return native.removeItem.apply(this, arguments);
      const name = `${key}`;
      if (privateKey(name)) drafts.delete(name);
      else native.removeItem.call(storage, name);
    },
    clear() {
      native.clear.call(this);
      if (this === storage) drafts.clear();
    },
    key(index) {
      if (this !== storage || arguments.length < 1) return native.key.apply(this, arguments);
      let offset = +index >>> 0;
      const persisted = native.length.call(storage);
      if (offset < persisted) return native.key.call(storage, offset);
      offset -= persisted;
      for (const key of drafts.keys()) {
        if (offset-- === 0) return key;
      }
      return null;
    },
  };
  Object.defineProperty(methods.getItem, marker, { value: true });

  const installed = [];
  try {
    for (const name of properties) {
      const descriptor = name === 'length'
        ? {
            ...descriptors.length,
            get() {
              const size = native.length.call(this);
              return this === storage ? size + drafts.size : size;
            },
          }
        : { ...descriptors[name], value: methods[name] };
      Object.defineProperty(prototype, name, descriptor);
      installed.push(name);
    }
  } catch (error) {
    for (const name of installed.reverse()) Object.defineProperty(prototype, name, descriptors[name]);
    throw error;
  }

  // Snapshot keys before deleting any because native key indices can change.
  const count = native.length.call(storage);
  for (let index = 0; index < count; index++) {
    const name = native.key.call(storage, index);
    if (name === null || !privateKey(name)) continue;
    const value = native.getItem.call(storage, name);
    if (value !== null) drafts.set(name, value);
  }
  for (const name of drafts.keys()) native.removeItem.call(storage, name);
})();

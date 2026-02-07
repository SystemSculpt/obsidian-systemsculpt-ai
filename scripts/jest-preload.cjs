"use strict";

// Preloaded in Jest processes (via NODE_OPTIONS) to avoid Node's experimental
// webstorage warning in Node 25+ when `localStorage` is accessed without a
// configured `--localstorage-file` path.
//
// Jest's NodeEnvironment teardown uses Reflect.get on various globals which can
// touch `localStorage` and emit noisy warnings that hide real test failures.

function createMemoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(index) {
      const keys = Array.from(store.keys());
      return keys[index] ?? null;
    },
    getItem(key) {
      return store.get(String(key)) ?? null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
}

function defineStorage(name) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: createMemoryStorage(),
    });
  } catch (_) {
    // Ignore: in some environments `globalThis` may be locked down.
  }
}

defineStorage("localStorage");
defineStorage("sessionStorage");


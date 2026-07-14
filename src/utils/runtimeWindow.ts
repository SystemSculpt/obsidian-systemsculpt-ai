export function getRuntimeWindow(): Window {
  return window.activeWindow ?? window;
}

export function getRuntimeCrypto(): Crypto | undefined {
  return getRuntimeWindow().crypto;
}

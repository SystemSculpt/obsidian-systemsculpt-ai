/** Cache busting for the license-validation redirect path in Electron. */
export const CACHE_BUSTER = {
  shouldApply: (endpoint: string): boolean => endpoint.includes("/license/validate"),
  generate: (): string => `_t=${Date.now()}`,
  apply: (url: string): string => {
    if (!CACHE_BUSTER.shouldApply(url)) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}${CACHE_BUSTER.generate()}`;
  },
};

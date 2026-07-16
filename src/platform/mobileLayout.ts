import { Platform } from "obsidian";

type MobilePlatform = typeof Platform & {
  isMobile?: boolean;
  isMobileApp?: boolean;
};

export type MobileLayoutOwner = Document | Element | Window | null | undefined;

export function resolveMobileLayoutDocument(owner?: MobileLayoutOwner): Document | null {
  if (owner) {
    if ((owner as Document).nodeType === 9) {
      return owner as Document;
    }
    const ownerDocument = (owner as Element).ownerDocument;
    if (ownerDocument) {
      return ownerDocument;
    }
    const windowDocument = (owner as Window).document;
    if (windowDocument) {
      return windowDocument;
    }
  }

  return typeof document !== "undefined" ? document : null;
}

/**
 * True when Obsidian is using its mobile host or its official mobile layout
 * emulator. The body-class fallback keeps desktop mobile QA behaviorally
 * faithful instead of limiting emulation to CSS alone.
 */
export function isMobileLayout(owner?: MobileLayoutOwner): boolean {
  const platform = Platform as MobilePlatform;
  if (platform.isMobile || platform.isMobileApp || platform.isDesktopApp === false) {
    return true;
  }

  return resolveMobileLayoutDocument(owner)?.body.classList.contains("is-mobile") ?? false;
}

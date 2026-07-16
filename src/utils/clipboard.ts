import type { App, TFile } from "obsidian";
import { resolveElectronModule } from "../platform/hostCapabilities";

function imageMimeTypeFromExtension(extension: string): string | null {
  const ext = String(extension || "").trim().toLowerCase();
  if (!ext) return null;
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "tiff" || ext === "tif") return "image/tiff";
  if (ext === "svg") return "image/svg+xml";
  return null;
}

type ElectronImageLike = {
  isEmpty?: () => boolean;
};

type ElectronLike = {
  clipboard?: {
    writeImage?: (image: ElectronImageLike) => void;
  };
  nativeImage?: {
    createFromDataURL?: (dataUrl: string) => ElectronImageLike;
  };
};

function resolveClipboardWindow(host?: Node): Window | undefined {
  return host?.ownerDocument?.defaultView
    ?? (typeof window !== "undefined" ? window.activeDocument?.defaultView : undefined)
    ?? (typeof window !== "undefined" ? window : undefined);
}

function resolveElectron(hostWindow?: Window): ElectronLike | null {
  const electron = resolveElectronModule<ElectronLike>(hostWindow);
  return electron?.clipboard?.writeImage && electron?.nativeImage?.createFromDataURL
    ? electron
    : null;
}

function toBase64(bytes: ArrayBuffer, hostWindow?: Window): string | null {
  const uint8 = new Uint8Array(bytes);
  const encodeBase64 = hostWindow?.btoa?.bind(hostWindow)
    ?? (typeof btoa === "function" ? btoa : undefined);
  if (!encodeBase64) {
    return null;
  }

  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < uint8.length; i += chunkSize) {
    const chunk = uint8.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  try {
    return encodeBase64(binary);
  } catch {
    return null;
  }
}

async function tryWebClipboardImageWrite(
  bytes: ArrayBuffer,
  mime: string,
  hostWindow?: Window,
): Promise<boolean> {
  const ownerNavigator = hostWindow?.navigator
    ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (!ownerNavigator?.clipboard?.write) {
    return false;
  }
  const ClipboardItemCtor = (hostWindow as any)?.ClipboardItem
    ?? (typeof ClipboardItem !== "undefined" ? ClipboardItem : undefined);
  if (!ClipboardItemCtor) {
    return false;
  }

  try {
    const BlobCtor = (hostWindow as any)?.Blob ?? Blob;
    const blob = new BlobCtor([bytes], { type: mime });
    const item = new ClipboardItemCtor({ [mime]: blob });
    await ownerNavigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}

function tryElectronClipboardImageWrite(
  bytes: ArrayBuffer,
  mime: string,
  hostWindow?: Window,
): boolean {
  const electron = resolveElectron(hostWindow);
  if (!electron) {
    return false;
  }

  const base64 = toBase64(bytes, hostWindow);
  if (!base64) {
    return false;
  }

  try {
    const dataUrl = `data:${mime};base64,${base64}`;
    const image = electron.nativeImage!.createFromDataURL!(dataUrl);
    if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
      return false;
    }
    electron.clipboard!.writeImage!(image);
    return true;
  } catch {
    return false;
  }
}

export async function tryCopyToClipboard(text: string, host?: Node): Promise<boolean> {
  const ownerDocument = host?.ownerDocument
    ?? (typeof window !== "undefined" ? window.activeDocument : undefined)
    ?? (typeof document !== "undefined" ? document : undefined);
  const ownerNavigator = ownerDocument?.defaultView?.navigator
    ?? (typeof navigator !== "undefined" ? navigator : undefined);

  if (ownerNavigator?.clipboard?.writeText) {
    try {
      await ownerNavigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback to DOM-based copy below
    }
  }

  if (ownerDocument?.body) {
    const textarea = ownerDocument.body.createEl("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.setCssStyles({ position: "fixed" });
    textarea.setCssStyles({ opacity: "0" });
    textarea.select();
    try {
      const result = ownerDocument.execCommand("copy");
      textarea.remove();
      return result;
    } catch {
      textarea.remove();
    }
  }

  return false;
}

export async function tryCopyImageFileToClipboard(
  app: App,
  file: TFile,
  host?: Node,
): Promise<boolean> {
  const mime = imageMimeTypeFromExtension(file.extension);
  if (!mime) {
    return false;
  }

  try {
    const bytes = await app.vault.readBinary(file);
    const hostWindow = resolveClipboardWindow(host);
    if (await tryWebClipboardImageWrite(bytes, mime, hostWindow)) {
      return true;
    }
    return tryElectronClipboardImageWrite(bytes, mime, hostWindow);
  } catch {
    return false;
  }
}

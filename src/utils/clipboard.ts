import type { App, TFile } from "obsidian";

function imageMimeTypeFromExtension(extension: string): string | null {
  const ext = String(extension || "").trim().toLowerCase();
  if (!ext) return null;
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
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

function resolveElectron(): ElectronLike | null {
  const candidates = [
    (globalThis as any)?.require,
    (globalThis as any)?.window?.require,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "function") continue;
    try {
      const electron = candidate("electron") as ElectronLike;
      if (electron?.clipboard?.writeImage && electron?.nativeImage?.createFromDataURL) {
        return electron;
      }
    } catch {
      // ignore and continue
    }
  }

  return null;
}

function toBase64(bytes: ArrayBuffer): string | null {
  const uint8 = new Uint8Array(bytes);
  const BufferCtor = (globalThis as any)?.Buffer;
  if (BufferCtor && typeof BufferCtor.from === "function") {
    try {
      return BufferCtor.from(uint8).toString("base64");
    } catch {
      // continue with browser fallback
    }
  }

  if (typeof btoa !== "function") {
    return null;
  }

  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < uint8.length; i += chunkSize) {
    const chunk = uint8.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  try {
    return btoa(binary);
  } catch {
    return null;
  }
}

async function tryWebClipboardImageWrite(bytes: ArrayBuffer, mime: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.write) {
    return false;
  }
  if (typeof ClipboardItem === "undefined") {
    return false;
  }

  try {
    const blob = new Blob([bytes], { type: mime });
    const item = new ClipboardItem({ [mime]: blob });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}

function tryElectronClipboardImageWrite(bytes: ArrayBuffer, mime: string): boolean {
  const electron = resolveElectron();
  if (!electron) {
    return false;
  }

  const base64 = toBase64(bytes);
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

export async function tryCopyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback to DOM-based copy below
    }
  }

  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      const result = document.execCommand("copy");
      document.body.removeChild(textarea);
      return result;
    } catch {
      document.body.removeChild(textarea);
    }
  }

  return false;
}

export async function tryCopyImageFileToClipboard(app: App, file: TFile): Promise<boolean> {
  const mime = imageMimeTypeFromExtension(file.extension);
  if (!mime) {
    return false;
  }

  try {
    const bytes = await app.vault.readBinary(file);
    if (await tryWebClipboardImageWrite(bytes, mime)) {
      return true;
    }
    return tryElectronClipboardImageWrite(bytes, mime);
  } catch {
    return false;
  }
}

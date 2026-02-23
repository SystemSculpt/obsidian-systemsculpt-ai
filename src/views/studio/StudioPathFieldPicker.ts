import type { StudioNodeConfigFieldDefinition } from "../../studio/types";

function sanitizePath(path: string): string {
  return String(path || "").trim();
}

function parentDirectory(path: string): string {
  const cleaned = String(path || "").replace(/[\\/]+$/g, "");
  const slashIndex = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  if (slashIndex < 0) {
    return "";
  }
  if (slashIndex === 0) {
    return cleaned[0] === "/" ? "/" : "";
  }
  return cleaned.slice(0, slashIndex);
}

function resolvePickedFilePath(file: File | null, fallbackValue?: string): string {
  if (!file) {
    const fallback = String(fallbackValue || "").trim();
    return fallback.replace(/\\/g, "/").includes("/fakepath/") ? "" : fallback;
  }
  const candidate = (file as unknown as { path?: unknown }).path;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return sanitizePath(candidate);
  }
  const fallback = String(fallbackValue || "").trim();
  if (!fallback || fallback.replace(/\\/g, "/").includes("/fakepath/")) {
    return "";
  }
  return fallback;
}

function resolvePickedDirectoryPath(file: File | null, fallbackValue?: string): string {
  const filePath = resolvePickedFilePath(file, fallbackValue);
  if (!filePath) {
    return "";
  }

  const webkitRelativePath =
    typeof (file as unknown as { webkitRelativePath?: unknown })?.webkitRelativePath === "string"
      ? String((file as unknown as { webkitRelativePath?: string }).webkitRelativePath)
      : "";
  if (!webkitRelativePath) {
    return parentDirectory(filePath);
  }

  const relativeParts = webkitRelativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0);
  if (relativeParts.length === 0) {
    return parentDirectory(filePath);
  }

  let result = filePath;
  for (let i = 0; i < relativeParts.length; i += 1) {
    result = parentDirectory(result);
  }
  return result || parentDirectory(filePath);
}

function resolveElectronDialogRuntime():
  | {
      dialog: {
        showOpenDialog?: (...args: unknown[]) => Promise<{
          canceled?: unknown;
          filePaths?: unknown;
        }>;
        showOpenDialogSync?: (...args: unknown[]) => unknown;
      };
      BrowserWindow?: {
        getFocusedWindow?: () => unknown;
      };
    }
  | null {
  const candidates = [
    (globalThis as unknown as { require?: unknown })?.require,
    (globalThis as unknown as { window?: { require?: unknown } })?.window?.require,
  ];

  for (const runtimeRequire of candidates) {
    if (typeof runtimeRequire !== "function") {
      continue;
    }
    try {
      const electron = runtimeRequire("electron") as {
        dialog?: unknown;
        BrowserWindow?: unknown;
        remote?: { dialog?: unknown; BrowserWindow?: unknown };
      };
      const dialog =
        (electron?.dialog as {
          showOpenDialog?: (...args: unknown[]) => Promise<{
            canceled?: unknown;
            filePaths?: unknown;
          }>;
          showOpenDialogSync?: (...args: unknown[]) => unknown;
        }) ||
        (electron?.remote?.dialog as {
          showOpenDialog?: (...args: unknown[]) => Promise<{
            canceled?: unknown;
            filePaths?: unknown;
          }>;
          showOpenDialogSync?: (...args: unknown[]) => unknown;
        });
      const BrowserWindow =
        (electron?.BrowserWindow as { getFocusedWindow?: () => unknown }) ||
        (electron?.remote?.BrowserWindow as { getFocusedWindow?: () => unknown });
      if (dialog && (typeof dialog.showOpenDialog === "function" || typeof dialog.showOpenDialogSync === "function")) {
        return {
          dialog,
          BrowserWindow,
        };
      }
    } catch {
      // Continue through fallbacks.
    }
  }

  return null;
}

function buildMediaDialogExtensions(field: StudioNodeConfigFieldDefinition): string[] {
  const extensions = new Set<string>();
  const kinds = Array.isArray(field.mediaKinds) ? field.mediaKinds : [];

  for (const kind of kinds) {
    if (kind === "image") {
      ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"].forEach((value) => extensions.add(value));
    } else if (kind === "video") {
      ["mp4", "mov", "mkv", "webm", "avi", "m4v"].forEach((value) => extensions.add(value));
    } else if (kind === "audio") {
      ["wav", "mp3", "m4a", "ogg", "flac", "aac"].forEach((value) => extensions.add(value));
    }
  }

  if (extensions.size === 0 && typeof field.accept === "string") {
    for (const chunk of field.accept.split(",")) {
      const cleaned = chunk.trim().replace(/^[.]+/, "").toLowerCase();
      if (!cleaned || cleaned.endsWith("/*")) {
        continue;
      }
      if (/^[a-z0-9]+$/.test(cleaned)) {
        extensions.add(cleaned);
      }
    }
  }

  return Array.from(extensions);
}

async function browseForFieldPathViaElectronDialog(
  field: StudioNodeConfigFieldDefinition
): Promise<string | null> {
  const runtime = resolveElectronDialogRuntime();
  if (!runtime) {
    return null;
  }

  const properties = [
    field.type === "directory_path" ? "openDirectory" : "openFile",
    "dontAddToRecent",
  ];
  const options: {
    properties: string[];
    filters?: Array<{ name: string; extensions: string[] }>;
  } = {
    properties,
  };
  if (field.type === "media_path") {
    const mediaExtensions = buildMediaDialogExtensions(field);
    if (mediaExtensions.length > 0) {
      options.filters = [
        {
          name: "Media",
          extensions: mediaExtensions,
        },
      ];
    }
  }

  const focusedWindow =
    typeof runtime.BrowserWindow?.getFocusedWindow === "function"
      ? runtime.BrowserWindow.getFocusedWindow()
      : undefined;

  try {
    if (typeof runtime.dialog.showOpenDialogSync === "function") {
      const value = focusedWindow
        ? runtime.dialog.showOpenDialogSync(focusedWindow, options)
        : runtime.dialog.showOpenDialogSync(options);
      const paths = Array.isArray(value) ? value.map((entry) => String(entry || "").trim()) : [];
      return paths[0] || null;
    }

    if (typeof runtime.dialog.showOpenDialog === "function") {
      const result = focusedWindow
        ? await runtime.dialog.showOpenDialog(focusedWindow, options)
        : await runtime.dialog.showOpenDialog(options);
      if (result?.canceled === true) {
        return null;
      }
      const paths = Array.isArray(result?.filePaths)
        ? result.filePaths.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [];
      return paths[0] || null;
    }
  } catch {
    return null;
  }

  return null;
}

export async function browseForNodeConfigPath(
  field: StudioNodeConfigFieldDefinition
): Promise<string | null> {
  const viaElectronDialog = await browseForFieldPathViaElectronDialog(field);
  if (viaElectronDialog) {
    return viaElectronDialog;
  }

  return await new Promise<string | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "-9999px";

    if (field.type === "directory_path") {
      (input as unknown as { webkitdirectory?: boolean }).webkitdirectory = true;
      (input as unknown as { directory?: boolean }).directory = true;
    }

    if (field.type === "media_path") {
      const kinds = Array.isArray(field.mediaKinds) ? field.mediaKinds : [];
      const accepts: string[] = kinds
        .map((kind) => {
          if (kind === "image") return "image/*";
          if (kind === "video") return "video/*";
          if (kind === "audio") return "audio/*";
          return "";
        })
        .filter((value) => value.length > 0);
      if (field.accept) {
        accepts.push(field.accept);
      }
      if (accepts.length > 0) {
        input.accept = accepts.join(",");
      }
    } else if (field.accept) {
      input.accept = field.accept;
    }

    let settled = false;
    let sawWindowBlur = false;
    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("blur", onWindowBlur, true);
      window.removeEventListener("focus", onWindowFocus, true);
      input.removeEventListener("change", onChange);
      if (input.parentElement) {
        input.parentElement.removeChild(input);
      }
      resolve(value && value.trim().length > 0 ? value : null);
    };

    const onWindowBlur = (): void => {
      sawWindowBlur = true;
    };

    const onChange = (): void => {
      const files = Array.from(input.files || []);
      if (files.length === 0) {
        finish(null);
        return;
      }
      const primary = files[0] || null;
      const path =
        field.type === "directory_path"
          ? resolvePickedDirectoryPath(primary, input.value)
          : resolvePickedFilePath(primary, input.value);
      finish(path || null);
    };

    const onWindowFocus = (): void => {
      if (!sawWindowBlur) {
        return;
      }
      window.setTimeout(() => {
        if (!settled) {
          const files = Array.from(input.files || []);
          if (files.length === 0) {
            finish(null);
          }
        }
      }, 0);
    };

    input.addEventListener("change", onChange);
    window.addEventListener("blur", onWindowBlur, true);
    window.addEventListener("focus", onWindowFocus, true);
    document.body.appendChild(input);
    input.click();
  });
}

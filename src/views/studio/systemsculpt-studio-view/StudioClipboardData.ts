export function normalizePastedImageMimeType(rawMimeType: string): string {
  const normalized = String(rawMimeType || "").trim().toLowerCase();
  if (normalized.startsWith("image/")) {
    return normalized;
  }
  return "image/png";
}

export function extractClipboardImageFiles(event: ClipboardEvent): File[] {
  const clipboard = event.clipboardData;
  if (!clipboard) {
    return [];
  }

  const files: File[] = [];
  const seenKeys = new Set<string>();
  if (clipboard.items && clipboard.items.length > 0) {
    for (const item of Array.from(clipboard.items)) {
      if (!item || item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (!file || !String(file.type || "").toLowerCase().startsWith("image/")) {
        continue;
      }
      const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      files.push(file);
    }
  }

  if (files.length > 0) {
    return files;
  }

  if (clipboard.files && clipboard.files.length > 0) {
    for (const file of Array.from(clipboard.files)) {
      if (!file || !String(file.type || "").toLowerCase().startsWith("image/")) {
        continue;
      }
      const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      files.push(file);
    }
  }

  return files;
}

export function extractClipboardText(event: ClipboardEvent): string {
  const clipboard = event.clipboardData;
  if (!clipboard) {
    return "";
  }
  const text = clipboard.getData("text/plain");
  return typeof text === "string" ? text : "";
}

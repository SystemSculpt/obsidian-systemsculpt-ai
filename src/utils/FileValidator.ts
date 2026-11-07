// Maximum file size for uploads (500 MiB)
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

/**
 * Formats file size in a human-readable format
 * @param bytes File size in bytes
 * @returns Formatted file size string
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes + " bytes";
  } else if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KiB";
  } else {
    return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  }
}

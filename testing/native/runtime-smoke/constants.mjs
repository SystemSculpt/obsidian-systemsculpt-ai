export const DEFAULT_DESKTOP_PORT = 9222;
export const DEFAULT_ANDROID_FORWARD_PORT = 9333;
export const DEFAULT_IOS_ADAPTER_PORT = 9000;
export const DEFAULT_IOS_ADAPTER_HOST = "127.0.0.1";
export const DEFAULT_TARGET_HINT = "Obsidian";
export const DEFAULT_FIXTURE_DIR = "SystemSculpt/QA/NativeRuntimeFixtures/current";
export const DEFAULT_ANDROID_SERIAL = "emulator-5554";
export const DEFAULT_ANDROID_PACKAGE = "md.obsidian";
export const DEFAULT_REPEAT = 1;
export const DEFAULT_PAUSE_MS = 1000;
export const DEFAULT_WEB_FETCH_URL = "https://www.rfc-editor.org/rfc/rfc9110.txt";
export const DEFAULT_YOUTUBE_URL = "https://www.youtube.com/watch?v=nDLb8_wgX50";

export const CORE_CASES = [
  "chat-exact",
  "file-read",
  "file-write",
  "embeddings",
  "transcribe",
  "record-transcribe",
  "web-fetch",
];

export const EXTENDED_CASES = [...CORE_CASES, "youtube-transcript"];

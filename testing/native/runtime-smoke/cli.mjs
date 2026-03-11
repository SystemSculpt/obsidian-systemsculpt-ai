import process from "node:process";
import {
  DEFAULT_ANDROID_FORWARD_PORT,
  DEFAULT_ANDROID_PACKAGE,
  DEFAULT_ANDROID_SERIAL,
  DEFAULT_DESKTOP_PORT,
  DEFAULT_FIXTURE_DIR,
  DEFAULT_IOS_ADAPTER_HOST,
  DEFAULT_IOS_ADAPTER_PORT,
  DEFAULT_PAUSE_MS,
  DEFAULT_REPEAT,
  DEFAULT_TARGET_HINT,
  DEFAULT_WEB_FETCH_URL,
  DEFAULT_YOUTUBE_URL,
} from "./constants.mjs";

export function usage() {
  console.log(`Usage: node testing/native/runtime-smoke/run.mjs [options]

Run the live hosted SystemSculpt runtime smoke matrix through an inspectable
Obsidian runtime. This is the canonical native test lane for real desktop,
Android WebView, and iOS adapter sessions against real vaults.

Options:
  --mode <desktop|android|ios|json> Transport mode. Default: desktop
  --case <name|all|extended>      Smoke case: chat-exact, file-read, file-write, embeddings, transcribe, record-transcribe, web-fetch, youtube-transcript, all, or extended. Default: all
  --desktop-port <n>              Desktop DevTools port. Default: 9222
  --android-serial <id>           adb serial for Android mode. Default: emulator-5554
  --android-package <id>          Android package id. Default: md.obsidian
  --android-forward-port <n>      Local forward port for Android WebView. Default: 9333
  --ios-adapter-host <host>       iOS WebKit adapter host. Default: 127.0.0.1
  --ios-adapter-port <n>          iOS WebKit adapter port. Default: 9000
  --no-start-ios-adapter          Do not auto-start remotedebug_ios_webkit_adapter in iOS mode
  --json-url <url>                Explicit /json or /json/list target endpoint for json mode
  --target-hint <text>            Prefer targets whose title/url includes this hint. Default: Obsidian
  --fixture-dir <path>            Vault-relative fixture directory. Default: SystemSculpt/QA/CrossDevice/20260311-194643
  --repeat <n>                    Repeat the selected case list this many times. Default: 1
  --pause-ms <n>                  Delay between iterations. Default: 1000
  --transcribe-audio-path <path>  Vault-relative audio file for direct transcription smoke. Default: <fixture-dir>/audio-phrases.m4a
  --record-audio-path <path>      Vault-relative audio file to feed into the real recorder smoke. Default: <fixture-dir>/audio-phrases.m4a
  --web-fetch-url <url>           URL for the web-fetch hosted service smoke. Default: https://www.wikipedia.org/
  --youtube-url <url>             URL for the YouTube transcript hosted service smoke. Default: https://www.youtube.com/watch?v=nDLb8_wgX50
  --json-output <path>            Write the final JSON report to this path as well as stdout
  --help, -h                      Show this help.
`);
}

export function fail(message) {
  console.error(`[runtime-smoke] ${message}`);
  process.exit(1);
}

export function parseArgs(argv) {
  const options = {
    mode: "desktop",
    caseName: "all",
    desktopPort: DEFAULT_DESKTOP_PORT,
    androidSerial: DEFAULT_ANDROID_SERIAL,
    androidPackage: DEFAULT_ANDROID_PACKAGE,
    androidForwardPort: DEFAULT_ANDROID_FORWARD_PORT,
    iosAdapterHost: DEFAULT_IOS_ADAPTER_HOST,
    iosAdapterPort: DEFAULT_IOS_ADAPTER_PORT,
    startIosAdapter: true,
    jsonUrl: "",
    targetHint: DEFAULT_TARGET_HINT,
    fixtureDir: DEFAULT_FIXTURE_DIR,
    repeat: DEFAULT_REPEAT,
    pauseMs: DEFAULT_PAUSE_MS,
    transcribeAudioPath: "",
    recordAudioPath: "",
    webFetchUrl: DEFAULT_WEB_FETCH_URL,
    youtubeUrl: DEFAULT_YOUTUBE_URL,
    jsonOutput: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      options.mode = String(argv[index + 1] || "").trim() || options.mode;
      index += 1;
      continue;
    }
    if (arg === "--case") {
      options.caseName = String(argv[index + 1] || "").trim() || options.caseName;
      index += 1;
      continue;
    }
    if (arg === "--desktop-port") {
      options.desktopPort = Number.parseInt(String(argv[index + 1] || ""), 10) || options.desktopPort;
      index += 1;
      continue;
    }
    if (arg === "--android-serial") {
      options.androidSerial = String(argv[index + 1] || "").trim() || options.androidSerial;
      index += 1;
      continue;
    }
    if (arg === "--android-package") {
      options.androidPackage = String(argv[index + 1] || "").trim() || options.androidPackage;
      index += 1;
      continue;
    }
    if (arg === "--android-forward-port") {
      options.androidForwardPort =
        Number.parseInt(String(argv[index + 1] || ""), 10) || options.androidForwardPort;
      index += 1;
      continue;
    }
    if (arg === "--json-url") {
      options.jsonUrl = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--ios-adapter-host") {
      options.iosAdapterHost = String(argv[index + 1] || "").trim() || options.iosAdapterHost;
      index += 1;
      continue;
    }
    if (arg === "--ios-adapter-port") {
      options.iosAdapterPort =
        Number.parseInt(String(argv[index + 1] || ""), 10) || options.iosAdapterPort;
      index += 1;
      continue;
    }
    if (arg === "--no-start-ios-adapter") {
      options.startIosAdapter = false;
      continue;
    }
    if (arg === "--target-hint") {
      options.targetHint = String(argv[index + 1] || "").trim() || options.targetHint;
      index += 1;
      continue;
    }
    if (arg === "--fixture-dir") {
      options.fixtureDir = String(argv[index + 1] || "").trim() || options.fixtureDir;
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      options.repeat = Math.max(1, Number.parseInt(String(argv[index + 1] || ""), 10) || options.repeat);
      index += 1;
      continue;
    }
    if (arg === "--pause-ms") {
      options.pauseMs = Math.max(0, Number.parseInt(String(argv[index + 1] || ""), 10) || options.pauseMs);
      index += 1;
      continue;
    }
    if (arg === "--transcribe-audio-path") {
      options.transcribeAudioPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--record-audio-path") {
      options.recordAudioPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--web-fetch-url") {
      options.webFetchUrl = String(argv[index + 1] || "").trim() || options.webFetchUrl;
      index += 1;
      continue;
    }
    if (arg === "--youtube-url") {
      options.youtubeUrl = String(argv[index + 1] || "").trim() || options.youtubeUrl;
      index += 1;
      continue;
    }
    if (arg === "--json-output") {
      options.jsonOutput = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

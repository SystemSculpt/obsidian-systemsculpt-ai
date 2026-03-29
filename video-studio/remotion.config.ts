import { Config } from "@remotion/cli/config";
import path from "node:path";
import webpack from "webpack";

Config.setOverwriteOutput(true);
Config.setVideoImageFormat("jpeg");
Config.setCodec("h264");
Config.setPixelFormat("yuv420p");

const browserOnlyModuleFallbacks: Record<string, false> = {
  fs: false,
  "node:fs": false,
  "fs/promises": false,
  "node:fs/promises": false,
  path: false,
  "node:path": false,
  os: false,
  "node:os": false,
  http: false,
  "node:http": false,
  https: false,
  "node:https": false,
  child_process: false,
  "node:child_process": false,
  worker_threads: false,
  "node:worker_threads": false,
  net: false,
  "node:net": false,
  tls: false,
  "node:tls": false,
  url: false,
  "node:url": false,
  readline: false,
  "node:readline": false,
  crypto: false,
  "node:crypto": false,
  constants: false,
  "node:constants": false,
  events: false,
  "node:events": false,
  module: false,
  "node:module": false,
  process: false,
  "node:process": false,
  stream: false,
  "node:stream": false,
  tty: false,
  "node:tty": false,
  v8: false,
  "node:v8": false,
  vm: false,
  "node:vm": false,
  zlib: false,
  "node:zlib": false,
  buffer: false,
  "node:buffer": false,
  assert: false,
  "node:assert": false,
  perf_hooks: false,
  "node:perf_hooks": false,
  util: false,
  "node:util": false,
};

Config.overrideWebpackConfig((currentConfiguration) => {
  const alias: Record<string, string | false | string[]> = Array.isArray(
    currentConfiguration.resolve?.alias
  )
    ? {}
    : ((currentConfiguration.resolve?.alias ?? {}) as Record<
        string,
        string | false | string[]
      >);
  const fallback: Record<string, string | false | string[]> = Array.isArray(
    currentConfiguration.resolve?.fallback
  )
    ? {}
    : ((currentConfiguration.resolve?.fallback ?? {}) as Record<
        string,
        string | false | string[]
      >);

  currentConfiguration.resolve = {
    ...currentConfiguration.resolve,
    alias: {
      ...alias,
      ...browserOnlyModuleFallbacks,
      obsidian: path.resolve(process.cwd(), "src/shims/obsidian.ts"),
      src: path.resolve(process.cwd(), "../src"),
      "gpt-tokenizer/esm/encoding": path.resolve(
        process.cwd(),
        "src/shims/gptTokenizerEncoding.ts"
      ),
      "@plugin-ui/createInputUI": path.resolve(
        process.cwd(),
        "../src/views/chatview/ui/createInputUI.ts"
      ),
      "@plugin-ui/ContextSelectionModal": path.resolve(
        process.cwd(),
        "../src/modals/ContextSelectionModal.ts"
      ),
      "@plugin-ui/InlineCollapsibleBlock": path.resolve(
        process.cwd(),
        "../src/views/chatview/renderers/InlineCollapsibleBlock.ts"
      ),
      "@plugin-ui/CitationFooter": path.resolve(
        process.cwd(),
        "../src/views/chatview/renderers/CitationFooter.ts"
      ),
      "@plugin-ui/ChatStatusSurface": path.resolve(
        process.cwd(),
        "../src/views/chatview/ui/ChatStatusSurface.ts"
      ),
      "@plugin-ui/ChatComposerIndicators": path.resolve(
        process.cwd(),
        "../src/views/chatview/ui/ChatComposerIndicators.ts"
      ),
      "@plugin-ui/ContextAttachmentPills": path.resolve(
        process.cwd(),
        "../src/views/chatview/ui/ContextAttachmentPills.ts"
      ),
      "@plugin-ui/MessageRenderer": path.resolve(
        process.cwd(),
        "../src/views/chatview/MessageRenderer.ts"
      ),
      "@plugin-ui/MessageGrouping": path.resolve(
        process.cwd(),
        "../src/views/chatview/utils/MessageGrouping.ts"
      ),
      "@plugin-ui/SystemSculptSearchModal": path.resolve(
        process.cwd(),
        "../src/modals/SystemSculptSearchModal.ts"
      ),
      "@plugin-ui/SystemSculptHistoryModal": path.resolve(
        process.cwd(),
        "../src/views/history/SystemSculptHistoryModal.ts"
      ),
      "@plugin-ui/CreditsBalanceModal": path.resolve(
        process.cwd(),
        "../src/modals/CreditsBalanceModal.ts"
      ),
      "@plugin-ui/EmbeddingsStatusModal": path.resolve(
        process.cwd(),
        "../src/modals/EmbeddingsStatusModal.ts"
      ),
      "@plugin-ui/BenchResultsView": path.resolve(
        process.cwd(),
        "src/shims/BenchResultsView.ts"
      ),
    },
    fallback: {
      ...fallback,
      ...browserOnlyModuleFallbacks,
    },
  };
  currentConfiguration.plugins = [
    ...(currentConfiguration.plugins ?? []),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
  ];
  return currentConfiguration;
});

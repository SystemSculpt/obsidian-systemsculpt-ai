import { Config } from "@remotion/cli/config";
import path from "node:path";

Config.setOverwriteOutput(true);
Config.setVideoImageFormat("jpeg");
Config.setCodec("h264");
Config.setPixelFormat("yuv420p");
Config.overrideWebpackConfig((currentConfiguration) => {
  const alias = Array.isArray(currentConfiguration.resolve?.alias)
    ? {}
    : currentConfiguration.resolve?.alias ?? {};

  currentConfiguration.resolve = {
    ...currentConfiguration.resolve,
    alias: {
      ...alias,
      obsidian: path.resolve(process.cwd(), "src/shims/obsidian.ts"),
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
      "@plugin-ui/MessageGrouping": path.resolve(
        process.cwd(),
        "../src/views/chatview/utils/MessageGrouping.ts"
      ),
    },
  };
  return currentConfiguration;
});

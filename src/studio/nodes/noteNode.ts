import { basename } from "node:path";
import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { getText } from "./shared";

function deriveNoteTitleFromPath(vaultPath: string): string {
  const fileName = basename(String(vaultPath || "").replace(/\\/g, "/")).trim();
  if (!fileName) {
    return "";
  }
  if (fileName.toLowerCase().endsWith(".md") && fileName.length > 3) {
    return fileName.slice(0, -3);
  }
  return fileName;
}

export const noteNode: StudioNodeDefinition = {
  kind: "studio.note",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "never",
  inputPorts: [],
  outputPorts: [
    { id: "text", type: "text" },
    { id: "path", type: "text" },
    { id: "title", type: "text" },
  ],
  configDefaults: {
    vaultPath: "",
    value: "",
    textDisplayMode: "rendered",
  },
  configSchema: {
    fields: [
      {
        key: "vaultPath",
        label: "Vault Path",
        type: "file_path",
        required: true,
        placeholder: "Path to a markdown note (for example, Inbox/Idea.md).",
        accept: ".md,text/markdown",
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const vaultPath = getText(context.node.config.vaultPath as StudioJsonValue).trim();
    if (!vaultPath) {
      throw new Error(`Note node "${context.node.id}" requires config.vaultPath.`);
    }
    if (!vaultPath.toLowerCase().endsWith(".md")) {
      throw new Error(
        `Note node "${context.node.id}" only supports markdown files. Received "${vaultPath}".`
      );
    }

    context.services.assertFilesystemPath(vaultPath);
    const text = await context.services.readVaultText(vaultPath);
    const title = deriveNoteTitleFromPath(vaultPath) || vaultPath;

    return {
      outputs: {
        text,
        path: vaultPath,
        title,
      },
    };
  },
};

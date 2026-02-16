import { expect } from "@wdio/globals";
import { ensurePluginEnabled } from "../utils/obsidian";
import { ensureE2EVault, PLUGIN_ID, upsertVaultFile } from "../utils/systemsculptChat";

const IMAGE_PATH = "E2E/copy-image-source.png";
const CANVAS_PATH = "E2E/copy-image-source.canvas";
const IMAGE_NODE_ID = "e2e-copy-image-node";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9slt4d8AAAAASUVORK5CYII=";

async function writeBinaryImage(path: string, base64: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, { filePath, base64 }) => {
      const normalized = String(filePath || "").replace(/\\/g, "/");
      if (!normalized) throw new Error("Missing image path");

      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const parts = normalized.split("/").filter(Boolean);
      const fileName = parts.pop();
      if (!fileName) throw new Error("Invalid image path");

      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const exists = await app.vault.adapter.exists(current);
        if (!exists) {
          await app.vault.createFolder(current);
        }
      }

      const existing = app.vault.getAbstractFileByPath(normalized);
      if (existing) {
        await app.vault.modifyBinary(existing as any, bytes.buffer);
      } else {
        await app.vault.createBinary(normalized, bytes.buffer);
      }
    },
    { filePath: path, base64 }
  );
}

async function enableCanvasEnhancements(): Promise<void> {
  await browser.executeObsidian(async ({ app }, { pluginId }) => {
    const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
    if (!plugin) throw new Error(`Plugin not loaded: ${pluginId}`);
    await plugin.getSettingsManager().updateSettings({ canvasFlowEnabled: true });
    if (typeof plugin.syncCanvasFlowEnhancerFromSettings === "function") {
      await plugin.syncCanvasFlowEnhancerFromSettings();
    }
  }, { pluginId: PLUGIN_ID });
}

async function waitForServices(): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(({ app }, { pluginId }) => {
        const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
        return Boolean(plugin?.fileContextMenuService);
      }, { pluginId: PLUGIN_ID }),
    { timeout: 30000, timeoutMsg: "fileContextMenuService did not initialize" }
  );

  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(({ app }, { pluginId }) => {
        const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
        return Boolean(plugin?.canvasFlowEnhancer);
      }, { pluginId: PLUGIN_ID }),
    { timeout: 30000, timeoutMsg: "canvasFlowEnhancer did not initialize" }
  );
}

describe("Canvas copy image fallback (mock)", () => {
  before(async () => {
    const vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);

    await writeBinaryImage(IMAGE_PATH, TINY_PNG_BASE64);
    await upsertVaultFile(
      CANVAS_PATH,
      JSON.stringify({
        nodes: [
          {
            id: IMAGE_NODE_ID,
            type: "file",
            file: IMAGE_PATH,
            x: 100,
            y: 100,
            width: 320,
            height: 240,
          },
        ],
        edges: [],
      })
    );
    await enableCanvasEnhancements();
    await waitForServices();
  });

  it("copies image from file context menu via electron fallback when web clipboard fails", async function () {
    this.timeout(60000);

    const result = await browser.executeObsidian(
      async ({ app }, { pluginId, imagePath }) => {
        const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
        const service: any = plugin?.fileContextMenuService;
        if (!service) throw new Error("fileContextMenuService unavailable");

        const imageFile = app.vault.getAbstractFileByPath(imagePath);
        if (!(imageFile as any)?.path) {
          throw new Error(`Image file not found: ${imagePath}`);
        }

        const menu: any = {
          items: [] as Array<{ title: string; onClick?: () => Promise<void> | void }>,
          addItem(cb: (item: any) => void) {
            const item: any = {
              title: "",
              setTitle(value: string) {
                item.title = value;
                return item;
              },
              setIcon() {
                return item;
              },
              setSection() {
                return item;
              },
              onClick(handler: () => Promise<void> | void) {
                item.onClickHandler = handler;
                return item;
              },
            };
            cb(item);
            menu.items.push({ title: item.title, onClick: item.onClickHandler });
            return menu;
          },
          addSeparator() {
            return menu;
          },
          setUseNativeMenu() {
            return menu;
          },
        };

        const originalClipboardItem = (globalThis as any).ClipboardItem;
        const originalWindowRequire = (window as any).require;
        const originalGlobalRequire = (globalThis as any).require;

        let writeImageCount = 0;
        let dataUrlPrefix = "";

        const mockRequire = (mod: string) => {
          if (mod !== "electron") {
            throw new Error(`Unexpected module request: ${mod}`);
          }
          return {
            clipboard: {
              writeImage: () => {
                writeImageCount += 1;
              },
            },
            nativeImage: {
              createFromDataURL: (dataUrl: string) => {
                dataUrlPrefix = String(dataUrl || "").slice(0, 24);
                return {
                  isEmpty: () => false,
                };
              },
            },
          };
        };

        try {
          (globalThis as any).ClipboardItem = undefined;
          (window as any).require = mockRequire;
          (globalThis as any).require = mockRequire;

          service.populateMenu(menu, imageFile, {
            source: "file-explorer",
            leafType: "file-explorer",
          });

          const entry = menu.items.find(
            (item: any) => item.title === "SystemSculpt - Copy Image to Clipboard"
          );
          if (!entry?.onClick) {
            return {
              foundEntry: false,
              writeImageCount,
              dataUrlPrefix,
            };
          }

          await entry.onClick();
          return {
            foundEntry: true,
            writeImageCount,
            dataUrlPrefix,
          };
        } finally {
          if (typeof originalClipboardItem === "undefined") {
            delete (globalThis as any).ClipboardItem;
          } else {
            (globalThis as any).ClipboardItem = originalClipboardItem;
          }
          if (typeof originalWindowRequire === "undefined") {
            delete (window as any).require;
          } else {
            (window as any).require = originalWindowRequire;
          }
          if (typeof originalGlobalRequire === "undefined") {
            delete (globalThis as any).require;
          } else {
            (globalThis as any).require = originalGlobalRequire;
          }
        }
      },
      { pluginId: PLUGIN_ID, imagePath: IMAGE_PATH }
    );

    expect(result.foundEntry).toBe(true);
    expect(result.writeImageCount).toBe(1);
    expect(String(result.dataUrlPrefix || "")).toContain("data:image/png;base64,");
  });

  it("copies image from canvas handler via electron fallback when web clipboard fails", async function () {
    this.timeout(60000);

    const result = await browser.executeObsidian(
      async ({ app }, { pluginId, canvasPath, imageNodeId }) => {
        const plugin: any = (app as any)?.plugins?.getPlugin?.(pluginId);
        const enhancer: any = plugin?.canvasFlowEnhancer;
        if (!enhancer) throw new Error("canvasFlowEnhancer unavailable");

        const originalClipboardItem = (globalThis as any).ClipboardItem;
        const originalWindowRequire = (window as any).require;
        const originalGlobalRequire = (globalThis as any).require;

        let writeImageCount = 0;

        const mockRequire = (mod: string) => {
          if (mod !== "electron") {
            throw new Error(`Unexpected module request: ${mod}`);
          }
          return {
            clipboard: {
              writeImage: () => {
                writeImageCount += 1;
              },
            },
            nativeImage: {
              createFromDataURL: (_dataUrl: string) => ({
                isEmpty: () => false,
              }),
            },
          };
        };

        try {
          (globalThis as any).ClipboardItem = undefined;
          (window as any).require = mockRequire;
          (globalThis as any).require = mockRequire;

          const btn = document.createElement("button");
          btn.dataset.ssCanvasflowCanvasPath = canvasPath;
          btn.dataset.ssCanvasflowImageNodeId = imageNodeId;
          await enhancer.handleCopySelectedImageToClipboard(btn);

          return {
            writeImageCount,
            finalLabel: btn.getAttribute("aria-label"),
          };
        } finally {
          if (typeof originalClipboardItem === "undefined") {
            delete (globalThis as any).ClipboardItem;
          } else {
            (globalThis as any).ClipboardItem = originalClipboardItem;
          }
          if (typeof originalWindowRequire === "undefined") {
            delete (window as any).require;
          } else {
            (window as any).require = originalWindowRequire;
          }
          if (typeof originalGlobalRequire === "undefined") {
            delete (globalThis as any).require;
          } else {
            (globalThis as any).require = originalGlobalRequire;
          }
        }
      },
      {
        pluginId: PLUGIN_ID,
        canvasPath: CANVAS_PATH,
        imageNodeId: IMAGE_NODE_ID,
      }
    );

    expect(result.writeImageCount).toBe(1);
    expect(result.finalLabel).toBe("SystemSculpt - Copy Image to Clipboard");
  });
});

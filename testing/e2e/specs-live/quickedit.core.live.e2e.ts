import { expect } from "@wdio/globals";
import crypto from "node:crypto";
import { ensurePluginEnabled, runCommand } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  openMarkdownFile,
  PLUGIN_ID,
  readVaultFile,
  requireEnv,
  upsertVaultFile,
} from "../utils/systemsculptChat";

describe("Quick Edit (live)", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;
  const nonce = crypto.randomUUID().slice(0, 8);
  const token = `QUICKEDIT_${nonce}`;
  const filePath = "E2E/quickedit.md";

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        mcpEnabled: true,
        mcpAutoAccept: false,
        toolingAutoApproveReadOnly: true,
        mcpAutoAcceptTools: ["mcp-filesystem_write", "mcp-filesystem_move"],
      },
    });

    await upsertVaultFile(filePath, "# Quick Edit Test\n\nOriginal line.\n");
  });

  it("applies Quick Edit tool proposal and updates file", async function () {
    this.timeout(180000);

    await openMarkdownFile(filePath);
    await runCommand("systemsculpt-ai:quick-file-edit");

    const widget = await $(".systemsculpt-quick-edit-widget");
    await widget.waitForExist({ timeout: 15000 });

    const input = await widget.$("textarea.quick-edit-input");
    await input.waitForExist({ timeout: 10000 });
    await input.setValue(`Append this exact line at the end of the file: ${token}`);

    const submit = await widget.$("button.quick-edit-submit-btn");
    await submit.waitForEnabled({ timeout: 10000 });
    await submit.click();

    await browser.waitUntil(
      async () => {
        const confirmRow = await widget.$(".quick-edit-confirm-row");
        return await confirmRow.isDisplayed();
      },
      {
        timeout: 150000,
        timeoutMsg: "Quick Edit did not reach confirmation state in time.",
      }
    );

    const applyButton = await widget.$("button.quick-edit-confirm-btn");
    await applyButton.waitForEnabled({ timeout: 10000 });
    await applyButton.click();

    await browser.waitUntil(
      async () => {
        const content = await readVaultFile(filePath);
        return content.includes(token);
      },
      {
        timeout: 120000,
        timeoutMsg: "Quick Edit changes were not applied to the file.",
      }
    );

    const finalContent = await readVaultFile(filePath);
    expect(finalContent).toContain(token);
  });
});

/** @jest-environment jsdom */

import { App } from "obsidian";
import { ChatModelSelectionController } from "../ChatModelSelectionController";

describe("ChatModelSelectionController fixed identity", () => {
  it("renders a neutral SystemSculpt identity without a fake selection affordance", () => {
    const container = document.createElement("div");
    const host = document.createElement("div");
    const controller = new ChatModelSelectionController({
      app: new App(),
      container,
      isAutomationRequestActive: () => false,
      openAccount: jest.fn(),
    });
    controller.ensureHost({ modelSlot: host });
    controller.render();
    expect(host.textContent).toContain("SystemSculpt");
    expect(host.textContent).toContain("ai-agent");
    expect(host.textContent).not.toMatch(/OpenAI|Anthropic|Provider|Favorites/);
    expect(host.querySelectorAll(".systemsculpt-chat-identity")).toHaveLength(1);
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("[aria-haspopup]")).toBeNull();
  });

  it("routes a real admission denial only to Account", async () => {
    const promptAccountSetup = jest.fn().mockResolvedValue(true);
    const controller = new ChatModelSelectionController({
      app: new App(),
      container: document.createElement("div"),
      isAutomationRequestActive: () => false,
      openAccount: jest.fn(),
      promptAccountSetup,
    });
    await expect(controller.invokeAccountSetupPrompt(
      "Activate your SystemSculpt license in Account before starting a chat.",
    )).resolves.toBeUndefined();
    expect(promptAccountSetup).toHaveBeenCalledWith(
      "Activate your SystemSculpt license in Account before starting a chat.",
    );
  });
});

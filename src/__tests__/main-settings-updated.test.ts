/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { SettingsManager } from "../core/settings/SettingsManager";

jest.mock("../core/settings/AutomaticBackupService", () => ({
  AutomaticBackupService: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

it("routes real settings updates only to the affected plugin services", async () => {
  const app = new App();
  const plugin = new SystemSculptPlugin(app, { id: "systemsculpt-ai", version: "6.14.0" } as any);
  plugin.loadData = jest.fn(async () => ({}));
  plugin.saveData = jest.fn(async () => undefined);
  const handlers = new Map<string, (...args: any[]) => void>();
  (app.workspace.on as jest.Mock).mockImplementation((event, handler) => {
    handlers.set(event, handler);
    return {};
  });
  (app.workspace.trigger as jest.Mock).mockImplementation((event, ...args) => handlers.get(event)?.(...args));
  const bootstrapTasks: { id: string; run: () => void }[] = [];
  (plugin as any).registerBootstrapTasks({ registerTask: (_phase: string, task: any) => bootstrapTasks.push(task) });
  bootstrapTasks.find(task => task.id === "workspace.events")!.run();
  const syncEmbeddings = jest.fn();
  (plugin as any).embeddingsManager = { syncFromSettings: syncEmbeddings };
  const syncLines = jest.spyOn(plugin as any, "syncRelativeLineNumbersExtension").mockImplementation(() => undefined);
  const syncDiagnostics = jest.spyOn(plugin as any, "syncDiagnosticsRecording").mockImplementation(() => undefined);
  const settings = new SettingsManager(plugin);
  await settings.loadSettings();
  syncEmbeddings.mockClear(); syncLines.mockClear(); syncDiagnostics.mockClear();

  await settings.updateSettings({ defaultChatTag: "notes" });
  await settings.updateSettings({ lastValidated: Date.now() });
  await settings.updateSettings({ lastAutomaticBackup: Date.now() });
  expect(syncEmbeddings).not.toHaveBeenCalled();
  expect(syncLines).not.toHaveBeenCalled();
  expect(syncDiagnostics).not.toHaveBeenCalled();

  await settings.updateSettings({ embeddingsEnabled: true });
  await settings.updateSettings({ embeddingsExclusions: { ...settings.settings.embeddingsExclusions, folders: ["Private"] } });
  expect(syncEmbeddings).toHaveBeenCalledTimes(2);
  expect(syncLines).not.toHaveBeenCalled();
  expect(syncDiagnostics).not.toHaveBeenCalled();
  await settings.updateSettings({ relativeLineNumbersEnabled: true });
  expect(syncLines).toHaveBeenCalledTimes(1);
  expect(syncEmbeddings).toHaveBeenCalledTimes(2);
  await settings.updateSettings({ showDiagnostics: true });
  expect(syncDiagnostics).toHaveBeenCalledTimes(1);
  syncLines.mockRestore(); syncDiagnostics.mockRestore();
  settings.destroy();
});

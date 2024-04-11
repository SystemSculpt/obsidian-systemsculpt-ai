import { UpdateModule } from '../UpdateModule';

export async function checkForUpdates(plugin: UpdateModule): Promise<void> {
  if (plugin.plugin.settings.version !== plugin.plugin.manifest.version) {
    plugin.plugin.settings.version = plugin.plugin.manifest.version;
    await plugin.plugin.saveSettings();
  }
}

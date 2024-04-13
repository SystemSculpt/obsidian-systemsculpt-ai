import SystemSculptPlugin from '../../main';
import { checkForUpdates } from './functions/checkForUpdates';
import { checkForUpdate } from './functions/checkForUpdate';
import { updatePlugin } from './functions/updatePlugin';

export class UpdateModule {
  plugin: SystemSculptPlugin;
  updateAvailable: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  async load() {
    this.checkForUpdate();
    setInterval(() => this.checkForUpdate(), 3 * 60 * 60 * 1000); // Check every 3 hours
  }

  async checkForUpdates(): Promise<void> {
    return checkForUpdates(this);
  }

  async checkForUpdate(): Promise<void> {
    return checkForUpdate(this);
  }

  async updatePlugin(): Promise<void> {
    await updatePlugin(this);

    // Hide the update status bar item and set updateAvailable to false
    if (this.plugin.updateStatusBarItem) {
      this.plugin.updateStatusBarItem.style.display = 'none';
    }
    this.updateAvailable = false;
  }
}

import SystemSculptPlugin from '../../main';
import { checkForUpdates } from './functions/checkForUpdates';
import { checkForUpdate } from './functions/checkForUpdate';

export class UpdateModule {
  plugin: SystemSculptPlugin;
  updateAvailable: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  async load() {
    setTimeout(() => this.checkForUpdates(), 3000);
    setTimeout(() => this.checkForUpdate(), 5000);
    setInterval(() => this.checkForUpdate(), 10800000); // Check every 3 hours
  }

  async checkForUpdates(): Promise<void> {
    return checkForUpdates(this);
  }

  async checkForUpdate(): Promise<void> {
    return checkForUpdate(this);
  }
}

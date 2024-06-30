import { Plugin } from 'obsidian';
import SystemSculptPlugin from '../main';

export function listAllSettings(plugin: Plugin): string[] {
  const allSettings: string[] = [];
  const systemSculptPlugin = plugin as SystemSculptPlugin;

  // Function to extract settings from a container element
  function extractSettings(containerEl: HTMLElement) {
    const settingEls = containerEl.querySelectorAll('.setting-item');
    settingEls.forEach(settingEl => {
      const nameEl = settingEl.querySelector('.setting-item-name');
      if (nameEl && nameEl.textContent) {
        allSettings.push(nameEl.textContent.trim());
      }
    });
  }

  // Extract settings from each module
  if (systemSculptPlugin.settingsTab) {
    systemSculptPlugin.settingsTab.display();
    const settingsContainer =
      systemSculptPlugin.settingsTab.containerEl.querySelector(
        '.settings-container'
      );
    if (settingsContainer) {
      // Brain settings
      allSettings.push('BRAIN:');
      systemSculptPlugin.brainModule.settingsDisplay(
        settingsContainer as HTMLElement
      );
      extractSettings(settingsContainer as HTMLElement);

      // Tasks settings
      allSettings.push('\nTASKS:');
      systemSculptPlugin.tasksModule.settingsDisplay(
        settingsContainer as HTMLElement
      );
      extractSettings(settingsContainer as HTMLElement);

      // Recorder settings
      allSettings.push('\nRECORDER:');
      systemSculptPlugin.recorderModule.settingsDisplay(
        settingsContainer as HTMLElement
      );
      extractSettings(settingsContainer as HTMLElement);

      // Templates settings
      allSettings.push('\nTEMPLATES:');
      systemSculptPlugin.templatesModule.settingsDisplay(
        settingsContainer as HTMLElement
      );
      extractSettings(settingsContainer as HTMLElement);

      // Chat settings
      allSettings.push('\nCHAT:');
      systemSculptPlugin.chatModule.settingsDisplay(
        settingsContainer as HTMLElement
      );
      extractSettings(settingsContainer as HTMLElement);
    }
  }

  // Remove duplicates and sort within each module
  const moduleSettings: { [key: string]: string[] } = {};
  let currentModule = '';
  allSettings.forEach(setting => {
    if (setting.endsWith(':')) {
      currentModule = setting.slice(0, -1);
      moduleSettings[currentModule] = [];
    } else {
      moduleSettings[currentModule].push(setting);
    }
  });

  // Sort settings within each module and reconstruct the list
  const sortedSettings: string[] = [];
  Object.keys(moduleSettings).forEach(module => {
    sortedSettings.push(`${module}:`);
    sortedSettings.push(...moduleSettings[module].sort());
    sortedSettings.push(''); // Add an empty line between modules
  });

  return sortedSettings;
}

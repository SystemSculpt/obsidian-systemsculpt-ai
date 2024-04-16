import { Plugin } from 'obsidian';
import { UpdateModule } from './UpdateModule';

export function setupUpdateStatusBar(
  plugin: Plugin,
  updateModule: UpdateModule
): HTMLElement {
  const updateStatusBarItem = plugin.addStatusBarItem();
  updateStatusBarItem.setText('Update SystemSculpt AI');
  updateStatusBarItem.addClass('update-button');
  updateStatusBarItem.addEventListener('click', async () => {
    if (!updateStatusBarItem.classList.contains('disabled')) {
      updateStatusBarItem.setText('Updating...');
      updateStatusBarItem.classList.add('disabled');
      await updateModule.updatePlugin();
      updateStatusBarItem.classList.remove('disabled'); // Optionally re-enable
    }
  });

  // Set the initial visibility of the update status bar item
  if (updateModule.updateAvailable) {
    updateStatusBarItem.style.display = 'inline-block';
  } else {
    updateStatusBarItem.style.display = 'none';
  }

  return updateStatusBarItem;
}

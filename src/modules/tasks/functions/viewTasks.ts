import { TasksModule } from '../TasksModule';
import { TFile } from 'obsidian';
import { logger } from '../../../utils/logger';

export async function viewTasks(plugin: TasksModule): Promise<void> {
  const { vault } = plugin.plugin.app;
  const { tasksLocation } = plugin.settings;

  const file = await vault.getAbstractFileByPath(tasksLocation);

  if (file && file instanceof TFile) {
    await plugin.plugin.app.workspace.getLeaf().openFile(file);
  } else {
    logger.error('Tasks file not found');
  }
}

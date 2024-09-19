import { TasksModule } from '../TasksModule';
import { TFile } from 'obsidian';
import { showCustomNotice } from '../../../modals';

export async function insertGeneratedTask(
  plugin: TasksModule,
  generatedTask: string
): Promise<void> {
  const { vault } = plugin.plugin.app;
  const { tasksLocation } = plugin.settings;

  try {
    const tasksDirectory = getDirectoryFromPath(tasksLocation);
    const tasksFilename = getFilenameFromPath(tasksLocation);

    const tasksFileWithExtension = ensureMdExtension(tasksFilename);

    const tasksLocationWithExtension = `${tasksDirectory}/${tasksFileWithExtension}`;

    const directoryExists = await vault.adapter.exists(tasksDirectory);
    if (!directoryExists) {
      await vault.createFolder(tasksDirectory);
    }

    let file = await vault.getAbstractFileByPath(tasksLocationWithExtension);
    if (!file) {
      file = await vault.create(tasksLocationWithExtension, '');
    }

    if (file instanceof TFile) {
      const fileContent = await vault.read(file);
      const shouldPrependNewline =
        fileContent !== '' &&
        (!fileContent.endsWith('\n') || !fileContent.endsWith('\n\n'));
      const newTaskContent =
        (shouldPrependNewline ? '\n\n' : '') + generatedTask;
      await vault.append(file, newTaskContent);
      showCustomNotice('Task added successfully!');
    } else {
      showCustomNotice(
        'Failed to add task. The specified file is not a valid TFile.'
      );
    }
  } catch (error) {
    showCustomNotice('Failed to add task. Please check the tasks location.');
  }
}

function getDirectoryFromPath(path: string): string {
  return path.substring(0, path.lastIndexOf('/'));
}

function getFilenameFromPath(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

function ensureMdExtension(filename: string): string {
  const extension = filename.substring(filename.lastIndexOf('.') + 1);
  if (extension.toLowerCase() !== 'md') {
    return `${filename}.md`;
  }
  return filename;
}

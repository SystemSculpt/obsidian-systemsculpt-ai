import { RecorderModule } from '../RecorderModule';
import { normalizePath, TFile } from 'obsidian';

export async function saveRecording(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<TFile | null> {
  const { vault } = plugin.plugin.app;
  const { recordingsPath } = plugin.settings;
  const date = new Date();
  const formattedDate = `${date.getFullYear()}-${String(
    date.getMonth() + 1
  ).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(
    date.getHours()
  ).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}`;
  const fileName = `recording-${formattedDate}.mp3`;
  const filePath = normalizePath(`${recordingsPath}/${fileName}`);

  const file = await vault.createBinary(filePath, arrayBuffer);

  if (!plugin.settings.saveAudioClips) {
    // Delete the temporary audio file if not saving audio clips
    const fileToDelete =
      plugin.plugin.app.vault.getAbstractFileByPath(filePath);
    if (fileToDelete) {
      await plugin.plugin.app.vault.delete(fileToDelete);
    }
    return null; // Return null since there's no file to return
  }

  return file; // Return the saved file
}

import { RecorderModule } from "../RecorderModule";
import { normalizePath, TFile } from "obsidian";

export async function saveRecording(
  plugin: RecorderModule,
  arrayBuffer: ArrayBuffer
): Promise<{ file: TFile; isTemporary: boolean }> {
  const { vault } = plugin.plugin.app;
  const { recordingsPath } = plugin.settings;

  // Ensure the recordings directory exists
  const normalizedRecordingsPath = normalizePath(recordingsPath);
  const directory = vault.getAbstractFileByPath(normalizedRecordingsPath);
  if (!directory) {
    await vault.createFolder(normalizedRecordingsPath);
  }

  const date = new Date();
  const formattedDate = `${date.getFullYear()}-${String(
    date.getMonth() + 1
  ).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(
    date.getHours()
  ).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}-${String(
    date.getSeconds()
  ).padStart(2, "0")}`;
  const fileName = `Recording ${formattedDate}.mp3`;
  const fileNameNoSpaces = fileName.replace(/ /g, "-");
  const filePath = normalizePath(`${recordingsPath}/${fileNameNoSpaces}`);

  const file = await vault.createBinary(filePath, arrayBuffer);

  return { file, isTemporary: !plugin.settings.saveAudioClips };
}

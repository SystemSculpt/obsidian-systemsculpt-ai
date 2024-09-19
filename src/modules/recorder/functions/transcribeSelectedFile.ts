import { RecorderModule } from '../RecorderModule';
import { TFile } from 'obsidian';

export async function transcribeSelectedFile(
  plugin: RecorderModule,
  file: TFile
): Promise<void> {
  if (file.extension !== 'mp3' && file.extension !== 'mp4') {
    return;
  }

  const arrayBuffer = await plugin.readFileAsArrayBuffer(file);
  await plugin.handleTranscription(arrayBuffer, file);
}
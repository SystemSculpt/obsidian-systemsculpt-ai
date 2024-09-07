import { RecorderModule } from '../RecorderModule';
import { TFile } from 'obsidian';
import { logger } from '../../../utils/logger';

export async function transcribeSelectedFile(
  plugin: RecorderModule,
  file: TFile
): Promise<void> {
  if (file.extension !== 'mp3' && file.extension !== 'mp4') {
    logger.error('Selected file is not an .mp3 or .mp4 file');
    return;
  }

  const arrayBuffer = await plugin.readFileAsArrayBuffer(file);
  await plugin.handleTranscription(arrayBuffer, file);
}
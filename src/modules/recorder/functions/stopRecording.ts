import { RecorderModule } from '../RecorderModule';
import { logger } from '../../../utils/logger';

export async function stopRecording(plugin: RecorderModule): Promise<void> {
  // if it's in status bar, hide it
  if (plugin.recordingStatusBarItem) {
    plugin.recordingStatusBarItem.hide();
  }

  if (plugin.recordingNotice) {
    logger.log('stopRecording called');
    const arrayBuffer = await plugin.recordingNotice
      .stopRecording()
      .catch(error => {
        logger.error('Error stopping recording:', error);
        plugin.handleError(error, 'Error stopping recording');
      });
    logger.log('Recording stopped');
    plugin.recordingNotice.hide();
    plugin.recordingNotice = null;

    if (arrayBuffer) {
      logger.log('ArrayBuffer received');
      const recordingFile = await plugin.saveRecording(arrayBuffer);
      if (recordingFile && plugin.settings.autoTranscriptionEnabled) {
        logger.log('Starting transcription');
        await plugin.handleTranscription(arrayBuffer, recordingFile);
      }
    }
  } else {
    logger.warn('No recording is in progress.');
  }
}

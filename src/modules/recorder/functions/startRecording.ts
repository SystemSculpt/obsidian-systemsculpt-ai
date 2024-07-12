import { RecorderModule } from '../RecorderModule';
import { RecordingNotice } from '../views/RecordingNotice';
import { logger } from '../../../utils/logger';

export async function startRecording(plugin: RecorderModule): Promise<void> {
  if (!plugin.recordingNotice) {
    plugin.recordingNotice = new RecordingNotice(plugin.plugin.app, plugin);
    plugin.recordingNotice.show().catch(error => {
      logger.error('Error starting recording:', error);
      plugin.handleError(error, 'Error starting recording');
      plugin.recordingNotice = null; // Ensure cleanup if failed to start
    });
    logger.log('Recording started');
  }
}

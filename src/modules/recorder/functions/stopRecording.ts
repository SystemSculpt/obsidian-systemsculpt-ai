import { RecorderModule } from '../RecorderModule';

export async function stopRecording(plugin: RecorderModule): Promise<void> {
  // if it's in status bar, hide it
  if (plugin.recordingStatusBarItem) {
    plugin.recordingStatusBarItem.hide();
  }

  if (plugin.recordingNotice) {
    console.log('stopRecording called');
    const arrayBuffer = await plugin.recordingNotice
      .stopRecording()
      .catch(error => {
        console.error('Error stopping recording:', error);
        plugin.handleError(error, 'Error stopping recording');
      });
    console.log('Recording stopped');
    plugin.recordingNotice.hide();
    plugin.recordingNotice = null;

    if (arrayBuffer) {
      console.log('ArrayBuffer received');
      const recordingFile = await plugin.saveRecording(arrayBuffer);
      if (recordingFile && plugin.settings.autoTranscriptionEnabled) {
        console.log('Starting transcription');
        await plugin.handleTranscription(arrayBuffer, recordingFile);
      }
    }
  } else {
    console.warn('No recording is in progress.');
  }
}

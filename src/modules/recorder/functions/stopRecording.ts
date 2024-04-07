import { RecorderModule } from '../RecorderModule';

export async function stopRecording(plugin: RecorderModule): Promise<void> {
  if (plugin.recordingNotice) {
    const arrayBuffer = await plugin.recordingNotice
      .stopRecording()
      .catch(error => {
        plugin.handleError(error, 'Error stopping recording');
      });
    plugin.recordingNotice.hide();
    plugin.recordingNotice = null;

    if (arrayBuffer) {
      const recordingFile = await plugin.saveRecording(arrayBuffer);
      if (recordingFile && plugin.settings.autoTranscriptionEnabled) {
        await plugin.handleTranscription(arrayBuffer, recordingFile);
      }
    }
  } else {
    console.warn('No recording is in progress.');
  }
}

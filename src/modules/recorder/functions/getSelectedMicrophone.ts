import { RecorderModule } from '../RecorderModule';
import { logger } from '../../../utils/logger';

export async function getSelectedMicrophone(
  plugin: RecorderModule
): Promise<MediaDeviceInfo | undefined> {
  const microphones = await plugin.getMicrophones();
  const selectedMic = microphones.find(
    microphone =>
      microphone.deviceId === plugin.settings.selectedMicrophone || 'default'
  );
  if (!selectedMic) {
    logger.warn('Selected microphone not found, using default');
    plugin.settings.selectedMicrophone = 'default';
    await plugin.saveSettings();
  }
  return selectedMic;
}

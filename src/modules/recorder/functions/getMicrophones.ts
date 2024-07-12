import { logger } from '../../../utils/logger';

export async function getMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'audioinput');
  } catch (error) {
    logger.error('Error getting microphones:', error);
    return [];
  }
}

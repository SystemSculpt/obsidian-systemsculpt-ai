/**
 * AudioResampler - Handles automatic resampling of audio files to required sample rates
 * This solves the issue where users have audio files with incompatible sample rates
 */
export class AudioResampler {
  private audioContext: AudioContext | null = null;

  constructor() {
    // AudioContext will be created when needed
  }

  /**
   * Resample audio buffer to target sample rate
   * @param arrayBuffer The original audio file as ArrayBuffer
   * @param targetSampleRate The desired sample rate (e.g., 16000, 48000)
   * @param mimeType The original MIME type
   * @returns Resampled audio as ArrayBuffer
   */
  async resampleAudio(
    arrayBuffer: ArrayBuffer,
    targetSampleRate: number,
    mimeType: string
  ): Promise<{ buffer: ArrayBuffer; actualSampleRate: number }> {
    // Create audio context with target sample rate
    if (!this.audioContext || this.audioContext.sampleRate !== targetSampleRate) {
      this.audioContext = new AudioContext({ sampleRate: targetSampleRate });
    }

    try {
      // Decode the original audio
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
      
      // If already at target sample rate, return original
      if (audioBuffer.sampleRate === targetSampleRate) {
        return { buffer: arrayBuffer, actualSampleRate: targetSampleRate };
      }


      // Create offline context for resampling
      const offlineContext = new OfflineAudioContext(
        audioBuffer.numberOfChannels,
        Math.floor(audioBuffer.duration * targetSampleRate),
        targetSampleRate
      );

      // Create buffer source
      const source = offlineContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineContext.destination);
      source.start(0);

      // Render the resampled audio
      const resampledBuffer = await offlineContext.startRendering();

      // Convert to WAV format for maximum compatibility
      const wavArrayBuffer = this.audioBufferToWav(resampledBuffer);
      
      
      return { 
        buffer: wavArrayBuffer, 
        actualSampleRate: resampledBuffer.sampleRate 
      };
    } catch (error) {
      throw new Error(`Failed to resample audio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Convert AudioBuffer to WAV format
   * Based on https://www.russellgood.com/how-to-convert-audiobuffer-to-audio-file/
   */
  private audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
    const length = buffer.length * buffer.numberOfChannels * 2 + 44;
    const arrayBuffer = new ArrayBuffer(length);
    const view = new DataView(arrayBuffer);
    const channels: Float32Array[] = [];
    let offset = 0;
    let pos = 0;

    // Write WAVE header
    const setUint16 = (data: number) => {
      view.setUint16(pos, data, true);
      pos += 2;
    };

    const setUint32 = (data: number) => {
      view.setUint32(pos, data, true);
      pos += 4;
    };

    // RIFF identifier
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    // fmt sub-chunk
    setUint32(0x20746d66); // "fmt "
    setUint32(16); // subchunk1 size
    setUint16(1); // audio format (1 = PCM)
    setUint16(buffer.numberOfChannels);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * buffer.numberOfChannels); // byte rate
    setUint16(buffer.numberOfChannels * 2); // block align
    setUint16(16); // bits per sample

    // data sub-chunk
    setUint32(0x61746164); // "data"
    setUint32(length - pos - 4); // subchunk2 size

    // Write interleaved data
    const volume = 0.8;
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      channels.push(buffer.getChannelData(i));
    }

    while (pos < length) {
      for (let i = 0; i < buffer.numberOfChannels; i++) {
        const sample = Math.max(-1, Math.min(1, channels[i][offset]));
        const val = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(pos, val * volume, true);
        pos += 2;
      }
      offset++;
    }

    return arrayBuffer;
  }

  /**
   * Check if audio needs resampling based on format and current sample rate
   */
  async checkNeedsResampling(
    arrayBuffer: ArrayBuffer,
    mimeType: string,
    targetSampleRate: number
  ): Promise<{ needsResampling: boolean; currentSampleRate?: number }> {
    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
      }

      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
      const needsResampling = audioBuffer.sampleRate !== targetSampleRate;

      return {
        needsResampling,
        currentSampleRate: audioBuffer.sampleRate
      };
    } catch (error) {
      // If we can't decode, assume it needs resampling
      return { needsResampling: true };
    }
  }

  /**
   * Clean up resources
   */
  dispose() {
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
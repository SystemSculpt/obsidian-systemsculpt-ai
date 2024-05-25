import { App } from 'obsidian';
import { RecorderModule } from '../RecorderModule';

export class RecordingNotice {
  app: App;
  plugin: RecorderModule;
  noticeEl: HTMLElement;
  private audioContext: AudioContext;
  private audioSource: MediaStreamAudioSourceNode;
  private analyser: AnalyserNode;
  private canvasContext: CanvasRenderingContext2D;
  private rafId: number;
  private mediaRecorder: MediaRecorder;

  constructor(app: App, plugin: RecorderModule) {
    this.app = app;
    this.plugin = plugin;
    this.noticeEl = this.createNoticeEl();
    console.log('RecordingNotice created');
  }

  private createNoticeEl(): HTMLElement {
    const noticeEl = document.createElement('div');
    noticeEl.addClass('recording-notice');

    const headerEl = noticeEl.createDiv('recording-notice-header');
    const closeButton = headerEl.createEl('button', { text: 'X' });
    closeButton.addEventListener('click', () => {
      this.plugin.toggleRecording();
      console.log('Recording stopped via close button');
    });

    headerEl.createEl('h3', { text: 'Recording audio...' });

    const canvasEl = noticeEl.createDiv('recording-notice-canvas');
    const canvas = canvasEl.createEl('canvas');
    canvas.width = 250;
    canvas.height = 50;
    this.canvasContext = canvas.getContext('2d') as CanvasRenderingContext2D;

    return noticeEl;
  }

  show(): Promise<void> {
    return new Promise((resolve, reject) => {
      let noticeContainer = document.body.querySelector('.notice-container');
      // If the notice container doesn't exist, create it and append it to the body
      if (!noticeContainer) {
        noticeContainer = document.createElement('div');
        noticeContainer.className = 'notice-container';
        document.body.appendChild(noticeContainer);
      }

      if (noticeContainer) {
        noticeContainer.appendChild(this.noticeEl);
        this.noticeEl.addClass('recording-notice-position');
        this.startRecording().then(resolve).catch(reject);
      } else {
        reject(new Error('Notice container not found'));
      }
    });
  }

  async startRecording(): Promise<void> {
    try {
      const selectedMicrophone = await this.plugin.getSelectedMicrophone();
      console.log('Selected microphone:', selectedMicrophone);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedMicrophone
            ? selectedMicrophone.deviceId
            : 'default',
        },
      });
      this.audioContext = new AudioContext();
      this.audioSource = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.audioSource.connect(this.analyser);

      this.mediaRecorder = new MediaRecorder(stream);
      this.mediaRecorder.start();
      console.log('MediaRecorder started');

      // Start visualizing the audio right after starting the recording
      this.visualize();
    } catch (error) {
      console.error('Error starting recording:', error);
      throw error; // Ensure the error is propagated so the calling function can handle it
    }
  }

  visualize(): void {
    if (!this.analyser) {
      console.error('Analyser not initialized');
      return;
    }
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      this.rafId = requestAnimationFrame(draw);

      this.analyser.getByteTimeDomainData(dataArray);

      this.canvasContext.clearRect(
        0,
        0,
        this.canvasContext.canvas.width,
        this.canvasContext.canvas.height
      );

      this.canvasContext.lineWidth = 2;
      this.canvasContext.strokeStyle = 'white';

      this.canvasContext.beginPath();

      const sliceWidth = (this.canvasContext.canvas.width * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = ((v * this.canvasContext.canvas.height) / 2) * 1.5;

        if (i === 0) {
          this.canvasContext.moveTo(x, this.canvasContext.canvas.height / 2);
        } else {
          this.canvasContext.lineTo(
            x,
            this.canvasContext.canvas.height / 1 - y
          );
        }

        x += sliceWidth;
      }

      this.canvasContext.lineTo(
        this.canvasContext.canvas.width,
        this.canvasContext.canvas.height / 2
      );
      this.canvasContext.stroke();
    };

    draw();
  }

  async stopRecording(): Promise<ArrayBuffer> {
    console.log('stopRecording called');
    cancelAnimationFrame(this.rafId);
    this.audioSource.disconnect();

    // Check if the audio context is still open before trying to close it
    if (this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }

    // Stop all tracks on the stream
    if (this.mediaRecorder.stream) {
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }

    return new Promise((resolve, reject) => {
      this.mediaRecorder.addEventListener(
        'dataavailable',
        async (event: BlobEvent) => {
          try {
            const arrayBuffer = await event.data.arrayBuffer();
            console.log('ArrayBuffer created');
            resolve(arrayBuffer);
          } catch (error) {
            reject(error);
          }
        }
      );
      this.mediaRecorder.stop();
      console.log('MediaRecorder stopped');
    });
  }

  hide(): void {
    if (this.noticeEl.parentNode) {
      this.noticeEl.parentNode.removeChild(this.noticeEl);
    }
  }
}

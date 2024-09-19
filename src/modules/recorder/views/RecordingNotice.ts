import { App } from 'obsidian';
import { RecorderModule } from '../RecorderModule';

export class RecordingNotice {
  app: App;
  plugin: RecorderModule;
  noticeEl: HTMLElement;
  private audioContext!: AudioContext;
  private audioSource!: MediaStreamAudioSourceNode;
  private analyser!: AnalyserNode;
  private canvasContext!: CanvasRenderingContext2D;
  private rafId!: number;
  private mediaRecorder!: MediaRecorder;

  constructor(app: App, plugin: RecorderModule) {
    this.app = app;
    this.plugin = plugin;
    this.noticeEl = this.createNoticeEl();
  }

  private createNoticeEl(): HTMLElement {
    const noticeEl = document.createElement('div');
    noticeEl.addClass('recording-notice');

    const headerEl = noticeEl.createDiv('recording-notice-header');
    const hideButton = headerEl.createEl('button', { text: '-' });
    const closeButton = headerEl.createEl('button', { text: 'X' });
    hideButton.addEventListener('click', () => {
      this.hideToStatusBar();
    });
    closeButton.addEventListener('click', () => {
      this.plugin.toggleRecording();
    });

    const titleEl = noticeEl.createEl('h3', { text: 'Recording audio...' });
    titleEl.addClass('recording-notice-title');

    const canvasEl = noticeEl.createDiv('recording-notice-canvas');
    const canvas = canvasEl.createEl('canvas');
    canvas.width = 250;
    canvas.height = 50;
    this.canvasContext = canvas.getContext('2d') as CanvasRenderingContext2D;

    return noticeEl;
  }

  private hideToStatusBar(): void {
    this.hide();
    this.plugin.showRecordingStatusBar();
  }

  showWithoutStartingRecording(): void {
    let noticeContainer = document.body.querySelector('.notice-container');
    if (!noticeContainer) {
      noticeContainer = document.createElement('div');
      noticeContainer.className = 'notice-container';
      document.body.appendChild(noticeContainer);
    }

    if (noticeContainer) {
      noticeContainer.appendChild(this.noticeEl);
      this.noticeEl.addClass('recording-notice-position');
    }
  }

  show(): Promise<void> {
    return new Promise((resolve, reject) => {
      let noticeContainer = document.body.querySelector('.notice-container');
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

      this.visualize();
    } catch (error) {
      throw error;
    }
  }

  visualize(): void {
    if (!this.analyser || !this.canvasContext) {
      return;
    }
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      this.rafId = requestAnimationFrame(draw);
      this.analyser.getByteTimeDomainData(dataArray);

      const { width, height } = this.canvasContext.canvas;
      this.canvasContext.clearRect(0, 0, width, height);

      this.canvasContext.beginPath();
      this.canvasContext.strokeStyle = getComputedStyle(
        document.documentElement
      ).getPropertyValue('--primary-color');
      this.canvasContext.lineWidth = 2;

      const sliceWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;

        if (i === 0) {
          this.canvasContext.moveTo(x, y);
        } else {
          this.canvasContext.lineTo(x, y);
        }

        x += sliceWidth;
      }

      this.canvasContext.lineTo(width, height / 2);
      this.canvasContext.stroke();
    };

    draw();
  }

  async stopRecording(): Promise<ArrayBuffer> {
    cancelAnimationFrame(this.rafId);
    this.audioSource.disconnect();

    if (this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }

    if (this.mediaRecorder.stream) {
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }

    return new Promise((resolve, reject) => {
      this.mediaRecorder.addEventListener(
        'dataavailable',
        async (event: BlobEvent) => {
          try {
            const arrayBuffer = await event.data.arrayBuffer();
            resolve(arrayBuffer);
          } catch (error) {
            reject(error);
          }
        }
      );
      this.mediaRecorder.stop();
    });
  }

  hide(): void {
    if (this.noticeEl.parentNode) {
      this.noticeEl.parentNode.removeChild(this.noticeEl);
    }
  }
}

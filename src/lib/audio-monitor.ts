export interface AudioMonitorInfo {
  sampleRate: number;
  channels: number;
  label: string;
}

export interface AudioMonitorState {
  active: boolean;
  starting: boolean;
  error?: string;
  info?: AudioMonitorInfo;
}

export interface AudioMetrics {
  rms: number;
  peak: number;
  db: number;
  peakDb: number;
}

class AudioMonitor {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sinkNode: GainNode | null = null;
  private frequency = new Uint8Array(1024);
  private waveform = new Uint8Array(2048);
  private timeDomain = new Float32Array(2048);
  private info: AudioMonitorInfo | null = null;
  private startingPromise: Promise<AudioMonitorInfo> | null = null;
  private state: AudioMonitorState = { active: false, starting: false };
  private listeners = new Set<(state: AudioMonitorState) => void>();

  get isActive(): boolean {
    return this.state.active;
  }

  get currentInfo(): AudioMonitorInfo | null {
    return this.info;
  }

  getState(): AudioMonitorState {
    return this.state;
  }

  onState(listener: (state: AudioMonitorState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(next: Partial<AudioMonitorState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  async start(): Promise<AudioMonitorInfo> {
    if (this.state.active && this.info) return this.info;
    if (this.startingPromise) return this.startingPromise;
    this.setState({ starting: true, active: false, error: undefined });
    this.startingPromise = this.openStream()
      .then((info) => {
        this.info = info;
        this.setState({ active: true, starting: false, info, error: undefined });
        return info;
      })
      .catch((error) => {
        this.setState({
          active: false,
          starting: false,
          info: undefined,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      })
      .finally(() => {
        this.startingPromise = null;
      });
    return this.startingPromise;
  }

  private async openStream(): Promise<AudioMonitorInfo> {
    const stream = await this.createStream();
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('没有检测到系统音频轨道，请确认电脑正在输出声音。');
    }

    const context = new AudioContext();
    if (context.state === 'suspended') await context.resume();
    const sourceNode = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -10;
    const sinkNode = context.createGain();
    sinkNode.gain.value = 0;
    sourceNode.connect(analyser);
    analyser.connect(sinkNode);
    sinkNode.connect(context.destination);
    this.frequency = new Uint8Array(analyser.frequencyBinCount);
    this.waveform = new Uint8Array(analyser.fftSize);
    this.timeDomain = new Float32Array(analyser.fftSize);

    this.stream = stream;
    this.context = context;
    this.sourceNode = sourceNode;
    this.analyser = analyser;
    this.sinkNode = sinkNode;

    const track = audioTracks[0];
    track.addEventListener('ended', () => this.stop());
    const settings = track.getSettings();
    const info: AudioMonitorInfo = {
      sampleRate: context.sampleRate,
      channels: Number(settings.channelCount) || sourceNode.channelCount || 2,
      label: track.label || '系统音频输出'
    };
    return info;
  }

  private async createStream(): Promise<MediaStream> {
    try {
      const source = await window.nyxel.audio.source();
      if (source) {
        const constraints = {
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop'
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: source.id,
              maxWidth: 1,
              maxHeight: 1,
              maxFrameRate: 1
            }
          }
        } as unknown as MediaStreamConstraints;
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream.getAudioTracks().length) return stream;
        stream.getTracks().forEach((track) => track.stop());
      }
    } catch {
      // Fall through to getDisplayMedia; the legacy desktop constraint is not
      // available on every Windows audio driver.
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('没有捕获到系统音频。请先播放声音，或检查 Windows 的声音输出设备。');
    }
    return stream;
  }

  stop(): void {
    const stream = this.stream;
    this.stream = null;
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.sinkNode?.disconnect();
    this.sinkNode = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
    this.info = null;
    this.setState({ active: false, starting: false, info: undefined, error: undefined });
  }

  readFrequency(): Uint8Array {
    if (!this.analyser) {
      this.frequency.fill(0);
      return this.frequency;
    }
    if (this.frequency.length !== this.analyser.frequencyBinCount) {
      this.frequency = new Uint8Array(this.analyser.frequencyBinCount);
    }
    this.analyser.getByteFrequencyData(this.frequency);
    return this.frequency;
  }

  readWaveform(): Uint8Array {
    if (!this.analyser) {
      this.waveform.fill(0);
      return this.waveform;
    }
    if (this.waveform.length !== this.analyser.fftSize) {
      this.waveform = new Uint8Array(this.analyser.fftSize);
    }
    this.analyser.getByteTimeDomainData(this.waveform);
    return this.waveform;
  }

  readMetrics(): AudioMetrics {
    if (!this.analyser) return { rms: 0, peak: 0, db: -100, peakDb: -100 };
    if (this.timeDomain.length !== this.analyser.fftSize) {
      this.timeDomain = new Float32Array(this.analyser.fftSize);
    }
    this.analyser.getFloatTimeDomainData(this.timeDomain);
    let sum = 0;
    let peak = 0;
    for (const sample of this.timeDomain) {
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / this.timeDomain.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -100;
    return { rms, peak, db, peakDb };
  }
}

export const audioMonitor = new AudioMonitor();

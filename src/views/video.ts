import type {
  VideoAudio,
  VideoCodec,
  VideoCompressOptions,
  VideoFps,
  VideoInfo,
  VideoProgress,
  VideoResolution,
  VideoStatus,
  ViewCallbacks
} from '../types';
import { basename, formatBytes } from '../utils';

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.ts', '.flv', '.wmv'];

interface PresetValues {
  codec: VideoCodec;
  crf: number;
  resolution: VideoResolution;
  fps: VideoFps;
  audio: VideoAudio;
}

const PRESETS: Record<string, PresetValues> = {
  high: { codec: 'h264', crf: 20, resolution: 'source', fps: 'source', audio: 'aac192' },
  balanced: { codec: 'h264', crf: 23, resolution: 'source', fps: 'source', audio: 'aac128' },
  small: { codec: 'h265', crf: 28, resolution: '1080', fps: 'source', audio: 'aac96' }
};

export class VideoView {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private active = false;
  private info: VideoInfo | null = null;
  private outputDir = '';
  private outputPath = '';
  private busy = false;
  private status: VideoStatus | null = null;

  private empty: HTMLElement;
  private workspace: HTMLElement;
  private fileName: HTMLElement;
  private fileMeta: HTMLElement;
  private outputInput: HTMLInputElement;
  private presetSelect: HTMLSelectElement;
  private codecSelect: HTMLSelectElement;
  private crfInput: HTMLInputElement;
  private crfValue: HTMLElement;
  private resolutionSelect: HTMLSelectElement;
  private fpsSelect: HTMLSelectElement;
  private audioSelect: HTMLSelectElement;
  private progressBar: HTMLElement;
  private progressText: HTMLElement;
  private result: HTMLElement;
  private startButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;
  private openOutputButton: HTMLButtonElement;
  private runtime: HTMLElement;
  private pluginWarning: HTMLElement;
  private runtimeText: HTMLElement;
  private runtimeBar: HTMLElement;
  private runtimePercent: HTMLElement;
  private runtimeButton: HTMLButtonElement;
  private runtimeLabel: HTMLElement;
  private applyingPreset = false;

  constructor(callbacks: ViewCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view video-view';
    this.element.innerHTML = `
      <div class="view-toolbar">
        <strong class="files-title">视频压缩</strong>
        <span class="files-sub" id="video-runtime-label">检查 ffmpeg…</span>
        <span class="spacer"></span>
        <button data-action="choose" class="primary">选择视频</button>
        <button data-action="open-output">输出文件夹</button>
      </div>
      <div class="view-body video-body">
        <div class="plugin-warning" id="video-plugin-warning">
          <span class="plugin-warning-icon">!</span>
          <div class="plugin-warning-body">
            <strong>需要下载外部组件</strong>
            <span>视频压缩依赖 ffmpeg 运行时（约 200 MB），首次使用会联网下载，下载后可离线使用。</span>
          </div>
        </div>
        <div class="video-runtime hidden" id="video-runtime">
          <div class="video-runtime-info">
            <strong>需要 ffmpeg 运行时</strong>
            <span id="video-runtime-text">首次压缩前需要下载 ffmpeg（约 200 MB），之后可离线使用。</span>
          </div>
          <div class="video-runtime-progress">
            <div class="video-progress-track"><div id="video-runtime-bar"></div></div>
            <span id="video-runtime-percent">0%</span>
          </div>
          <button class="primary" data-action="download">下载 ffmpeg</button>
        </div>

        <div class="video-empty" id="video-empty">
          <strong>拖入视频，或点右上角「选择视频」</strong>
          <span>支持 MP4 / MOV / MKV / AVI / WebM 等常见格式</span>
        </div>

        <div class="video-workspace hidden" id="video-workspace">
          <section class="video-file-card">
            <div class="video-file-head">
              <span class="video-file-icon">▶</span>
              <div class="video-file-title">
                <strong id="video-file-name">未选择视频</strong>
                <span id="video-file-meta"></span>
              </div>
            </div>
            <div class="video-meta-grid" id="video-meta-grid"></div>
            <div class="video-output-row">
              <label for="video-output-dir">输出目录</label>
              <input id="video-output-dir" type="text" spellcheck="false">
              <button data-action="browse-output">浏览…</button>
            </div>
          </section>

          <section class="video-settings">
            <div class="video-setting-row">
              <label for="video-preset">压缩预设</label>
              <select id="video-preset">
                <option value="high">高画质</option>
                <option value="balanced" selected>平衡（推荐）</option>
                <option value="small">小体积</option>
                <option value="custom">自定义</option>
              </select>
            </div>
            <div class="video-setting-row">
              <label for="video-codec">编码器</label>
              <select id="video-codec">
                <option value="h264">H.264（兼容性好）</option>
                <option value="h265">H.265（体积更小）</option>
              </select>
            </div>
            <div class="video-setting-row">
              <label for="video-crf">质量 CRF</label>
              <div class="video-range-wrap">
                <input id="video-crf" type="range" min="14" max="35" step="1" value="23">
                <span id="video-crf-value">23</span>
              </div>
            </div>
            <div class="video-setting-row">
              <label for="video-resolution">分辨率</label>
              <select id="video-resolution">
                <option value="source">保持原始</option>
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="480">480p</option>
              </select>
            </div>
            <div class="video-setting-row">
              <label for="video-fps">帧率</label>
              <select id="video-fps">
                <option value="source">保持原始</option>
                <option value="60">60 fps</option>
                <option value="30">30 fps</option>
                <option value="24">24 fps</option>
              </select>
            </div>
            <div class="video-setting-row">
              <label for="video-audio">音频</label>
              <select id="video-audio">
                <option value="aac192">AAC 192k</option>
                <option value="aac128" selected>AAC 128k</option>
                <option value="aac96">AAC 96k</option>
                <option value="none">移除音频</option>
              </select>
            </div>
            <div class="video-setting-hint">CRF 越低画质越好、文件越大；H.265 通常比 H.264 更小，但兼容性稍差。</div>
          </section>

          <section class="video-run">
            <div class="video-progress-wrap">
              <div class="video-progress-track"><div id="video-progress-bar"></div></div>
              <div class="video-progress-text" id="video-progress-text">选择视频后开始压缩</div>
            </div>
            <div class="video-actions">
              <button class="primary" data-action="start" disabled>开始压缩</button>
              <button data-action="cancel" disabled>取消</button>
              <button data-action="show-output" class="hidden">打开输出文件</button>
            </div>
            <div class="video-result hidden" id="video-result"></div>
          </section>
        </div>
      </div>
    `;

    this.empty = this.element.querySelector('#video-empty') as HTMLElement;
    this.workspace = this.element.querySelector('#video-workspace') as HTMLElement;
    this.fileName = this.element.querySelector('#video-file-name') as HTMLElement;
    this.fileMeta = this.element.querySelector('#video-file-meta') as HTMLElement;
    this.outputInput = this.element.querySelector('#video-output-dir') as HTMLInputElement;
    this.presetSelect = this.element.querySelector('#video-preset') as HTMLSelectElement;
    this.codecSelect = this.element.querySelector('#video-codec') as HTMLSelectElement;
    this.crfInput = this.element.querySelector('#video-crf') as HTMLInputElement;
    this.crfValue = this.element.querySelector('#video-crf-value') as HTMLElement;
    this.resolutionSelect = this.element.querySelector('#video-resolution') as HTMLSelectElement;
    this.fpsSelect = this.element.querySelector('#video-fps') as HTMLSelectElement;
    this.audioSelect = this.element.querySelector('#video-audio') as HTMLSelectElement;
    this.progressBar = this.element.querySelector('#video-progress-bar') as HTMLElement;
    this.progressText = this.element.querySelector('#video-progress-text') as HTMLElement;
    this.result = this.element.querySelector('#video-result') as HTMLElement;
    this.startButton = this.element.querySelector('[data-action="start"]') as HTMLButtonElement;
    this.cancelButton = this.element.querySelector('[data-action="cancel"]') as HTMLButtonElement;
    this.openOutputButton = this.element.querySelector('[data-action="show-output"]') as HTMLButtonElement;
    this.runtime = this.element.querySelector('#video-runtime') as HTMLElement;
    this.pluginWarning = this.element.querySelector('#video-plugin-warning') as HTMLElement;
    this.runtimeText = this.element.querySelector('#video-runtime-text') as HTMLElement;
    this.runtimeBar = this.element.querySelector('#video-runtime-bar') as HTMLElement;
    this.runtimePercent = this.element.querySelector('#video-runtime-percent') as HTMLElement;
    this.runtimeButton = this.element.querySelector('[data-action="download"]') as HTMLButtonElement;
    this.runtimeLabel = this.element.querySelector('#video-runtime-label') as HTMLElement;

    this.bindEvents();
    window.nyxel.video.onProgress((progress) => this.onProgress(progress));
  }

  private bindEvents(): void {
    this.element.querySelector('[data-action="choose"]')?.addEventListener('click', () => void this.chooseVideo());
    this.element.querySelector('[data-action="open-output"]')?.addEventListener('click', () => void this.openOutputFolder());
    this.element.querySelector('[data-action="browse-output"]')?.addEventListener('click', () => void this.chooseOutputDir());
    this.element.querySelector('[data-action="download"]')?.addEventListener('click', () => void this.downloadRuntime());
    this.element.querySelector('[data-action="start"]')?.addEventListener('click', () => void this.startCompress());
    this.element.querySelector('[data-action="cancel"]')?.addEventListener('click', () => void this.cancelCompress());
    this.element.querySelector('[data-action="show-output"]')?.addEventListener('click', () => {
      if (this.outputPath) void window.nyxel.app.showItemInFolder(this.outputPath);
    });

    this.presetSelect.addEventListener('change', () => this.applyPreset(this.presetSelect.value));
    this.codecSelect.addEventListener('change', () => this.markCustom());
    this.crfInput.addEventListener('input', () => {
      this.crfValue.textContent = this.crfInput.value;
      this.markCustom();
    });
    this.resolutionSelect.addEventListener('change', () => this.markCustom());
    this.fpsSelect.addEventListener('change', () => this.markCustom());
    this.audioSelect.addEventListener('change', () => this.markCustom());
    this.outputInput.addEventListener('change', () => {
      this.outputDir = this.outputInput.value.trim();
    });

    this.element.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.element.classList.add('video-drop');
    });
    this.element.addEventListener('dragleave', (event) => {
      if (event.target === this.element) this.element.classList.remove('video-drop');
    });
    this.element.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.element.classList.remove('video-drop');
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      const path = (file as File & { path?: string }).path;
      if (!path) {
        this.callbacks.toast('请使用「选择视频」按钮导入文件', 'info');
        return;
      }
      if (!VIDEO_EXTS.includes(`.${file.name.split('.').pop()?.toLowerCase()}`)) {
        this.callbacks.toast('不支持这个视频格式', 'error');
        return;
      }
      void this.loadPath(path);
    });
  }

  async activate(): Promise<void> {
    this.active = true;
    await this.refreshStatus();
  }

  deactivate(): void {
    this.active = false;
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await window.nyxel.video.status();
      this.status = status;
      if (!this.outputDir) {
        this.outputDir = status.defaultOutputDir;
        this.outputInput.value = this.outputDir;
      }
      this.runtimeLabel.textContent = status.available ? 'ffmpeg 已就绪' : '未安装 ffmpeg';
      this.runtime.classList.toggle('hidden', status.available);
      this.pluginWarning.classList.toggle('hidden', status.available);
      this.runtimeButton.disabled = status.downloading;
      this.runtimeButton.textContent = status.downloading ? '下载中…' : '下载 ffmpeg';
      if (status.progress && (status.progress.phase === 'download' || status.progress.phase === 'extract')) {
        this.updateRuntimeProgress(status.progress);
      }
      this.updateButtons();
    } catch (error) {
      this.runtimeLabel.textContent = '无法检查 ffmpeg';
      this.callbacks.toast(`检查 ffmpeg 失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async downloadRuntime(): Promise<void> {
    if (this.runtimeButton.disabled) return;
    this.runtimeButton.disabled = true;
    this.runtimeButton.textContent = '下载中…';
    try {
      const result = await window.nyxel.video.download();
      if (!result.ok) {
        this.callbacks.toast(`ffmpeg 下载失败：${result.error ?? '未知错误'}`, 'error');
      } else {
        this.callbacks.toast('ffmpeg 运行时已就绪', 'success');
      }
      await this.refreshStatus();
    } catch (error) {
      this.callbacks.toast(`ffmpeg 下载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.runtimeButton.disabled = false;
      this.runtimeButton.textContent = '下载 ffmpeg';
    }
  }

  private async chooseVideo(): Promise<void> {
    const path = await window.nyxel.dialog.openVideo();
    if (path) await this.loadPath(path);
  }

  async loadPath(path: string): Promise<void> {
    this.info = null;
    this.empty.classList.add('hidden');
    this.workspace.classList.remove('hidden');
    this.fileName.textContent = basename(path);
    this.fileMeta.textContent = '读取视频信息…';
    this.progressBar.style.width = '0%';
    this.progressText.textContent = '正在读取视频信息…';
    try {
      const result = await window.nyxel.video.probe(path);
      if (!result.ok || !result.info) {
        this.callbacks.toast(`读取视频失败：${result.error ?? '未知错误'}`, 'error');
        this.progressText.textContent = '读取视频失败';
        this.workspace.classList.add('hidden');
        this.empty.classList.remove('hidden');
        return;
      }
      this.info = result.info;
      this.empty.classList.add('hidden');
      this.workspace.classList.remove('hidden');
      this.renderInfo(result.info);
      this.progressText.textContent = '设置参数后点「开始压缩」';
      this.updateButtons();
    } catch (error) {
      this.callbacks.toast(`读取视频失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      this.progressText.textContent = '读取视频失败';
    }
  }

  private renderInfo(info: VideoInfo): void {
    this.fileName.textContent = info.name;
    this.fileMeta.textContent = `${formatBytes(info.size)} · ${this.formatDuration(info.duration)}`;
    const grid = this.element.querySelector('#video-meta-grid') as HTMLElement;
    grid.innerHTML = '';
    const items: Array<[string, string]> = [
      ['时长', this.formatDuration(info.duration)],
      ['分辨率', `${info.width} × ${info.height}`],
      ['帧率', info.fps ? `${info.fps.toFixed(2)} fps` : '未知'],
      ['视频编码', info.videoCodec || '未知'],
      ['音频', info.audioCodec || '无'],
      ['大小', formatBytes(info.size)]
    ];
    for (const [label, value] of items) {
      const item = document.createElement('div');
      item.className = 'video-meta-item';
      const strong = document.createElement('span');
      strong.textContent = label;
      const span = document.createElement('strong');
      span.textContent = value;
      item.append(strong, span);
      grid.append(item);
    }
  }

  private formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '未知';
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value: number) => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  private applyPreset(name: string): void {
    const preset = PRESETS[name];
    if (!preset) return;
    this.applyingPreset = true;
    this.codecSelect.value = preset.codec;
    this.crfInput.value = String(preset.crf);
    this.crfValue.textContent = String(preset.crf);
    this.resolutionSelect.value = preset.resolution;
    this.fpsSelect.value = preset.fps;
    this.audioSelect.value = preset.audio;
    this.applyingPreset = false;
  }

  private markCustom(): void {
    if (this.applyingPreset) return;
    this.presetSelect.value = 'custom';
  }

  private async chooseOutputDir(): Promise<void> {
    const selected = await window.nyxel.dialog.openDirectory();
    if (!selected) return;
    this.outputDir = selected;
    this.outputInput.value = selected;
  }

  private async startCompress(): Promise<void> {
    if (!this.info || this.busy) return;
    if (!this.status?.available) {
      this.callbacks.toast('请先下载 ffmpeg 运行时', 'info');
      this.runtime.classList.remove('hidden');
      return;
    }
    const options: VideoCompressOptions = {
      input: this.info.path,
      outputDir: this.outputDir || this.status.defaultOutputDir,
      codec: this.codecSelect.value as VideoCodec,
      crf: Number(this.crfInput.value) || 23,
      preset: 'medium',
      resolution: this.resolutionSelect.value as VideoResolution,
      fps: this.fpsSelect.value as VideoFps,
      audio: this.audioSelect.value as VideoAudio
    };

    this.busy = true;
    this.outputPath = '';
    this.result.classList.add('hidden');
    this.openOutputButton.classList.add('hidden');
    this.progressBar.style.width = '0%';
    this.progressText.textContent = '准备压缩…';
    this.updateButtons();
    try {
      const result = await window.nyxel.video.compress(options);
      if (result.ok && result.output) {
        this.outputPath = result.output;
        const saved = this.info.size > 0 && result.size ? Math.max(0, 100 - (result.size / this.info.size) * 100) : 0;
        this.result.textContent = `已压缩：${result.output}${result.size ? ` · ${formatBytes(result.size)}` : ''}${saved ? ` · 减少约 ${saved.toFixed(0)}%` : ''}`;
        this.result.classList.remove('hidden');
        this.openOutputButton.classList.remove('hidden');
        this.progressBar.style.width = '100%';
        this.progressText.textContent = '压缩完成';
        this.callbacks.toast('视频压缩完成', 'success');
      } else if (result.cancelled) {
        this.progressText.textContent = '已取消';
        this.callbacks.toast('已取消压缩', 'info');
      } else {
        this.progressText.textContent = `压缩失败：${result.error ?? '未知错误'}`;
        this.callbacks.toast(`压缩失败：${result.error ?? '未知错误'}`, 'error');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.progressText.textContent = `压缩失败：${message}`;
      this.callbacks.toast(`压缩失败：${message}`, 'error');
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  private async cancelCompress(): Promise<void> {
    if (!this.busy) return;
    const cancelled = await window.nyxel.video.cancel();
    if (cancelled) {
      this.progressText.textContent = '正在取消…';
    }
  }

  private async openOutputFolder(): Promise<void> {
    const target = this.outputDir || this.status?.defaultOutputDir;
    if (!target) return;
    const error = await window.nyxel.app.openPath(target);
    if (error) this.callbacks.toast(`打开输出目录失败：${error}`, 'error');
  }

  private updateButtons(): void {
    const ready = Boolean(this.info) && !this.busy;
    this.startButton.disabled = !ready || !this.status?.available;
    this.cancelButton.disabled = !this.busy;
    this.presetSelect.disabled = this.busy;
    this.codecSelect.disabled = this.busy;
    this.crfInput.disabled = this.busy;
    this.resolutionSelect.disabled = this.busy;
    this.fpsSelect.disabled = this.busy;
    this.audioSelect.disabled = this.busy;
    this.outputInput.disabled = this.busy;
  }

  private onProgress(progress: VideoProgress): void {
    if (!this.active) return;
    if (progress.phase === 'download' || progress.phase === 'extract') {
      this.updateRuntimeProgress(progress);
      return;
    }
    if (progress.phase === 'compress' || progress.phase === 'done' || progress.phase === 'error') {
      const percent = Math.max(0, Math.min(100, progress.percent || 0));
      this.progressBar.style.width = `${percent}%`;
      if (progress.phase === 'error') {
        this.progressText.textContent = progress.message ?? '压缩失败';
      } else if (progress.phase === 'done') {
        this.progressText.textContent = '压缩完成';
      } else {
        this.progressText.textContent = progress.message ?? `压缩中 ${percent.toFixed(0)}%`;
      }
    }
  }

  private updateRuntimeProgress(progress: VideoProgress): void {
    const percent = Math.max(0, Math.min(100, progress.percent || 0));
    this.runtimeBar.style.width = `${percent}%`;
    this.runtimePercent.textContent = `${percent.toFixed(0)}%`;
    if (progress.message) this.runtimeText.textContent = progress.message;
  }
}

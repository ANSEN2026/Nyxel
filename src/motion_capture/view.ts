import { MOTION_STAGES, type MotionStage } from '../../electron/motion_capture/contracts';
import type {
  MotionCaptureConfig,
  MotionCaptureProgress,
  MotionCaptureResult,
  SkeletonAnimation,
  ViewCallbacks
} from '../types';
import { basename } from '../utils';
import { SkeletonPreview } from './preview';

const STAGE_LABELS: Record<MotionStage, string> = {
  decode: '读取视频',
  detect: '检测人体',
  track: '跟踪',
  pose2d: '二维关节点',
  pose3d: '三维骨架',
  cleanup: '清理与补帧',
  export: '导出'
};

const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'flv', 'wmv'];

function isVideoFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTS.includes(ext);
}

export class MotionCaptureView {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private config: MotionCaptureConfig | null = null;
  private selectedPath = '';
  private jobId = '';
  private logPath = '';
  private busy = false;
  private result: MotionCaptureResult | null = null;
  private preview: SkeletonPreview;
  private unsubscribe: () => void;

  private empty: HTMLElement;
  private workspace: HTMLElement;
  private backend: HTMLElement;
  private runtimeWarning: HTMLElement;
  private runtimeText: HTMLElement;
  private sourceName: HTMLElement;
  private sourceMeta: HTMLElement;
  private configSummary: HTMLElement;
  private stages: HTMLElement;
  private progressBar: HTMLElement;
  private progressPercent: HTMLElement;
  private progressMessage: HTMLElement;
  private previewHost: HTMLElement;
  private previewPlaceholder: HTMLElement;
  private previewMeta: HTMLElement;
  private timeline: HTMLInputElement;
  private timelineTime: HTMLElement;
  private playButton: HTMLButtonElement;
  private startButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;
  private logButton: HTMLButtonElement;
  private chooseButton: HTMLButtonElement;
  private resultCard: HTMLElement;
  private resultFile: HTMLElement;
  private resultMeta: HTMLElement;
  private resultWarnings: HTMLElement;
  private exportButton: HTMLButtonElement;
  private exportFormat: HTMLSelectElement;
  private showOutputButton: HTMLButtonElement;
  private logOverlay: HTMLElement;
  private logContent: HTMLElement;
  private logPathText: HTMLElement;

  constructor(callbacks: ViewCallbacks, options?: { autoRefresh?: boolean }) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view motion-view';
    this.element.innerHTML = `
      <div class="view-toolbar">
        <strong class="files-title">从视频生成动作</strong>
        <span class="files-sub" id="motion-backend">Mock 预设骨架</span>
        <span class="spacer"></span>
        <button data-action="choose" class="primary">选择视频</button>
        <button data-action="start" disabled>开始分析</button>
        <button data-action="cancel" disabled>取消</button>
        <button data-action="logs" disabled>日志</button>
      </div>
      <div class="view-body motion-body">
        <div class="plugin-warning hidden" id="motion-runtime-warning">
          <span class="plugin-warning-icon">!</span>
          <div class="plugin-warning-body">
            <strong>动作捕捉运行时未就绪</strong>
            <span id="motion-runtime-text">请在设置 → 动作捕捉选择 Python 路径，并安装 MediaPipe。</span>
          </div>
        </div>
        <div class="motion-empty" id="motion-empty">
          <strong>拖入视频，或点右上角「选择视频」</strong>
          <span>本轮使用 Mock 预设骨架跑通完整流程，真实模型下一轮接入</span>
        </div>

        <div class="motion-workspace hidden" id="motion-workspace">
          <section class="motion-card motion-source-card">
            <div class="motion-source-head">
              <span class="motion-source-icon">▶</span>
              <div class="motion-source-title">
                <strong id="motion-source-name">未选择视频</strong>
                <span id="motion-source-meta">等待选择</span>
              </div>
            </div>
            <div class="motion-config-summary" id="motion-config-summary"></div>
          </section>

          <section class="motion-card motion-stage-card">
            <div class="motion-card-head">
              <h3>分析阶段</h3>
              <span id="motion-stage-hint">等待开始</span>
            </div>
            <div class="motion-stages" id="motion-stages"></div>
            <div class="motion-progress-line">
              <div class="video-progress-track"><div id="motion-progress-bar"></div></div>
              <span id="motion-progress-percent">0%</span>
            </div>
            <div class="motion-progress-message" id="motion-progress-message">选择视频后开始分析</div>
          </section>

          <section class="motion-card motion-preview-card">
            <div class="motion-card-head">
              <h3>骨骼预览</h3>
              <span id="motion-preview-meta">等待分析</span>
            </div>
            <div class="motion-preview-canvas" id="motion-preview-canvas">
              <div class="motion-preview-placeholder" id="motion-preview-placeholder">
                分析完成后在这里查看 24 关节三维骨架
              </div>
            </div>
            <div class="motion-timeline">
              <button data-action="play" disabled>播放</button>
              <input id="motion-timeline" type="range" min="0" max="1" step="0.001" value="0" disabled>
              <span id="motion-timeline-time">0.00 / 0.00s</span>
            </div>
          </section>

          <section class="motion-card motion-result hidden" id="motion-result">
            <div class="motion-card-head">
              <h3>导出结果</h3>
              <span class="motion-result-badge" id="motion-result-badge">BVH / FBX</span>
            </div>
            <div class="motion-result-grid">
              <div><span>文件</span><strong id="motion-result-file">—</strong></div>
              <div><span>骨架</span><strong id="motion-result-meta">—</strong></div>
            </div>
            <div class="motion-result-warnings" id="motion-result-warnings"></div>
            <div class="motion-result-actions">
              <select id="motion-export-format" class="motion-export-format" disabled>
                <option value="bvh">BVH</option>
                <option value="fbx-ue5">FBX · UE5 Mannequin（重定向）</option>
                <option value="fbx-ue">FBX · UE 通用（Z-up）</option>
                <option value="fbx-yup">FBX · 通用（Y-up）</option>
              </select>
              <button class="primary" data-action="export" disabled>导出</button>
              <button data-action="show-output" disabled>打开输出文件夹</button>
            </div>
          </section>
        </div>
      </div>

      <div class="motion-log-overlay hidden" id="motion-log-overlay">
        <div class="motion-log-panel">
          <header>
            <strong>任务日志</strong>
            <button data-action="close-log" type="button" aria-label="关闭日志">×</button>
          </header>
          <pre id="motion-log-content"></pre>
          <footer>
            <span id="motion-log-path"></span>
            <button data-action="show-log" type="button">在文件夹中显示</button>
          </footer>
        </div>
      </div>
    `;

    this.empty = this.element.querySelector('#motion-empty') as HTMLElement;
    this.workspace = this.element.querySelector('#motion-workspace') as HTMLElement;
    this.backend = this.element.querySelector('#motion-backend') as HTMLElement;
    this.runtimeWarning = this.element.querySelector('#motion-runtime-warning') as HTMLElement;
    this.runtimeText = this.element.querySelector('#motion-runtime-text') as HTMLElement;
    this.sourceName = this.element.querySelector('#motion-source-name') as HTMLElement;
    this.sourceMeta = this.element.querySelector('#motion-source-meta') as HTMLElement;
    this.configSummary = this.element.querySelector('#motion-config-summary') as HTMLElement;
    this.stages = this.element.querySelector('#motion-stages') as HTMLElement;
    this.progressBar = this.element.querySelector('#motion-progress-bar') as HTMLElement;
    this.progressPercent = this.element.querySelector('#motion-progress-percent') as HTMLElement;
    this.progressMessage = this.element.querySelector('#motion-progress-message') as HTMLElement;
    this.previewHost = this.element.querySelector('#motion-preview-canvas') as HTMLElement;
    this.previewPlaceholder = this.element.querySelector('#motion-preview-placeholder') as HTMLElement;
    this.previewMeta = this.element.querySelector('#motion-preview-meta') as HTMLElement;
    this.timeline = this.element.querySelector('#motion-timeline') as HTMLInputElement;
    this.timelineTime = this.element.querySelector('#motion-timeline-time') as HTMLElement;
    this.playButton = this.element.querySelector('[data-action="play"]') as HTMLButtonElement;
    this.startButton = this.element.querySelector('[data-action="start"]') as HTMLButtonElement;
    this.cancelButton = this.element.querySelector('[data-action="cancel"]') as HTMLButtonElement;
    this.logButton = this.element.querySelector('[data-action="logs"]') as HTMLButtonElement;
    this.chooseButton = this.element.querySelector('[data-action="choose"]') as HTMLButtonElement;
    this.resultCard = this.element.querySelector('#motion-result') as HTMLElement;
    this.resultFile = this.element.querySelector('#motion-result-file') as HTMLElement;
    this.resultMeta = this.element.querySelector('#motion-result-meta') as HTMLElement;
    this.resultWarnings = this.element.querySelector('#motion-result-warnings') as HTMLElement;
    this.exportButton = this.element.querySelector('[data-action="export"]') as HTMLButtonElement;
    this.exportFormat = this.element.querySelector('#motion-export-format') as HTMLSelectElement;
    this.showOutputButton = this.element.querySelector('[data-action="show-output"]') as HTMLButtonElement;
    this.logOverlay = this.element.querySelector('#motion-log-overlay') as HTMLElement;
    this.logContent = this.element.querySelector('#motion-log-content') as HTMLElement;
    this.logPathText = this.element.querySelector('#motion-log-path') as HTMLElement;

    this.stages.innerHTML = MOTION_STAGES.map((stage) => `
      <div class="motion-stage" data-stage="${stage}">
        <span class="motion-stage-dot"></span>
        <span class="motion-stage-name">${STAGE_LABELS[stage]}</span>
        <span class="motion-stage-percent"></span>
      </div>
    `).join('');

    this.preview = new SkeletonPreview(this.previewHost);
    this.preview.setOnTime((time, duration) => {
      this.timeline.max = String(Math.max(0.001, duration));
      this.timeline.value = String(time);
      this.timelineTime.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)}s`;
      this.playButton.textContent = this.preview.isPlaying ? '暂停' : '播放';
    });

    this.bind();
    this.unsubscribe = window.nyxel.motionCapture.onProgress((progress) => this.handleProgress(progress));
    if (options?.autoRefresh !== false) void this.refreshConfig();
  }

  async activate(): Promise<void> {
    this.preview.activate();
    await this.refreshConfig();
  }

  deactivate(): void {
    this.preview.deactivate();
  }

  loadPath(path: string): void {
    if (path) this.setSelected(path);
  }

  private bind(): void {
    this.chooseButton.addEventListener('click', () => void this.chooseVideo());
    this.startButton.addEventListener('click', () => void this.start());
    this.cancelButton.addEventListener('click', () => void this.cancel());
    this.logButton.addEventListener('click', () => void this.openLog());
    this.exportButton.addEventListener('click', () => void this.exportResult());
    this.showOutputButton.addEventListener('click', () => {
      if (this.result?.outputPath) void window.nyxel.app.showItemInFolder(this.result.outputPath);
    });
    this.playButton.addEventListener('click', () => {
      if (!this.result) return;
      this.preview.toggle();
      this.playButton.textContent = this.preview.isPlaying ? '暂停' : '播放';
    });
    this.timeline.addEventListener('input', () => {
      this.preview.pause();
      this.preview.setTime(Number(this.timeline.value));
      this.playButton.textContent = '播放';
    });
    this.element.querySelector('[data-action="close-log"]')?.addEventListener('click', () => this.closeLog());
    this.logOverlay.addEventListener('click', (event) => {
      if (event.target === this.logOverlay) this.closeLog();
    });
    this.element.querySelector('[data-action="show-log"]')?.addEventListener('click', () => {
      if (this.logPath) void window.nyxel.app.showItemInFolder(this.logPath);
    });

    this.element.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.element.classList.add('motion-drop');
    });
    this.element.addEventListener('dragleave', (event) => {
      const related = event.relatedTarget as Node | null;
      if (!related || !this.element.contains(related)) this.element.classList.remove('motion-drop');
    });
    this.element.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.element.classList.remove('motion-drop');
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (!isVideoFile(file.name)) {
        this.callbacks.toast('请拖入视频文件', 'error');
        return;
      }
      const path = window.nyxel.library.getPathForFile(file);
      if (path) this.setSelected(path);
    });
  }

  private async refreshConfig(checkRuntime = true): Promise<void> {
    try {
      this.config = await window.nyxel.motionCapture.config();
      this.updateConfigSummary();
      if (checkRuntime) void this.refreshRuntime();
    } catch (error) {
      console.warn('motion capture config load failed', error);
    }
  }

  private async refreshRuntime(): Promise<void> {
    if (!this.config || this.config.provider === 'mock') {
      this.runtimeWarning.classList.add('hidden');
      return;
    }
    try {
      const runtime = await window.nyxel.motionCapture.runtime();
      if (runtime.ok) {
        this.runtimeWarning.classList.add('hidden');
      } else {
        this.runtimeText.textContent = `${runtime.message ?? 'MediaPipe 未就绪'} · 请在设置 → 动作捕捉选择 python.exe，或安装 mediapipe==0.10.21。`;
        this.runtimeWarning.classList.remove('hidden');
      }
    } catch (error) {
      this.runtimeText.textContent = error instanceof Error ? error.message : String(error);
      this.runtimeWarning.classList.remove('hidden');
    }
  }

  private updateConfigSummary(): void {
    if (!this.config) return;
    const provider = this.config.provider === 'mock' ? 'Mock 预设骨架' : 'MediaPipe Sidecar';
    this.backend.textContent = `${provider} · ${this.config.fps} fps`;
    this.configSummary.textContent =
      `${provider} · ${this.config.device.toUpperCase()} · ${this.config.fps} fps · ` +
      `${this.config.outputFormat.toUpperCase()}${this.config.keepRootMotion ? ' · 保留 root motion' : ''}`;
  }

  private async chooseVideo(): Promise<void> {
    if (this.busy) return;
    const path = await window.nyxel.dialog.openVideo();
    if (path) this.setSelected(path);
  }

  private setSelected(path: string): void {
    if (this.busy) return;
    this.selectedPath = path;
    this.empty.classList.add('hidden');
    this.workspace.classList.remove('hidden');
    this.sourceName.textContent = basename(path);
    this.sourceMeta.textContent = '视频文件 · 等待分析';
    this.result = null;
    this.jobId = '';
    this.logPath = '';
    this.resultCard.classList.add('hidden');
    this.exportButton.disabled = true;
    this.exportFormat.disabled = true;
    this.showOutputButton.disabled = true;
    this.playButton.disabled = true;
    this.timeline.disabled = true;
    this.preview.clear();
    this.previewPlaceholder.classList.remove('hidden');
    this.previewMeta.textContent = '等待分析';
    this.progressBar.style.width = '0%';
    this.progressPercent.textContent = '0%';
    this.progressMessage.textContent = '点击「开始分析」运行 Mock 骨架流程';
    this.resetStages();
    this.startButton.disabled = false;
    this.cancelButton.disabled = true;
    this.logButton.disabled = true;
    this.callbacks.status.set(basename(path), '动作捕捉 · 已选择视频');
  }

  private async start(): Promise<void> {
    if (this.busy || !this.selectedPath) return;
    await this.refreshConfig(false);
    this.busy = true;
    this.jobId = '';
    this.logPath = '';
    this.result = null;
    this.resultCard.classList.add('hidden');
    this.preview.clear();
    this.previewPlaceholder.classList.remove('hidden');
    this.previewMeta.textContent = '分析中';
    this.playButton.disabled = true;
    this.timeline.disabled = true;
    this.exportButton.disabled = true;
    this.exportFormat.disabled = true;
    this.showOutputButton.disabled = true;
    this.setBusy(true);
    this.setProgress(0, '准备分析…');
    this.resetStages();
    this.setStage('decode', 0, true);
    this.callbacks.status.set(basename(this.selectedPath), '动作捕捉 · 分析中');

    try {
      const response = await window.nyxel.motionCapture.start({ inputPath: this.selectedPath });
      this.jobId = response.jobId || this.jobId;
      this.logPath = response.logPath || '';
      this.logButton.disabled = !this.jobId;
      if (!response.ok) {
        const cancelled = response.code === 'CANCELLED';
        this.sourceMeta.textContent = cancelled ? '已取消' : '分析失败';
        this.previewMeta.textContent = cancelled ? '已取消' : '分析失败';
        this.progressMessage.textContent = cancelled ? '已取消' : `分析失败：${response.error ?? '未知错误'}`;
        this.callbacks.toast(cancelled ? '已取消动作捕捉' : `动作捕捉失败：${response.error ?? '未知错误'}`, cancelled ? 'info' : 'error');
        this.callbacks.status.set(basename(this.selectedPath), cancelled ? '动作捕捉 · 已取消' : '动作捕捉 · 失败');
        return;
      }

      this.result = response.result ?? null;
      if (this.result) {
        this.sourceMeta.textContent = '分析完成 · 可预览和导出';
        this.renderResult(this.result);
        const animation = await window.nyxel.motionCapture.preview(this.result.jobId);
        if (animation) this.applyPreview(animation);
        else {
          this.previewPlaceholder.textContent = 'Sidecar 模式本轮暂不返回预览；BVH 已生成';
          this.previewPlaceholder.classList.remove('hidden');
          this.previewMeta.textContent = '无预览数据';
        }
        this.callbacks.status.set(basename(this.selectedPath), `动作捕捉 · ${this.result.duration.toFixed(2)}s`);
        this.callbacks.toast('动作分析完成，可预览并导出 BVH', 'success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sourceMeta.textContent = '分析失败';
      this.previewMeta.textContent = '分析失败';
      this.progressMessage.textContent = `分析失败：${message}`;
      this.callbacks.toast(`动作捕捉失败：${message}`, 'error');
      this.callbacks.status.set(basename(this.selectedPath), '动作捕捉 · 失败');
    } finally {
      this.busy = false;
      this.setBusy(false);
      this.cancelButton.disabled = true;
    }
  }

  private applyPreview(animation: SkeletonAnimation): void {
    this.previewPlaceholder.classList.add('hidden');
    this.previewMeta.textContent = `${animation.joints.length} 关节 · ${animation.fps} fps`;
    this.preview.setAnimation(animation);
    this.playButton.disabled = false;
    this.timeline.disabled = false;
    this.timeline.value = '0';
    this.timeline.max = String(Math.max(0.001, animation.duration));
    this.timelineTime.textContent = `0.00 / ${animation.duration.toFixed(2)}s`;
    this.playButton.textContent = '暂停';
  }

  private renderResult(result: MotionCaptureResult): void {
    this.resultCard.classList.remove('hidden');
    this.resultFile.textContent = result.outputPath;
    this.resultFile.title = result.outputPath;
    this.resultMeta.textContent =
      `${result.skeletonId} · ${result.fps} fps · ${result.duration.toFixed(2)}s · ` +
      `${result.hasRootMotion ? '有 root motion' : '无 root motion'}`;
    this.resultWarnings.textContent = result.warnings.length > 0
      ? result.warnings.map((warning) => `· ${warning}`).join('\n')
      : '';
    this.resultWarnings.classList.toggle('hidden', result.warnings.length === 0);
    this.exportButton.disabled = false;
    this.exportFormat.disabled = false;
    this.exportFormat.value = this.config?.outputFormat === 'fbx' ? 'fbx-ue5' : 'bvh';
    this.showOutputButton.disabled = false;
    this.playButton.disabled = false;
  }

  private async cancel(): Promise<void> {
    if (!this.busy) return;
    this.progressMessage.textContent = '正在取消…';
    const cancelled = await window.nyxel.motionCapture.cancel(this.jobId || undefined);
    if (!cancelled) this.callbacks.toast('当前没有可取消的任务', 'info');
  }

  private async exportResult(): Promise<void> {
    if (!this.result) return;
    const format = this.exportFormat.value;
    this.exportButton.disabled = true;
    try {
      const response = format === 'bvh'
        ? await window.nyxel.motionCapture.exportResult(this.result.jobId)
        : format === 'fbx-ue5'
          ? await window.nyxel.motionCapture.exportFbx(this.result.jobId, 'unreal', 'ue5')
          : await window.nyxel.motionCapture.exportFbx(
            this.result.jobId,
            format === 'fbx-ue' ? 'unreal' : 'threejs',
            'generic'
          );
      if (response.cancelled) {
        this.callbacks.toast('已取消导出', 'info');
        return;
      }
      if (!response.ok || !response.path) {
        this.callbacks.toast(`导出失败：${response.error ?? '未知错误'}`, 'error');
        return;
      }
      const label = format === 'bvh'
        ? 'BVH'
        : format === 'fbx-ue5'
          ? 'FBX（UE5 Mannequin）'
          : 'FBX';
      this.callbacks.toast(`已导出 ${label}：${response.path}`, 'success');
      this.callbacks.status.set(basename(this.selectedPath), `动作捕捉 · 已导出 ${basename(response.path)}`);
    } catch (error) {
      this.callbacks.toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.exportButton.disabled = !this.result;
    }
  }

  private async openLog(): Promise<void> {
    if (!this.jobId) {
      this.callbacks.toast('还没有可查看的日志', 'info');
      return;
    }
    const response = await window.nyxel.motionCapture.log(this.jobId);
    this.logPath = response.path || '';
    this.logPathText.textContent = response.path || '';
    this.logContent.textContent = response.ok
      ? response.content || '（日志为空）'
      : `读取日志失败：${response.error ?? '未知错误'}`;
    this.logOverlay.classList.remove('hidden');
  }

  private closeLog(): void {
    this.logOverlay.classList.add('hidden');
  }

  private setBusy(busy: boolean): void {
    this.chooseButton.disabled = busy;
    this.startButton.disabled = busy || !this.selectedPath;
    this.cancelButton.disabled = !busy;
    this.logButton.disabled = !this.jobId;
  }

  private setProgress(percent: number, message: string): void {
    const value = Math.max(0, Math.min(100, percent));
    this.progressBar.style.width = `${value}%`;
    this.progressPercent.textContent = `${Math.round(value)}%`;
    this.progressMessage.textContent = message;
  }

  private resetStages(): void {
    this.stages.querySelectorAll<HTMLElement>('.motion-stage').forEach((node) => {
      node.classList.remove('active', 'done');
      const dot = node.querySelector<HTMLElement>('.motion-stage-percent');
      if (dot) dot.textContent = '';
    });
    const hint = this.element.querySelector('#motion-stage-hint');
    if (hint) hint.textContent = '等待开始';
  }

  private setStage(stage: MotionStage, percent: number, markPrevious: boolean): void {
    const currentIndex = MOTION_STAGES.indexOf(stage);
    if (currentIndex < 0) return;
    const allDone = stage === 'export' && percent >= 100;
    this.stages.querySelectorAll<HTMLElement>('.motion-stage').forEach((node, index) => {
      const dot = node.querySelector<HTMLElement>('.motion-stage-percent');
      node.classList.toggle('done', allDone || (markPrevious && index < currentIndex));
      node.classList.toggle('active', !allDone && index === currentIndex);
      if (dot) dot.textContent = !allDone && index === currentIndex ? `${Math.round(percent)}%` : '';
    });
    const hint = this.element.querySelector('#motion-stage-hint');
    if (hint) hint.textContent = allDone ? '完成' : STAGE_LABELS[stage];
  }

  private handleProgress(progress: MotionCaptureProgress): void {
    if (this.jobId && progress.jobId !== this.jobId) return;
    if (!this.jobId) {
      this.jobId = progress.jobId;
      this.logButton.disabled = false;
    }
    this.setProgress(progress.percent, progress.message);
    this.setStage(progress.stage, progress.percent, true);
  }
}

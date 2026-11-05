import type { DownloadProgress, ViewCallbacks } from '../types';

const DIR_KEY = 'texturemap.download.directory';
const THREADS_KEY = 'texturemap.download.threads';

export class DownloadView {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private urlInput: HTMLInputElement;
  private dirInput: HTMLInputElement;
  private nameInput: HTMLInputElement;
  private mirrorsInput: HTMLTextAreaElement;
  private threadsSelect: HTMLSelectElement;
  private startButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;
  private showButton: HTMLButtonElement;
  private progressBox: HTMLElement;
  private progressBar: HTMLElement;
  private statusText: HTMLElement;
  private percentText: HTMLElement;
  private bytesText: HTMLElement;
  private speedText: HTMLElement;
  private threadsText: HTMLElement;
  private resultBox: HTMLElement;
  private busy = false;
  private lastOutput = '';
  private autoName = '';

  constructor(callbacks: ViewCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view download-view';
    this.element.innerHTML = `
      <div class="view-toolbar download-toolbar">
        <strong class="files-title">下载</strong>
        <span class="files-sub">自定义文件 · 多线程加速</span>
        <span class="spacer"></span>
        <button type="button" data-download-open-dir>打开下载文件夹</button>
      </div>
      <div class="view-body download-body">
        <section class="download-card">
          <div class="download-heading">
            <h2>下载自定义文件</h2>
            <p>支持 HTTP / HTTPS 链接，优先使用多线程分段下载提高速度；服务器不支持分段时会自动回退单线程。</p>
          </div>
          <label class="download-field">
            <span>下载地址</span>
            <input id="download-url" type="text" placeholder="https://example.com/file.zip" spellcheck="false">
          </label>
          <label class="download-field">
            <span>保存到</span>
            <div class="download-field-row">
              <input id="download-dir" type="text" readonly>
              <button type="button" id="download-choose-dir">选择</button>
            </div>
          </label>
          <label class="download-field">
            <span>文件名</span>
            <input id="download-name" type="text" placeholder="自动从下载地址获取">
          </label>
          <label class="download-field download-field-mirrors">
            <span>备用地址</span>
            <textarea id="download-mirrors" rows="2" spellcheck="false" placeholder="可选：每行一个备用下载地址，必须指向同一个文件"></textarea>
          </label>
          <label class="download-field">
            <span>下载线程</span>
            <select id="download-threads">
              <option value="auto" selected>自动（推荐）</option>
              <option value="4">4 线程</option>
              <option value="8">8 线程</option>
              <option value="16">16 线程</option>
              <option value="32">32 线程</option>
              <option value="64">64 线程</option>
            </select>
          </label>
          <div class="download-actions">
            <button type="button" class="primary" id="download-start">开始下载</button>
            <button type="button" id="download-cancel" class="hidden">取消下载</button>
            <button type="button" id="download-show" class="hidden">在文件夹中显示</button>
          </div>
          <div class="download-progress hidden" id="download-progress">
            <div class="download-progress-head">
              <strong id="download-status">准备中…</strong>
              <span id="download-percent">0%</span>
            </div>
            <div class="download-bar"><span id="download-bar-fill"></span></div>
            <div class="download-meta">
              <span id="download-bytes">0 B / 0 B</span>
              <span id="download-speed">0 B/s</span>
              <span id="download-threads-used">1 线程</span>
            </div>
          </div>
          <div class="download-result hidden" id="download-result"></div>
        </section>
      </div>
    `;

    this.urlInput = this.element.querySelector('#download-url') as HTMLInputElement;
    this.dirInput = this.element.querySelector('#download-dir') as HTMLInputElement;
    this.nameInput = this.element.querySelector('#download-name') as HTMLInputElement;
    this.mirrorsInput = this.element.querySelector('#download-mirrors') as HTMLTextAreaElement;
    this.threadsSelect = this.element.querySelector('#download-threads') as HTMLSelectElement;
    this.startButton = this.element.querySelector('#download-start') as HTMLButtonElement;
    this.cancelButton = this.element.querySelector('#download-cancel') as HTMLButtonElement;
    this.showButton = this.element.querySelector('#download-show') as HTMLButtonElement;
    this.progressBox = this.element.querySelector('#download-progress') as HTMLElement;
    this.progressBar = this.element.querySelector('#download-bar-fill') as HTMLElement;
    this.statusText = this.element.querySelector('#download-status') as HTMLElement;
    this.percentText = this.element.querySelector('#download-percent') as HTMLElement;
    this.bytesText = this.element.querySelector('#download-bytes') as HTMLElement;
    this.speedText = this.element.querySelector('#download-speed') as HTMLElement;
    this.threadsText = this.element.querySelector('#download-threads-used') as HTMLElement;
    this.resultBox = this.element.querySelector('#download-result') as HTMLElement;

    window.nyxel.download.onProgress((progress) => this.renderProgress(progress));
    this.bindEvents();
    void this.initDirectory();
  }

  activate(): void {
    this.callbacks.status.set('下载', '自定义文件', this.busy ? '正在下载' : '多线程下载');
    if (!this.dirInput.value) void this.initDirectory();
  }

  deactivate(): void {
    // 下载在后台继续，进度事件会持续更新。
  }

  private async initDirectory(): Promise<void> {
    let saved = '';
    try { saved = localStorage.getItem(DIR_KEY) || ''; } catch { /* storage unavailable */ }
    if (saved) {
      this.dirInput.value = saved;
    } else {
      try {
        this.dirInput.value = await window.nyxel.download.defaultDir();
      } catch { /* leave empty */ }
    }
    try {
      const threads = localStorage.getItem(THREADS_KEY);
      if (threads) this.threadsSelect.value = threads;
    } catch { /* ignore */ }
  }

  private bindEvents(): void {
    this.urlInput.addEventListener('input', () => {
      const next = this.deriveFilename(this.urlInput.value);
      if (!next) return;
      if (!this.nameInput.value || this.nameInput.value === this.autoName) {
        this.autoName = next;
        this.nameInput.value = next;
      }
    });
    this.element.querySelector('#download-choose-dir')?.addEventListener('click', () => void this.chooseDirectory());
    this.element.querySelector('[data-download-open-dir]')?.addEventListener('click', () => void this.openDirectory());
    this.startButton.addEventListener('click', () => void this.startDownload());
    this.cancelButton.addEventListener('click', () => void this.cancelDownload());
    this.showButton.addEventListener('click', () => {
      if (this.lastOutput) void window.nyxel.app.showItemInFolder(this.lastOutput);
    });
    this.threadsSelect.addEventListener('change', () => {
      try { localStorage.setItem(THREADS_KEY, this.threadsSelect.value); } catch { /* ignore */ }
    });
  }

  private deriveFilename(value: string): string {
    try {
      const url = new URL(value.trim());
      const raw = decodeURIComponent(url.pathname.split('/').pop() || '');
      return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    } catch {
      return '';
    }
  }

  private async chooseDirectory(): Promise<void> {
    if (this.busy) return;
    const dir = await window.nyxel.dialog.openDirectory();
    if (!dir) return;
    this.dirInput.value = dir;
    try { localStorage.setItem(DIR_KEY, dir); } catch { /* ignore */ }
  }

  private async openDirectory(): Promise<void> {
    let dir = this.dirInput.value;
    if (!dir) {
      try { dir = await window.nyxel.download.defaultDir(); } catch { /* ignore */ }
    }
    if (!dir) return;
    const error = await window.nyxel.app.openPath(dir);
    if (error) this.callbacks.toast(`打开文件夹失败：${error}`, 'error');
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.startButton.disabled = busy;
    this.urlInput.disabled = busy;
    this.dirInput.disabled = busy;
    this.nameInput.disabled = busy;
    this.mirrorsInput.disabled = busy;
    this.threadsSelect.disabled = busy;
    this.cancelButton.classList.toggle('hidden', !busy);
    if (busy) {
      this.showButton.classList.add('hidden');
      this.resultBox.classList.add('hidden');
      this.progressBox.classList.remove('hidden');
    }
  }

  private async startDownload(): Promise<void> {
    if (this.busy) return;
    const url = this.urlInput.value.trim();
    const directory = this.dirInput.value.trim();
    const filename = this.nameInput.value.trim() || this.deriveFilename(url);
    if (!url) { this.callbacks.toast('请填写下载地址', 'info'); return; }
    if (!directory) { this.callbacks.toast('请选择保存文件夹', 'info'); return; }
    if (!filename) { this.callbacks.toast('请填写文件名', 'info'); return; }
    if (!this.nameInput.value.trim()) this.nameInput.value = filename;
    this.lastOutput = '';
    this.resultBox.textContent = '';
    this.resultBox.classList.add('hidden');
    this.showButton.classList.add('hidden');
    this.progressBar.style.width = '0%';
    this.percentText.textContent = '0%';
    this.statusText.textContent = '正在准备…';
    this.bytesText.textContent = '0 B / 0 B';
    this.speedText.textContent = '0 B/s';
    this.setBusy(true);
    this.callbacks.status.set('下载', filename, '正在检测下载地址');
    try {
      const mirrors = this.mirrorsInput.value.split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await window.nyxel.download.start({
        url,
        mirrors,
        directory,
        filename,
        threads: Number(this.threadsSelect.value) || 0
      });
      if (result.ok && result.output) {
        this.lastOutput = result.output;
        this.statusText.textContent = '下载完成';
        this.percentText.textContent = '100%';
        this.progressBar.style.width = '100%';
        this.resultBox.textContent = `${result.output}${result.size ? ` · ${this.formatBytes(result.size)}` : ''}`;
        this.resultBox.classList.remove('hidden');
        this.showButton.classList.remove('hidden');
        this.callbacks.toast(`下载完成：${result.output}`, 'success');
        this.callbacks.status.set('下载', filename, `完成 · ${result.size ? this.formatBytes(result.size) : ''}`);
      } else if (result.cancelled) {
        this.statusText.textContent = '已取消';
        this.callbacks.toast('已取消下载', 'info');
        this.callbacks.status.set('下载', filename, '已取消');
      } else {
        this.statusText.textContent = '下载失败';
        this.resultBox.textContent = result.error ?? '未知错误';
        this.resultBox.classList.remove('hidden');
        this.callbacks.toast(`下载失败：${result.error ?? '未知错误'}`, 'error');
        this.callbacks.status.set('下载', filename, '下载失败');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusText.textContent = '下载失败';
      this.resultBox.textContent = message;
      this.resultBox.classList.remove('hidden');
      this.callbacks.toast(`下载失败：${message}`, 'error');
    } finally {
      this.setBusy(false);
      this.progressBox.classList.toggle('hidden', !this.lastOutput && !this.resultBox.textContent);
    }
  }

  private async cancelDownload(): Promise<void> {
    if (!this.busy) return;
    this.cancelButton.disabled = true;
    try {
      await window.nyxel.download.cancel();
      this.statusText.textContent = '正在取消…';
    } finally {
      this.cancelButton.disabled = false;
    }
  }

  private renderProgress(progress: DownloadProgress): void {
    if (progress.phase === 'probe') {
      this.statusText.textContent = progress.message ?? '正在检测服务器…';
      this.progressBox.classList.remove('hidden');
      return;
    }
    if (progress.phase === 'done') {
      this.progressBar.style.width = '100%';
      this.percentText.textContent = '100%';
      this.statusText.textContent = '下载完成';
      if (progress.total > 0) this.bytesText.textContent = `${this.formatBytes(progress.downloaded)} / ${this.formatBytes(progress.total)}`;
      this.speedText.textContent = `${this.formatBytes(progress.speed)}/s`;
      this.threadsText.textContent = `${progress.threads} 线程`;
      return;
    }
    if (progress.phase === 'cancel') {
      this.statusText.textContent = '已取消';
      return;
    }
    if (progress.phase === 'error') {
      this.statusText.textContent = progress.message ?? '下载失败';
      return;
    }
    this.progressBox.classList.remove('hidden');
    this.progressBar.style.width = `${progress.percent.toFixed(1)}%`;
    this.percentText.textContent = `${progress.percent.toFixed(1)}%`;
    this.statusText.textContent = progress.message ?? '正在下载…';
    this.bytesText.textContent = `${this.formatBytes(progress.downloaded)} / ${progress.total ? this.formatBytes(progress.total) : '未知大小'}`;
    this.speedText.textContent = `${this.formatBytes(progress.speed)}/s`;
    this.threadsText.textContent = `${progress.threads} 线程`;
  }

  private formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(index === 0 ? 0 : size >= 100 ? 0 : 1)} ${units[index]}`;
  }
}

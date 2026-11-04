import type { VideoNoteDocument, VideoNoteMeta, ViewCallbacks } from '../types';
import { formatTime } from '../utils';

type NoteTool = 'brush' | 'highlighter' | 'eraser';

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 1400;
const HISTORY_LIMIT = 25;
const ENABLED_KEY = 'nyxel.videoNotebook.enabled';

export class VideoNotebook {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private getCurrentTime: () => number;
  private getVideo: () => HTMLVideoElement | null;
  private enabled = localStorage.getItem(ENABLED_KEY) === '1';
  private videoPath = '';
  private videoName = '';
  private notePath = '';
  private note: VideoNoteDocument | null = null;
  private saveTimer = 0;
  private saving = false;
  private saveAgain = false;

  private toggle: HTMLInputElement;
  private videoLabel: HTMLElement;
  private offPanel: HTMLElement;
  private enabledPanel: HTMLElement;
  private list: HTMLElement;
  private editor: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private textArea: HTMLElement;
  private saveState: HTMLElement;
  private savedTextRange: Range | null = null;
  private colorInput: HTMLInputElement;
  private widthInput: HTMLInputElement;
  private widthValue: HTMLElement;
  private drawPane: HTMLElement;
  private textPane: HTMLElement;
  private tabButtons: HTMLButtonElement[];

  private tool: NoteTool = 'brush';
  private color = '#e7b95e';
  private lineWidth = 4;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private restoreToken = 0;

  constructor(
    container: HTMLElement,
    callbacks: ViewCallbacks,
    getCurrentTime: () => number,
    getVideo: () => HTMLVideoElement | null
  ) {
    this.element = container;
    this.callbacks = callbacks;
    this.getCurrentTime = getCurrentTime;
    this.getVideo = getVideo;
    this.element.innerHTML = `
      <header class="notebook-head">
        <div class="notebook-title">
          <strong>视频记事本</strong>
          <span id="notebook-video">未加载视频</span>
        </div>
        <label class="notebook-switch" title="默认关闭">
          <input id="notebook-enabled" type="checkbox">
          <span></span>
        </label>
      </header>
      <div class="notebook-off" id="notebook-off">
        <div class="notebook-off-icon">✎</div>
        <strong>复盘记事本默认关闭</strong>
        <p>开启右上角开关后，点击「开始复盘」才会创建记事本文档。</p>
      </div>
      <div class="notebook-enabled-panel hidden" id="notebook-enabled-panel">
        <div class="notebook-actions">
          <button type="button" class="primary" data-note-start>开始复盘</button>
          <button type="button" data-note-dir>打开目录</button>
        </div>
        <div class="notebook-list-title">这个视频的复盘</div>
        <div class="notebook-list" id="notebook-list"></div>
      </div>
      <div class="notebook-editor hidden" id="notebook-editor">
        <div class="notebook-editor-head">
          <button type="button" class="notebook-back" data-note-back>‹ 返回</button>
          <span id="notebook-save-state">未保存</span>
        </div>
        <div class="notebook-tabs">
          <button type="button" class="active" data-note-tab="draw">画面</button>
          <button type="button" data-note-tab="text">文字</button>
        </div>
        <div class="notebook-draw-pane" id="notebook-draw-pane">
          <div class="notebook-tools">
            <button type="button" class="note-capture-button" data-note-capture>截取当前画面</button>
            <button type="button" class="active" data-note-tool="brush">画笔</button>
            <button type="button" data-note-tool="highlighter">荧光笔</button>
            <button type="button" data-note-tool="eraser">橡皮</button>
            <input id="note-color" type="color" value="#e7b95e" title="画笔颜色">
            <input id="note-width" type="range" min="1" max="36" step="1" value="4" title="画笔粗细">
            <span id="note-width-value">4</span>
            <button type="button" data-note-undo>撤销</button>
            <button type="button" data-note-redo>重做</button>
            <button type="button" data-note-clear>清空</button>
          </div>
          <div class="notebook-canvas-wrap">
            <canvas id="note-canvas" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
          </div>
        </div>
        <div class="notebook-text-pane hidden" id="notebook-text-pane">
          <div class="notebook-text-tools">
            <button type="button" data-note-block="h2">大标题</button>
            <button type="button" data-note-block="h3">小标题</button>
            <button type="button" data-note-block="p">正文</button>
            <button type="button" data-note-underline><u>下划线</u></button>
            <button type="button" data-note-bullet>• 列表</button>
            <button type="button" data-note-number>1. 列表</button>
            <button type="button" data-note-divider>分隔线</button>
            <input id="note-text-color" type="color" value="#e7b95e" title="文字颜色">
            <div class="notebook-text-colors">
              <button type="button" data-note-text-color="#f4f6f8" style="--c:#f4f6f8" title="白色"></button>
              <button type="button" data-note-text-color="#f3c969" style="--c:#f3c969" title="黄色"></button>
              <button type="button" data-note-text-color="#8fffc4" style="--c:#8fffc4" title="绿色"></button>
              <button type="button" data-note-text-color="#ff9a9a" style="--c:#ff9a9a" title="红色"></button>
            </div>
          </div>
          <div id="note-text" class="notebook-rich-text" contenteditable="true" spellcheck="false" data-placeholder="写下复盘笔记…"></div>
          <div class="notebook-text-actions">
            <button type="button" data-note-time>插入当前视频时间</button>
          </div>
        </div>
      </div>
    `;

    this.toggle = this.element.querySelector('#notebook-enabled') as HTMLInputElement;
    this.videoLabel = this.element.querySelector('#notebook-video') as HTMLElement;
    this.offPanel = this.element.querySelector('#notebook-off') as HTMLElement;
    this.enabledPanel = this.element.querySelector('#notebook-enabled-panel') as HTMLElement;
    this.list = this.element.querySelector('#notebook-list') as HTMLElement;
    this.editor = this.element.querySelector('#notebook-editor') as HTMLElement;
    this.canvas = this.element.querySelector('#note-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.textArea = this.element.querySelector('#note-text') as HTMLElement;
    this.saveState = this.element.querySelector('#notebook-save-state') as HTMLElement;
    this.colorInput = this.element.querySelector('#note-color') as HTMLInputElement;
    this.widthInput = this.element.querySelector('#note-width') as HTMLInputElement;
    this.widthValue = this.element.querySelector('#note-width-value') as HTMLElement;
    this.drawPane = this.element.querySelector('#notebook-draw-pane') as HTMLElement;
    this.textPane = this.element.querySelector('#notebook-text-pane') as HTMLElement;
    this.tabButtons = Array.from(this.element.querySelectorAll<HTMLButtonElement>('[data-note-tab]'));

    this.toggle.checked = this.enabled;
    this.initCanvas();
    this.bindEvents();
    this.renderState();
  }

  async setVideo(videoPath: string, videoName: string): Promise<void> {
    await this.saveNow();
    this.videoPath = videoPath;
    this.videoName = videoName;
    this.notePath = '';
    this.note = null;
    this.videoLabel.textContent = videoName || '未加载视频';
    this.editor.classList.add('hidden');
    this.textArea.innerHTML = '';
    this.savedTextRange = null;
    this.initCanvas();
    this.renderState();
    if (this.enabled) await this.refreshNotes();
  }

  async close(): Promise<void> {
    await this.saveNow();
    this.videoPath = '';
    this.videoName = '';
    this.notePath = '';
    this.note = null;
    this.editor.classList.add('hidden');
    this.videoLabel.textContent = '未加载视频';
  }

  private bindEvents(): void {
    this.toggle.addEventListener('change', () => {
      this.enabled = this.toggle.checked;
      localStorage.setItem(ENABLED_KEY, this.enabled ? '1' : '0');
      if (!this.enabled) {
        void this.saveNow();
        this.notePath = '';
        this.note = null;
        this.editor.classList.add('hidden');
      }
      this.renderState();
      if (this.enabled) void this.refreshNotes();
    });

    this.element.querySelector('[data-note-start]')?.addEventListener('click', () => void this.startNote());
    this.element.querySelector('[data-note-dir]')?.addEventListener('click', () => void this.openDir());
    this.element.querySelector('[data-note-back]')?.addEventListener('click', () => {
      void this.saveNow();
      this.editor.classList.add('hidden');
      this.enabledPanel.classList.remove('hidden');
      if (this.enabled) void this.refreshNotes();
    });

    this.element.querySelectorAll<HTMLElement>('[data-note-tool]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tool = (button.dataset.noteTool as NoteTool) || 'brush';
        this.element.querySelectorAll('[data-note-tool]').forEach((item) => {
          item.classList.toggle('active', item === button);
        });
        this.canvas.style.cursor = this.tool === 'eraser' ? 'cell' : 'crosshair';
      });
    });
    this.element.querySelector('[data-note-capture]')?.addEventListener('click', () => void this.captureFrame(true));

    this.tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const tab = button.dataset.noteTab;
        this.tabButtons.forEach((item) => item.classList.toggle('active', item === button));
        this.drawPane.classList.toggle('hidden', tab !== 'draw');
        this.textPane.classList.toggle('hidden', tab !== 'text');
        if (tab === 'text') {
          this.textArea.focus();
          this.restoreTextSelection();
        }
      });
    });

    const preserveTextSelection = (event: MouseEvent): void => {
      this.captureTextSelection();
      event.preventDefault();
    };
    this.element.querySelectorAll<HTMLElement>('[data-note-block]').forEach((button) => {
      button.addEventListener('mousedown', preserveTextSelection);
      button.addEventListener('click', () => this.applyTextBlock(button.dataset.noteBlock ?? 'p'));
    });
    (this.element.querySelector('[data-note-underline]') as HTMLElement | null)?.addEventListener('mousedown', preserveTextSelection);
    (this.element.querySelector('[data-note-underline]') as HTMLElement | null)?.addEventListener('click', () => this.runTextCommand('underline'));
    (this.element.querySelector('[data-note-bullet]') as HTMLElement | null)?.addEventListener('mousedown', preserveTextSelection);
    (this.element.querySelector('[data-note-bullet]') as HTMLElement | null)?.addEventListener('click', () => this.runTextCommand('insertUnorderedList'));
    (this.element.querySelector('[data-note-number]') as HTMLElement | null)?.addEventListener('mousedown', preserveTextSelection);
    (this.element.querySelector('[data-note-number]') as HTMLElement | null)?.addEventListener('click', () => this.runTextCommand('insertOrderedList'));
    (this.element.querySelector('[data-note-divider]') as HTMLElement | null)?.addEventListener('mousedown', preserveTextSelection);
    (this.element.querySelector('[data-note-divider]') as HTMLElement | null)?.addEventListener('click', () => this.runTextCommand('insertHorizontalRule'));
    this.element.querySelectorAll<HTMLElement>('[data-note-text-color]').forEach((button) => {
      button.addEventListener('mousedown', preserveTextSelection);
      button.addEventListener('click', () => this.applyTextColor(button.dataset.noteTextColor ?? '#e7b95e'));
    });
    const textColor = this.element.querySelector('#note-text-color') as HTMLInputElement | null;
    textColor?.addEventListener('mousedown', () => this.captureTextSelection());
    textColor?.addEventListener('change', () => this.applyTextColor(textColor.value));

    this.colorInput.addEventListener('input', () => {
      this.color = this.colorInput.value;
      this.tool = 'brush';
      this.element.querySelectorAll('[data-note-tool]').forEach((item) => {
        item.classList.toggle('active', (item as HTMLElement).dataset.noteTool === 'brush');
      });
    });
    this.widthInput.addEventListener('input', () => {
      this.lineWidth = Number(this.widthInput.value) || 4;
      this.widthValue.textContent = String(this.lineWidth);
    });

    this.element.querySelector('[data-note-undo]')?.addEventListener('click', () => this.undo());
    this.element.querySelector('[data-note-redo]')?.addEventListener('click', () => this.redo());
    this.element.querySelector('[data-note-clear]')?.addEventListener('click', () => this.clear());
    this.element.querySelector('[data-note-time]')?.addEventListener('click', () => this.insertTime());

    this.textArea.addEventListener('input', () => this.scheduleSave());
    this.textArea.addEventListener('mouseup', () => this.captureTextSelection());
    this.textArea.addEventListener('keyup', () => this.captureTextSelection());
    this.textArea.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text) this.runTextCommand('insertText', text);
    });
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (selection && selection.rangeCount && this.textArea.contains(selection.anchorNode)) {
        this.savedTextRange = selection.getRangeAt(0).cloneRange();
      }
    });
    this.canvas.addEventListener('pointerdown', (event) => this.startStroke(event));
    this.canvas.addEventListener('pointermove', (event) => this.moveStroke(event));
    this.canvas.addEventListener('pointerup', (event) => this.endStroke(event));
    this.canvas.addEventListener('pointercancel', (event) => this.endStroke(event));
    window.addEventListener('beforeunload', () => { void this.saveNow(); });
  }

  private renderState(): void {
    const hasVideo = Boolean(this.videoPath);
    this.offPanel.classList.toggle('hidden', this.enabled);
    this.enabledPanel.classList.toggle('hidden', !this.enabled || !hasVideo);
    this.offPanel.classList.toggle('hidden', this.enabled || !hasVideo);
    if (!hasVideo) {
      this.offPanel.classList.add('hidden');
      this.enabledPanel.classList.add('hidden');
      return;
    }
    if (this.enabled && !this.editor.classList.contains('hidden')) {
      this.enabledPanel.classList.add('hidden');
    }
  }

  private async refreshNotes(): Promise<void> {
    if (!this.videoPath) return;
    const result = await window.nyxel.notes.list(this.videoPath);
    this.list.innerHTML = '';
    if (!result.ok || !result.notes.length) {
      const empty = document.createElement('div');
      empty.className = 'notebook-list-empty';
      empty.textContent = '还没有复盘记录。点击「开始复盘」新建一份。';
      this.list.append(empty);
      return;
    }
    for (const note of result.notes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notebook-list-item';
      const strong = document.createElement('strong');
      strong.textContent = this.noteLabel(note);
      const span = document.createElement('span');
      span.textContent = note.updatedAt ? `更新 ${formatTime(new Date(note.updatedAt).getTime())}` : '';
      button.append(strong, span);
      button.addEventListener('click', () => void this.openNote(note));
      this.list.append(button);
    }
  }

  private noteLabel(note: VideoNoteMeta): string {
    const time = new Date(note.createdAt || note.updatedAt);
    if (Number.isNaN(time.getTime())) return '复盘记事本';
    const pad = (value: number) => String(value).padStart(2, '0');
    return `复盘 ${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
  }

  private async startNote(): Promise<void> {
    if (!this.videoPath) return;
    const result = await window.nyxel.notes.create(this.videoPath);
    if (!result.ok || !result.note || !result.path) {
      this.callbacks.toast(`新建复盘失败：${result.error ?? '未知错误'}`, 'error');
      return;
    }
    await this.openNote({ ...result.note, path: result.path } as VideoNoteDocument & { path: string });
    await this.captureFrame(false);
  }

  private async openNote(noteOrMeta: (VideoNoteDocument & { path?: string }) | VideoNoteMeta): Promise<void> {
    const notePath = noteOrMeta.path ?? '';
    if (!notePath) return;
    if ('videoPath' in noteOrMeta) {
      await this.showNote(noteOrMeta as VideoNoteDocument, notePath);
      return;
    }
    const result = await window.nyxel.notes.read(notePath);
    if (!result.ok || !result.note) {
      this.callbacks.toast(`打开复盘失败：${result.error ?? '未知错误'}`, 'error');
      return;
    }
    await this.showNote(result.note, result.path ?? notePath);
  }

  private async showNote(note: VideoNoteDocument, notePath: string): Promise<void> {
    this.note = note;
    this.notePath = notePath;
    this.enabledPanel.classList.add('hidden');
    this.editor.classList.remove('hidden');
    this.tabButtons.forEach((button, index) => button.classList.toggle('active', index === 0));
    this.drawPane.classList.remove('hidden');
    this.textPane.classList.add('hidden');
    this.textArea.innerHTML = this.noteToHtml(note);
    this.savedTextRange = null;
    this.saveState.textContent = '已载入';
    await this.loadDrawing(note.drawing ?? '');
  }

  private async loadDrawing(dataUrl: string): Promise<void> {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.history = [];
    this.historyIndex = -1;
    if (dataUrl) {
      await new Promise<void>((resolve) => {
        const image = new Image();
        image.onload = () => {
          this.ctx.drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          resolve();
        };
        image.onerror = () => resolve();
        image.src = dataUrl;
      });
    }
    this.pushHistory(false);
  }

  private initCanvas(): void {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.history = [];
    this.historyIndex = -1;
    this.pushHistory(false);
  }

  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (CANVAS_WIDTH / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (CANVAS_HEIGHT / Math.max(1, rect.height))
    };
  }

  private startStroke(event: PointerEvent): void {
    if (event.button !== 0 || !this.notePath) return;
    event.preventDefault();
    const point = this.pointerPosition(event);
    this.drawing = true;
    this.lastX = point.x;
    this.lastY = point.y;
    this.canvas.setPointerCapture(event.pointerId);
    this.strokeStyle(point.x, point.y);
  }

  private strokeStyle(x: number, y: number): void {
    this.ctx.save();
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = this.tool === 'eraser' ? '#ffffff' : this.color;
    this.ctx.fillStyle = this.ctx.strokeStyle;
    this.ctx.globalAlpha = this.tool === 'highlighter' ? 0.35 : 1;
    this.ctx.lineWidth = this.tool === 'highlighter' ? this.lineWidth * 3 : this.lineWidth;
    this.ctx.beginPath();
    this.ctx.arc(x, y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  private moveStroke(event: PointerEvent): void {
    if (!this.drawing) return;
    event.preventDefault();
    const point = this.pointerPosition(event);
    this.ctx.save();
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = this.tool === 'eraser' ? '#ffffff' : this.color;
    this.ctx.globalAlpha = this.tool === 'highlighter' ? 0.35 : 1;
    this.ctx.lineWidth = this.tool === 'highlighter' ? this.lineWidth * 3 : this.lineWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(this.lastX, this.lastY);
    this.ctx.lineTo(point.x, point.y);
    this.ctx.stroke();
    this.ctx.restore();
    this.lastX = point.x;
    this.lastY = point.y;
  }

  private endStroke(event: PointerEvent): void {
    if (!this.drawing) return;
    this.drawing = false;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    this.pushHistory(true);
    this.scheduleSave();
  }

  private pushHistory(schedule: boolean): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.canvas.toDataURL('image/png'));
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
    if (schedule) this.scheduleSave();
  }

  private restoreHistory(index: number): void {
    const dataUrl = this.history[index];
    if (!dataUrl) return;
    const token = ++this.restoreToken;
    const image = new Image();
    image.onload = () => {
      if (token !== this.restoreToken) return;
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      this.ctx.drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      this.historyIndex = index;
      this.scheduleSave();
    };
    image.src = dataUrl;
  }

  private undo(): void {
    if (this.historyIndex <= 0) return;
    this.restoreHistory(this.historyIndex - 1);
  }

  private redo(): void {
    if (this.historyIndex >= this.history.length - 1) return;
    this.restoreHistory(this.historyIndex + 1);
  }

  private clear(): void {
    if (!window.confirm('清空这份记事本的手写内容？')) return;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.pushHistory(true);
  }

  private async captureFrame(confirmReplace: boolean): Promise<boolean> {
    if (!this.notePath) return false;
    const video = this.getVideo();
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      this.callbacks.toast('视频画面还没有准备好，请等画面加载后再试', 'info');
      return false;
    }
    if (confirmReplace && !window.confirm('重新截取当前画面会替换当前涂鸦，继续？')) return false;
    try {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      const margin = 36;
      const maxWidth = CANVAS_WIDTH - margin * 2;
      const maxHeight = CANVAS_HEIGHT - margin * 2;
      const scale = Math.min(maxWidth / video.videoWidth, maxHeight / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      this.ctx.drawImage(
        video,
        (CANVAS_WIDTH - width) / 2,
        (CANVAS_HEIGHT - height) / 2,
        width,
        height
      );
      this.pushHistory(false);
      this.saveState.textContent = '已截取当前画面';
      this.scheduleSave();
      return true;
    } catch (error) {
      this.callbacks.toast(
        `截取当前画面失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
      return false;
    }
  }

  private captureTextSelection(): void {
    const selection = window.getSelection();
    if (selection && selection.rangeCount && this.textArea.contains(selection.anchorNode)) {
      this.savedTextRange = selection.getRangeAt(0).cloneRange();
    }
  }

  private restoreTextSelection(): void {
    if (!this.savedTextRange) return;
    this.textArea.focus();
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(this.savedTextRange);
  }

  private runTextCommand(command: string, value?: string): void {
    this.restoreTextSelection();
    this.textArea.focus();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(command, false, value);
    this.captureTextSelection();
    this.scheduleSave();
  }

  private applyTextBlock(tag: string): void {
    this.restoreTextSelection();
    this.textArea.focus();
    document.execCommand('formatBlock', false, tag);
    this.captureTextSelection();
    this.scheduleSave();
  }

  private applyTextColor(color: string): void {
    this.restoreTextSelection();
    this.textArea.focus();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand('foreColor', false, color);
    this.captureTextSelection();
    this.scheduleSave();
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private noteToHtml(note: VideoNoteDocument): string {
    const html = (note.textHtml ?? '').trim();
    if (html) return this.sanitizeNoteHtml(html);
    return this.escapeHtml(note.text ?? '').replace(/\r?\n/g, '<br>');
  }

  private sanitizeNoteHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allowed = new Set([
      'P', 'DIV', 'BR', 'H2', 'H3', 'UL', 'OL', 'LI', 'SPAN',
      'STRONG', 'B', 'EM', 'I', 'U', 'FONT', 'HR', 'BLOCKQUOTE'
    ]);
    const dangerous = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED']);
    const clean = (parent: Node): void => {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) continue;
        if (node.nodeType !== Node.ELEMENT_NODE) {
          parent.removeChild(node);
          continue;
        }
        const element = node as HTMLElement;
        if (dangerous.has(element.tagName)) {
          parent.removeChild(element);
          continue;
        }
        if (!allowed.has(element.tagName)) {
          parent.replaceChild(document.createTextNode(element.textContent ?? ''), element);
          continue;
        }
        const color = element.style.color;
        const decoration = element.style.textDecorationLine || element.style.textDecoration;
        const fontWeight = element.style.fontWeight;
        const fontStyle = element.style.fontStyle;
        for (const attribute of Array.from(element.attributes)) {
          element.removeAttribute(attribute.name);
        }
        if (color) element.style.color = color;
        if (decoration) element.style.textDecorationLine = decoration;
        if (fontWeight) element.style.fontWeight = fontWeight;
        if (fontStyle) element.style.fontStyle = fontStyle;
        clean(element);
      }
    };
    clean(doc.body);
    return doc.body.innerHTML;
  }

  private insertTime(): void {
    const seconds = Math.max(0, this.getCurrentTime());
    const total = Math.floor(seconds);
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `[${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}] `;
    this.runTextCommand('insertText', stamp);
  }

  private scheduleSave(): void {
    if (!this.notePath) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveState.textContent = '未保存';
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 900);
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = 0;
    }
    if (!this.notePath || !this.note || this.saving) {
      if (this.saving) this.saveAgain = true;
      return;
    }
    this.saving = true;
    this.saveState.textContent = '保存中…';
    try {
      const result = await window.nyxel.notes.save(this.notePath, {
        text: this.textArea.innerText,
        textHtml: this.textArea.innerHTML,
        drawing: this.canvas.toDataURL('image/png')
      });
      if (result.ok && result.note) {
        this.note = result.note;
        this.saveState.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      } else {
        this.saveState.textContent = '保存失败';
        this.callbacks.toast(`保存复盘失败：${result.error ?? '未知错误'}`, 'error');
      }
    } catch (error) {
      this.saveState.textContent = '保存失败';
      this.callbacks.toast(`保存复盘失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.saving = false;
      if (this.saveAgain) {
        this.saveAgain = false;
        void this.saveNow();
      }
    }
  }

  private async openDir(): Promise<void> {
    const result = await window.nyxel.notes.openDir();
    if (!result.ok) this.callbacks.toast(`打开目录失败：${result.error ?? '未知错误'}`, 'error');
  }
}

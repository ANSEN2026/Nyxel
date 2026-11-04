import type { VideoNoteDocument, VideoNoteImageRect, VideoNoteMeta, ViewCallbacks } from '../types';
import { formatTime } from '../utils';

type NoteTool = 'brush' | 'highlighter' | 'eraser';

const CANVAS_MAX_SIDE = 1600;
const DEFAULT_CANVAS_WIDTH = 1600;
const DEFAULT_CANVAS_HEIGHT = 900;
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
  private listMenu: HTMLElement;
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
  private expandButton: HTMLButtonElement;
  private transformButton: HTMLButtonElement;
  private artboard: HTMLElement;
  private imageLayer: HTMLImageElement;
  private transformLayer: HTMLElement;
  private transformBox: HTMLElement;
  private drawExpanded = false;
  private imageData = '';
  private imageRect: VideoNoteImageRect = {
    x: 0,
    y: 0,
    width: DEFAULT_CANVAS_WIDTH,
    height: DEFAULT_CANVAS_HEIGHT
  };
  private transformMode = false;
  private transformStartRect: VideoNoteImageRect | null = null;
  private transformDrag: {
    mode: 'move' | 'scale';
    handle: string;
    startX: number;
    startY: number;
    rect: VideoNoteImageRect;
  } | null = null;
  private viewBadge: HTMLButtonElement;
  private viewZoomLabel: HTMLElement;
  private railColorInput: HTMLInputElement;
  private railWidthInput: HTMLInputElement;
  private railWidthValue: HTMLElement;
  private railColorPreview: HTMLElement;
  private viewZoom = 1;
  private viewPanX = 0;
  private viewPanY = 0;
  private viewPanning = false;
  private viewPanLastX = 0;
  private viewPanLastY = 0;
  private spaceHeld = false;

  private tool: NoteTool = 'brush';
  private color = '#e7b95e';
  private lineWidth = 4;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private restoreToken = 0;

  private onNotebookKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !this.listMenu.classList.contains('hidden')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.hideNoteContext();
      return;
    }
    if (!this.notePath || this.editor.classList.contains('hidden') || this.drawPane.classList.contains('hidden')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '0') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.resetViewZoom();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggleTransformMode();
      return;
    }
    if (this.transformMode && event.key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.applyTransformMode();
      return;
    }
    if (event.key !== 'Escape') return;
    if (this.transformMode) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.cancelTransformMode();
      return;
    }
    if (!this.drawExpanded) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.setDrawExpanded(false);
  };

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
            <button type="button" class="note-expand-button" data-note-expand title="放大绘制画面（全屏）">⤢ 放大</button>
            <button type="button" class="note-transform-button" data-note-transform title="自由缩放截图图层（Ctrl+T）">⤡ 缩放</button>
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
          <div class="notebook-rail" aria-label="绘画工具">
            <div class="notebook-rail-label">工具</div>
            <button type="button" class="active" data-note-tool="brush" title="画笔">✎</button>
            <button type="button" data-note-tool="highlighter" title="荧光笔">▮</button>
            <button type="button" data-note-tool="eraser" title="橡皮">⌫</button>
            <div class="notebook-rail-sep"></div>
            <button type="button" data-rail-undo title="撤销">↶</button>
            <button type="button" data-rail-redo title="重做">↷</button>
            <button type="button" data-rail-clear title="清空涂鸦">⌧</button>
          </div>
          <div class="notebook-canvas-wrap">
            <div class="notebook-artboard" id="notebook-artboard">
              <img id="note-image-layer" alt="" draggable="false">
              <canvas id="note-canvas" width="${DEFAULT_CANVAS_WIDTH}" height="${DEFAULT_CANVAS_HEIGHT}"></canvas>
              <div class="note-transform-layer hidden" id="note-transform-layer">
                <div class="note-transform-box" id="note-transform-box">
                  <span class="note-transform-handle" data-transform-handle="nw"></span>
                  <span class="note-transform-handle" data-transform-handle="ne"></span>
                  <span class="note-transform-handle" data-transform-handle="sw"></span>
                  <span class="note-transform-handle" data-transform-handle="se"></span>
                </div>
                <div class="note-transform-bar">
                  <span>拖动角缩放 · 拖动框移动 · Enter 应用 · Esc 取消</span>
                  <button type="button" data-transform-cancel>取消</button>
                  <button type="button" class="primary" data-transform-apply>应用</button>
                </div>
              </div>
            </div>
            <button class="notebook-view-badge hidden" id="note-view-badge" type="button" title="适应画布">100%</button>
          </div>
          <aside class="notebook-inspector" aria-label="绘画属性">
            <section class="notebook-panel">
              <h4>颜色</h4>
              <div class="notebook-color-control">
                <span class="notebook-color-preview" data-note-color-preview></span>
                <input type="color" value="#e7b95e" data-note-color title="画笔颜色">
              </div>
              <div class="notebook-swatches">
                <button type="button" style="--swatch:#f4f6f8" data-note-swatch="#f4f6f8" title="白色"></button>
                <button type="button" style="--swatch:#e7b95e" data-note-swatch="#e7b95e" title="黄色"></button>
                <button type="button" style="--swatch:#8fffc4" data-note-swatch="#8fffc4" title="绿色"></button>
                <button type="button" style="--swatch:#ff9a9a" data-note-swatch="#ff9a9a" title="红色"></button>
                <button type="button" style="--swatch:#7dd3fc" data-note-swatch="#7dd3fc" title="蓝色"></button>
                <button type="button" style="--swatch:#1f1f1f" data-note-swatch="#1f1f1f" title="黑色"></button>
              </div>
            </section>
            <section class="notebook-panel">
              <h4>画笔</h4>
              <div class="notebook-panel-row">
                <span>大小</span>
                <input type="range" min="1" max="36" step="1" value="4" data-note-width>
                <strong data-note-width-value>4</strong>
              </div>
            </section>
            <section class="notebook-panel">
              <h4>图层</h4>
              <div class="notebook-layer-row">
                <span class="notebook-layer-icon">▧</span>
                <span>截图</span>
                <small>image</small>
              </div>
              <div class="notebook-layer-row">
                <span class="notebook-layer-icon">✎</span>
                <span>涂鸦</span>
                <small>drawing</small>
              </div>
            </section>
            <section class="notebook-panel">
              <h4>视图</h4>
              <div class="notebook-view-row">
                <span>缩放</span>
                <strong id="note-view-zoom">100%</strong>
                <button type="button" data-view-fit>适应</button>
              </div>
              <p class="notebook-view-hint">Alt + 滚轮缩放 · 空格拖动</p>
            </section>
          </aside>
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
      <div class="context-menu notebook-context-menu hidden" id="notebook-context-menu"></div>
    `;

    this.toggle = this.element.querySelector('#notebook-enabled') as HTMLInputElement;
    this.videoLabel = this.element.querySelector('#notebook-video') as HTMLElement;
    this.offPanel = this.element.querySelector('#notebook-off') as HTMLElement;
    this.enabledPanel = this.element.querySelector('#notebook-enabled-panel') as HTMLElement;
    this.list = this.element.querySelector('#notebook-list') as HTMLElement;
    this.listMenu = this.element.querySelector('#notebook-context-menu') as HTMLElement;
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
    this.expandButton = this.element.querySelector('[data-note-expand]') as HTMLButtonElement;
    this.transformButton = this.element.querySelector('[data-note-transform]') as HTMLButtonElement;
    this.artboard = this.element.querySelector('#notebook-artboard') as HTMLElement;
    this.imageLayer = this.element.querySelector('#note-image-layer') as HTMLImageElement;
    this.transformLayer = this.element.querySelector('#note-transform-layer') as HTMLElement;
    this.transformBox = this.element.querySelector('#note-transform-box') as HTMLElement;
    this.viewBadge = this.element.querySelector('#note-view-badge') as HTMLButtonElement;
    this.viewZoomLabel = this.element.querySelector('#note-view-zoom') as HTMLElement;
    this.railColorInput = this.element.querySelector('[data-note-color]') as HTMLInputElement;
    this.railWidthInput = this.element.querySelector('[data-note-width]') as HTMLInputElement;
    this.railWidthValue = this.element.querySelector('[data-note-width-value]') as HTMLElement;
    this.railColorPreview = this.element.querySelector('[data-note-color-preview]') as HTMLElement;

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
    this.setDrawExpanded(false);
    this.hideNoteContext();
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
    this.setDrawExpanded(false);
    this.hideNoteContext();
    this.videoLabel.textContent = '未加载视频';
  }

  private setDrawExpanded(expanded: boolean): void {
    if (this.drawExpanded === expanded) return;
    this.cancelTransformMode();
    this.drawExpanded = expanded;
    this.drawPane.classList.toggle('is-expanded', expanded);
    this.resetViewZoom();
    this.expandButton.classList.toggle('active', expanded);
    this.expandButton.setAttribute('aria-pressed', String(expanded));
    this.expandButton.textContent = expanded ? '↙ 还原' : '⤢ 放大';
    this.expandButton.title = expanded ? '还原绘制画面（Esc）' : '放大绘制画面（全屏）';
    if (expanded) {
      requestAnimationFrame(() => this.layoutArtboard());
    } else {
      this.artboard.style.width = '';
      this.artboard.style.height = '';
    }
  }

  private layoutArtboard(): void {
    if (!this.drawExpanded) return;
    const wrap = this.artboard.parentElement as HTMLElement | null;
    if (!wrap) return;
    const availableWidth = Math.max(1, wrap.clientWidth);
    const availableHeight = Math.max(1, wrap.clientHeight);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    let width = availableWidth;
    let height = width / aspect;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * aspect;
    }
    this.artboard.style.width = `${Math.floor(width)}px`;
    this.artboard.style.height = `${Math.floor(height)}px`;
  }

  private viewportOf(): HTMLElement {
    return this.artboard.parentElement as HTMLElement;
  }

  private applyViewZoom(): void {
    this.artboard.style.transformOrigin = 'center center';
    this.artboard.style.transform = this.viewZoom === 1 && this.viewPanX === 0 && this.viewPanY === 0
      ? ''
      : `translate(${this.viewPanX}px, ${this.viewPanY}px) scale(${this.viewZoom})`;
    const label = `${Math.round(this.viewZoom * 100)}%`;
    this.viewZoomLabel.textContent = label;
    this.viewBadge.textContent = label;
    this.viewBadge.classList.toggle('hidden', this.viewZoom === 1 && this.viewPanX === 0 && this.viewPanY === 0);
  }

  private resetViewZoom(): void {
    this.viewZoom = 1;
    this.viewPanX = 0;
    this.viewPanY = 0;
    this.viewPanning = false;
    this.spaceHeld = false;
    this.viewportOf().classList.remove('is-pan-ready', 'is-panning');
    this.applyViewZoom();
  }

  private zoomViewAt(clientX: number, clientY: number, nextZoom: number): void {
    const zoom = Math.max(0.25, Math.min(8, nextZoom));
    if (Math.abs(zoom - this.viewZoom) < 0.001) return;
    const before = this.artboard.getBoundingClientRect();
    const u = (clientX - before.left) / Math.max(1, before.width);
    const v = (clientY - before.top) / Math.max(1, before.height);
    this.viewZoom = zoom;
    if (zoom <= 1.001) {
      this.viewPanX = 0;
      this.viewPanY = 0;
      this.applyViewZoom();
      return;
    }
    this.applyViewZoom();
    const after = this.artboard.getBoundingClientRect();
    this.viewPanX += clientX - (after.left + u * after.width);
    this.viewPanY += clientY - (after.top + v * after.height);
    this.applyViewZoom();
  }

  private startViewPan(event: PointerEvent): void {
    if (!this.spaceHeld || !this.isDrawingActive()) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.viewZoom <= 1.001) return;
    this.viewPanning = true;
    this.viewPanLastX = event.clientX;
    this.viewPanLastY = event.clientY;
    this.viewportOf().setPointerCapture(event.pointerId);
    this.viewportOf().classList.add('is-panning');
  }

  private moveViewPan(event: PointerEvent): void {
    if (!this.viewPanning) return;
    event.preventDefault();
    this.viewPanX += event.clientX - this.viewPanLastX;
    this.viewPanY += event.clientY - this.viewPanLastY;
    this.viewPanLastX = event.clientX;
    this.viewPanLastY = event.clientY;
    this.applyViewZoom();
  }

  private endViewPan(event: PointerEvent): void {
    if (!this.viewPanning) return;
    this.viewPanning = false;
    this.viewportOf().classList.remove('is-panning');
    try { this.viewportOf().releasePointerCapture(event.pointerId); } catch { /* released */ }
  }

  private isDrawingActive(): boolean {
    return Boolean(this.notePath) && !this.editor.classList.contains('hidden') && !this.drawPane.classList.contains('hidden');
  }

  private syncColorControls(): void {
    this.colorInput.value = this.color;
    this.railColorInput.value = this.color;
    this.railColorPreview.style.background = this.color;
  }

  private syncWidthControls(): void {
    this.widthInput.value = String(this.lineWidth);
    this.railWidthInput.value = String(this.lineWidth);
    this.widthValue.textContent = String(this.lineWidth);
    this.railWidthValue.textContent = String(this.lineWidth);
  }

  private renderImageLayer(): void {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const rect = this.imageRect;
    if (this.imageData) {
      if (this.imageLayer.getAttribute('src') !== this.imageData) this.imageLayer.src = this.imageData;
      this.imageLayer.hidden = false;
    } else {
      this.imageLayer.hidden = true;
      this.imageLayer.removeAttribute('src');
    }
    this.imageLayer.style.left = `${(rect.x / width) * 100}%`;
    this.imageLayer.style.top = `${(rect.y / height) * 100}%`;
    this.imageLayer.style.width = `${(rect.width / width) * 100}%`;
    this.imageLayer.style.height = `${(rect.height / height) * 100}%`;
  }

  private renderTransformBox(): void {
    if (!this.transformMode) return;
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const rect = this.imageRect;
    this.transformBox.style.left = `${(rect.x / width) * 100}%`;
    this.transformBox.style.top = `${(rect.y / height) * 100}%`;
    this.transformBox.style.width = `${(rect.width / width) * 100}%`;
    this.transformBox.style.height = `${(rect.height / height) * 100}%`;
  }

  private startTransformMode(): void {
    if (!this.notePath) return;
    if (!this.imageData) {
      this.callbacks.toast('当前还没有可缩放的截图', 'info');
      return;
    }
    this.transformMode = true;
    this.transformStartRect = { ...this.imageRect };
    this.transformLayer.classList.remove('hidden');
    this.transformButton.classList.add('active');
    this.transformButton.title = '应用截图变换（Ctrl+T）';
    this.renderImageLayer();
    this.renderTransformBox();
  }

  private applyTransformMode(): void {
    if (!this.transformMode) return;
    this.transformMode = false;
    this.transformDrag = null;
    this.transformStartRect = null;
    this.transformLayer.classList.add('hidden');
    this.transformButton.classList.remove('active');
    this.transformButton.title = '自由缩放截图图层（Ctrl+T）';
    this.renderImageLayer();
    this.scheduleSave();
  }

  private cancelTransformMode(): void {
    if (!this.transformMode) return;
    if (this.transformStartRect) this.imageRect = { ...this.transformStartRect };
    this.transformMode = false;
    this.transformDrag = null;
    this.transformStartRect = null;
    this.transformLayer.classList.add('hidden');
    this.transformButton.classList.remove('active');
    this.transformButton.title = '自由缩放截图图层（Ctrl+T）';
    this.renderImageLayer();
  }

  private toggleTransformMode(): void {
    if (this.transformMode) this.applyTransformMode();
    else this.startTransformMode();
  }

  private startTransformDrag(event: PointerEvent): void {
    if (!this.transformMode) return;
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-transform-handle]')?.dataset.transformHandle ?? '';
    if (!handle && target !== this.transformBox) return;
    event.preventDefault();
    event.stopPropagation();
    this.transformDrag = {
      mode: handle ? 'scale' : 'move',
      handle,
      startX: event.clientX,
      startY: event.clientY,
      rect: { ...this.imageRect }
    };
    this.transformLayer.setPointerCapture(event.pointerId);
  }

  private moveTransformDrag(event: PointerEvent): void {
    if (!this.transformDrag) return;
    event.preventDefault();
    const artboardRect = this.artboard.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(1, artboardRect.width);
    const scaleY = this.canvas.height / Math.max(1, artboardRect.height);
    const dx = (event.clientX - this.transformDrag.startX) * scaleX;
    const dy = (event.clientY - this.transformDrag.startY) * scaleY;
    const start = this.transformDrag.rect;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    if (this.transformDrag.mode === 'move') {
      this.imageRect = {
        ...start,
        x: Math.max(0, Math.min(canvasWidth - start.width, start.x + dx)),
        y: Math.max(0, Math.min(canvasHeight - start.height, start.y + dy))
      };
    } else {
      const signX = this.transformDrag.handle.includes('e') ? 1 : -1;
      const signY = this.transformDrag.handle.includes('s') ? 1 : -1;
      const factorX = 1 + (signX * dx) / Math.max(1, start.width);
      const factorY = 1 + (signY * dy) / Math.max(1, start.height);
      const proposed = Math.abs(factorX - 1) >= Math.abs(factorY - 1) ? factorX : factorY;
      const maxFactor = Math.min(canvasWidth / start.width, canvasHeight / start.height);
      const factor = Math.max(0.12, Math.min(maxFactor, proposed));
      const width = start.width * factor;
      const height = start.height * factor;
      const anchorX = this.transformDrag.handle.includes('w') ? start.x + start.width : start.x;
      const anchorY = this.transformDrag.handle.includes('n') ? start.y + start.height : start.y;
      this.imageRect = {
        x: this.transformDrag.handle.includes('w') ? anchorX - width : anchorX,
        y: this.transformDrag.handle.includes('n') ? anchorY - height : anchorY,
        width,
        height
      };
    }
    this.renderImageLayer();
    this.renderTransformBox();
  }

  private endTransformDrag(event: PointerEvent): void {
    if (!this.transformDrag) return;
    this.transformDrag = null;
    try { this.transformLayer.releasePointerCapture(event.pointerId); } catch { /* already released */ }
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
        this.setDrawExpanded(false);
      }
      this.renderState();
      if (this.enabled) void this.refreshNotes();
    });

    this.element.querySelector('[data-note-start]')?.addEventListener('click', () => void this.startNote());
    this.element.querySelector('[data-note-dir]')?.addEventListener('click', () => void this.openDir());

    this.list.addEventListener('contextmenu', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('.notebook-list-item');
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      this.showNoteContext(item, event.clientX, event.clientY);
    });
    this.listMenu.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-note-delete]');
      if (!button) return;
      event.stopPropagation();
      const notePath = this.listMenu.dataset.notePath ?? '';
      this.hideNoteContext();
      void this.deleteNote(notePath);
    });
    document.addEventListener('click', (event) => {
      if (!this.listMenu.contains(event.target as Node)) this.hideNoteContext();
    });
    this.element.addEventListener('scroll', () => this.hideNoteContext(), true);

    this.element.querySelector('[data-note-back]')?.addEventListener('click', () => {
      void this.saveNow();
      this.setDrawExpanded(false);
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
    this.expandButton.addEventListener('click', () => this.setDrawExpanded(!this.drawExpanded));
    this.transformButton.addEventListener('click', () => this.toggleTransformMode());
    this.element.querySelector('[data-transform-apply]')?.addEventListener('click', () => this.applyTransformMode());
    this.element.querySelector('[data-transform-cancel]')?.addEventListener('click', () => this.cancelTransformMode());
    this.transformBox.addEventListener('pointerdown', (event) => this.startTransformDrag(event));
    this.transformLayer.addEventListener('pointermove', (event) => this.moveTransformDrag(event));
    this.transformLayer.addEventListener('pointerup', (event) => this.endTransformDrag(event));
    this.transformLayer.addEventListener('pointercancel', (event) => this.endTransformDrag(event));
    window.addEventListener('keydown', this.onNotebookKey, true);

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

    const applyColor = (color: string): void => {
      this.color = color;
      this.tool = 'brush';
      this.element.querySelectorAll('[data-note-tool]').forEach((item) => {
        item.classList.toggle('active', (item as HTMLElement).dataset.noteTool === 'brush');
      });
      this.syncColorControls();
    };
    this.colorInput.addEventListener('input', () => applyColor(this.colorInput.value));
    this.railColorInput.addEventListener('input', () => applyColor(this.railColorInput.value));
    this.element.querySelectorAll<HTMLElement>('[data-note-swatch]').forEach((button) => {
      button.addEventListener('click', () => applyColor(button.dataset.noteSwatch ?? '#e7b95e'));
    });
    const applyWidth = (value: string): void => {
      this.lineWidth = Number(value) || 4;
      this.syncWidthControls();
    };
    this.widthInput.addEventListener('input', () => applyWidth(this.widthInput.value));
    this.railWidthInput.addEventListener('input', () => applyWidth(this.railWidthInput.value));
    this.syncColorControls();
    this.syncWidthControls();

    this.element.querySelector('[data-note-undo]')?.addEventListener('click', () => this.undo());
    this.element.querySelector('[data-note-redo]')?.addEventListener('click', () => this.redo());
    this.element.querySelector('[data-note-clear]')?.addEventListener('click', () => this.clear());
    this.element.querySelector('[data-rail-undo]')?.addEventListener('click', () => this.undo());
    this.element.querySelector('[data-rail-redo]')?.addEventListener('click', () => this.redo());
    this.element.querySelector('[data-rail-clear]')?.addEventListener('click', () => this.clear());
    this.element.querySelector('[data-note-time]')?.addEventListener('click', () => this.insertTime());

    this.viewBadge.addEventListener('click', () => this.resetViewZoom());
    this.element.querySelector('[data-view-fit]')?.addEventListener('click', () => this.resetViewZoom());
    const viewport = this.viewportOf();
    viewport.addEventListener('wheel', (event) => {
      if (!event.altKey) return;
      event.preventDefault();
      this.zoomViewAt(event.clientX, event.clientY, this.viewZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    viewport.addEventListener('pointerdown', (event) => this.startViewPan(event), true);
    viewport.addEventListener('pointermove', (event) => this.moveViewPan(event));
    viewport.addEventListener('pointerup', (event) => this.endViewPan(event));
    viewport.addEventListener('pointercancel', (event) => this.endViewPan(event));
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Space' || !this.isDrawingActive()) return;
      const target = event.target as HTMLElement;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      this.spaceHeld = true;
      event.preventDefault();
      viewport.classList.add('is-pan-ready');
    }, true);
    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space') return;
      this.spaceHeld = false;
      viewport.classList.remove('is-pan-ready', 'is-panning');
    }, true);
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
      this.viewPanning = false;
      viewport.classList.remove('is-pan-ready', 'is-panning');
    });

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
    window.addEventListener('resize', () => {
      if (this.drawExpanded) this.layoutArtboard();
    });
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
    this.hideNoteContext();
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
      button.dataset.notePath = note.path;
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

  private showNoteContext(item: HTMLElement, x: number, y: number): void {
    const notePath = item.dataset.notePath ?? '';
    if (!notePath) return;
    this.listMenu.dataset.notePath = notePath;
    this.listMenu.innerHTML = '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'danger';
    button.dataset.noteDelete = '1';
    button.textContent = '删除复盘';
    this.listMenu.append(button);
    this.listMenu.classList.remove('hidden');
    const rect = this.listMenu.getBoundingClientRect();
    this.listMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    this.listMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }

  private hideNoteContext(): void {
    this.listMenu.classList.add('hidden');
    delete this.listMenu.dataset.notePath;
  }

  private async deleteNote(notePath: string): Promise<void> {
    if (!notePath) return;
    if (!window.confirm('删除这份复盘记录？文件会移到系统回收站，之后可以恢复。')) return;
    const isCurrent = this.notePath === notePath;
    try {
      if (isCurrent) await this.saveNow();
      const result = await window.nyxel.notes.delete(notePath);
      if (!result.ok) {
        this.callbacks.toast(`删除复盘失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      if (isCurrent) {
        this.notePath = '';
        this.note = null;
        this.editor.classList.add('hidden');
        this.setDrawExpanded(false);
        this.enabledPanel.classList.remove('hidden');
        this.initCanvas();
      }
      await this.refreshNotes();
      this.callbacks.toast('复盘记录已删除，可在系统回收站中恢复', 'success');
    } catch (error) {
      this.callbacks.toast(
        `删除复盘失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
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
    this.setDrawExpanded(false);
    this.editor.classList.remove('hidden');
    this.tabButtons.forEach((button, index) => button.classList.toggle('active', index === 0));
    this.drawPane.classList.remove('hidden');
    this.textPane.classList.add('hidden');
    this.textArea.innerHTML = this.noteToHtml(note);
    this.savedTextRange = null;
    this.saveState.textContent = '已载入';
    await this.loadDrawing(
      note.drawing ?? '',
      note.image ?? '',
      note.imageRect,
      note.canvasWidth,
      note.canvasHeight
    );
  }

  private setCanvasSize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    this.artboard.style.setProperty('--note-aspect', `${nextWidth} / ${nextHeight}`);
    if (this.canvas.width === nextWidth && this.canvas.height === nextHeight) return;
    this.canvas.width = nextWidth;
    this.canvas.height = nextHeight;
    if (this.drawExpanded) requestAnimationFrame(() => this.layoutArtboard());
  }

  private fitCanvasToVideo(): void {
    const video = this.getVideo();
    const videoWidth = video?.videoWidth ?? 0;
    const videoHeight = video?.videoHeight ?? 0;
    if (!(videoWidth > 0 && videoHeight > 0)) {
      this.setCanvasSize(DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT);
      return;
    }
    const aspect = videoWidth / videoHeight;
    if (aspect >= 1) {
      this.setCanvasSize(CANVAS_MAX_SIDE, CANVAS_MAX_SIDE / aspect);
    } else {
      this.setCanvasSize(CANVAS_MAX_SIDE * aspect, CANVAS_MAX_SIDE);
    }
  }

  private async loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
    if (!dataUrl) return null;
    return new Promise<HTMLImageElement | null>((resolve) => {
      const loaded = new Image();
      loaded.onload = () => resolve(loaded);
      loaded.onerror = () => resolve(null);
      loaded.src = dataUrl;
    });
  }

  private async loadDrawing(
    drawingData: string,
    imageData = '',
    imageRect?: VideoNoteImageRect,
    savedCanvasWidth?: number,
    savedCanvasHeight?: number
  ): Promise<void> {
    this.cancelTransformMode();
    this.resetViewZoom();
    const flattenedNote = !imageData && Boolean(drawingData);
    const imageUrl = imageData || drawingData;
    const drawingUrl = flattenedNote ? '' : drawingData;
    const [image, drawing] = await Promise.all([
      this.loadImage(imageUrl),
      this.loadImage(drawingUrl)
    ]);

    if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
      const scale = Math.min(1, CANVAS_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
      this.setCanvasSize(image.naturalWidth * scale, image.naturalHeight * scale);
    } else if (drawing && drawing.naturalWidth > 0 && drawing.naturalHeight > 0) {
      const scale = Math.min(1, CANVAS_MAX_SIDE / Math.max(drawing.naturalWidth, drawing.naturalHeight));
      this.setCanvasSize(drawing.naturalWidth * scale, drawing.naturalHeight * scale);
    } else {
      this.fitCanvasToVideo();
    }

    const width = this.canvas.width;
    const height = this.canvas.height;
    this.imageData = image ? imageUrl : '';
    if (image) {
      const source = imageRect && imageRect.width > 0 && imageRect.height > 0
        ? imageRect
        : { x: 0, y: 0, width, height };
      const sourceWidth = savedCanvasWidth && savedCanvasWidth > 0 ? savedCanvasWidth : width;
      const sourceHeight = savedCanvasHeight && savedCanvasHeight > 0 ? savedCanvasHeight : height;
      this.imageRect = {
        x: source.x * (width / sourceWidth),
        y: source.y * (height / sourceHeight),
        width: source.width * (width / sourceWidth),
        height: source.height * (height / sourceHeight)
      };
    } else {
      this.imageRect = { x: 0, y: 0, width, height };
    }
    this.renderImageLayer();

    this.ctx.clearRect(0, 0, width, height);
    if (drawing) this.ctx.drawImage(drawing, 0, 0, width, height);
    this.history = [];
    this.historyIndex = -1;
    this.pushHistory(false);
  }

  private initCanvas(): void {
    this.cancelTransformMode();
    this.resetViewZoom();
    this.fitCanvasToVideo();
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.imageData = '';
    this.imageRect = { x: 0, y: 0, width, height };
    this.renderImageLayer();
    this.ctx.clearRect(0, 0, width, height);
    this.history = [];
    this.historyIndex = -1;
    this.pushHistory(false);
  }

  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (this.canvas.width / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (this.canvas.height / Math.max(1, rect.height))
    };
  }

  private startStroke(event: PointerEvent): void {
    if (!this.notePath || this.transformMode) return;
    if (event.button !== 0) return;
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
    if (this.tool === 'eraser') {
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.strokeStyle = '#000000';
      this.ctx.fillStyle = '#000000';
      this.ctx.globalAlpha = 1;
    } else {
      this.ctx.strokeStyle = this.color;
      this.ctx.fillStyle = this.color;
      this.ctx.globalAlpha = this.tool === 'highlighter' ? 0.35 : 1;
    }
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
    if (this.tool === 'eraser') {
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.strokeStyle = '#000000';
      this.ctx.globalAlpha = 1;
    } else {
      this.ctx.strokeStyle = this.color;
      this.ctx.globalAlpha = this.tool === 'highlighter' ? 0.35 : 1;
    }
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
      const width = this.canvas.width;
      const height = this.canvas.height;
      this.ctx.clearRect(0, 0, width, height);
      this.ctx.drawImage(image, 0, 0, width, height);
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
    if (!window.confirm('清空这份记事本的涂鸦内容？截图会保留。')) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.ctx.clearRect(0, 0, width, height);
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
      this.cancelTransformMode();
      this.resetViewZoom();
      this.fitCanvasToVideo();
      const width = this.canvas.width;
      const height = this.canvas.height;
      const frame = document.createElement('canvas');
      frame.width = width;
      frame.height = height;
      const frameContext = frame.getContext('2d');
      if (!frameContext) throw new Error('无法创建截图画布');
      frameContext.drawImage(video, 0, 0, width, height);
      this.imageData = frame.toDataURL('image/png');
      this.imageRect = { x: 0, y: 0, width, height };
      this.renderImageLayer();
      this.ctx.clearRect(0, 0, width, height);
      this.history = [];
      this.historyIndex = -1;
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
        drawing: this.canvas.toDataURL('image/png'),
        image: this.imageData,
        imageRect: this.imageRect,
        canvasWidth: this.canvas.width,
        canvasHeight: this.canvas.height
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

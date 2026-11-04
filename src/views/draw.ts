import type { ViewCallbacks } from '../types';
import { mimeFromExt } from '../utils';

const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 1000;
const HISTORY_LIMIT = 30;

type DrawTool = 'brush' | 'eraser';

interface DrawLayer {
  id: string;
  name: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  start: number;
  end: number;
  visible: boolean;
  history: string[];
  historyIndex: number;
}

export class DrawView {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private active = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private colorInput: HTMLInputElement;
  private widthInput: HTMLInputElement;
  private widthValue: HTMLElement;
  private canvasWrap: HTMLElement;
  private viewBadge: HTMLButtonElement;
  private viewZoomLabel: HTMLElement;
  private colorPreview: HTMLElement;
  private viewZoom = 1;
  private viewPanX = 0;
  private viewPanY = 0;
  private viewPanning = false;
  private viewPanLastX = 0;
  private viewPanLastY = 0;
  private spaceHeld = false;
  private tool: DrawTool = 'brush';
  private color = '#8fc3a2';
  private lineWidth = 8;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
  private restoreToken = 0;
  private saving = false;
  private layers: DrawLayer[] = [];
  private selectedLayerId = '';
  private layerCounter = 0;
  private duration = 10;
  private currentTime = 0;
  private playing = false;
  private playFrame = 0;
  private playLast = 0;
  private compositeQueued = false;
  private timelineDrag: {
    mode: 'move' | 'start' | 'end';
    layerId: string;
    startClientX: number;
    start: number;
    end: number;
    trackWidth: number;
  } | null = null;
  private timelineRuler: HTMLElement;
  private timelineTracks: HTMLElement;
  private timelinePlayhead: HTMLElement;
  private timelineTime: HTMLElement;
  private timelineDuration: HTMLInputElement;
  private playButton: HTMLButtonElement;
  private layerList: HTMLElement;

  constructor(callbacks: ViewCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view draw-view';
    this.element.innerHTML = `
      <div class="view-toolbar draw-toolbar">
        <strong class="files-title">绘画</strong>
        <span class="files-sub" id="draw-info">${CANVAS_WIDTH} × ${CANVAS_HEIGHT}</span>
        <span class="spacer"></span>
        <button type="button" data-draw-action="open">打开图片</button>
        <button type="button" class="primary" data-draw-action="save">保存 PNG</button>
      </div>
      <div class="view-body draw-body">
        <div class="draw-rail" aria-label="绘画工具">
          <div class="notebook-rail-label">工具</div>
          <button type="button" class="active" data-draw-tool="brush" title="画笔">✎</button>
          <button type="button" data-draw-tool="eraser" title="橡皮">⌫</button>
          <div class="notebook-rail-sep"></div>
          <button type="button" data-draw-layer-add title="新建空白图层">＋</button>
          <button type="button" data-draw-layer-image title="添加图片图层">▣</button>
          <div class="notebook-rail-sep"></div>
          <button type="button" data-draw-action="undo" title="撤销" disabled>↶</button>
          <button type="button" data-draw-action="redo" title="重做" disabled>↷</button>
          <button type="button" data-draw-action="clear" title="清空当前图层">⌧</button>
        </div>
        <div class="draw-workarea">
          <div class="draw-canvas-wrap" id="draw-canvas-wrap">
            <canvas id="draw-canvas" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
            <button class="notebook-view-badge hidden" id="draw-view-badge" type="button" title="适应画布">100%</button>
          </div>
          <div class="draw-timeline">
            <div class="draw-timeline-bar">
              <button id="draw-timeline-play" type="button" title="播放 / 暂停">▶</button>
              <span id="draw-timeline-time">0:00.0 / 0:10.0</span>
              <label>时长 <input id="draw-timeline-duration" type="number" min="1" max="120" step="1" value="10"> 秒</label>
              <span class="spacer"></span>
              <span class="draw-timeline-hint">拖动色块移动时间 · 拖两端调整出现时长</span>
            </div>
            <div class="draw-timeline-body" id="draw-timeline-body">
              <div class="draw-timeline-scale">
                <div class="draw-timeline-ruler" id="draw-timeline-ruler"></div>
                <div class="draw-timeline-tracks" id="draw-timeline-tracks"></div>
                <div class="draw-timeline-playhead" id="draw-timeline-playhead"></div>
              </div>
            </div>
          </div>
          <div class="draw-foot">
            <span>Alt+滚轮缩放 · 空格拖动 · Ctrl+0 适应 · Ctrl+Z 撤销</span>
            <span class="draw-size">画布 ${CANVAS_WIDTH} × ${CANVAS_HEIGHT}</span>
          </div>
        </div>
        <aside class="draw-inspector" aria-label="绘画属性">
          <section class="notebook-panel">
            <h4>颜色</h4>
            <div class="notebook-color-control">
              <span class="notebook-color-preview" data-draw-color-preview></span>
              <input id="draw-color" type="color" value="#8fc3a2" title="画笔颜色">
            </div>
            <div class="notebook-swatches">
              <button type="button" style="--swatch:#8fc3a2" data-draw-swatch="#8fc3a2" title="绿色"></button>
              <button type="button" style="--swatch:#f4f6f8" data-draw-swatch="#f4f6f8" title="白色"></button>
              <button type="button" style="--swatch:#e7b95e" data-draw-swatch="#e7b95e" title="黄色"></button>
              <button type="button" style="--swatch:#ff9a9a" data-draw-swatch="#ff9a9a" title="红色"></button>
              <button type="button" style="--swatch:#7dd3fc" data-draw-swatch="#7dd3fc" title="蓝色"></button>
              <button type="button" style="--swatch:#1f1f1f" data-draw-swatch="#1f1f1f" title="黑色"></button>
            </div>
          </section>
          <section class="notebook-panel">
            <h4>画笔</h4>
            <div class="notebook-panel-row">
              <span>大小</span>
              <input id="draw-width" type="range" min="1" max="60" step="1" value="8">
              <strong id="draw-width-value">8</strong>
            </div>
          </section>
          <section class="notebook-panel">
            <h4>图层</h4>
            <div class="draw-layer-list" id="draw-layer-list"></div>
          </section>
          <section class="notebook-panel">
            <h4>视图</h4>
            <div class="notebook-view-row">
              <span>缩放</span>
              <strong id="draw-view-zoom">100%</strong>
              <button type="button" data-draw-view-fit>适应</button>
            </div>
            <p class="notebook-view-hint">Alt + 滚轮缩放 · 空格拖动</p>
          </section>
        </aside>
      </div>
    `;

    this.canvas = this.element.querySelector('#draw-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.colorInput = this.element.querySelector('#draw-color') as HTMLInputElement;
    this.widthInput = this.element.querySelector('#draw-width') as HTMLInputElement;
    this.widthValue = this.element.querySelector('#draw-width-value') as HTMLElement;
    this.canvasWrap = this.element.querySelector('#draw-canvas-wrap') as HTMLElement;
    this.viewBadge = this.element.querySelector('#draw-view-badge') as HTMLButtonElement;
    this.viewZoomLabel = this.element.querySelector('#draw-view-zoom') as HTMLElement;
    this.colorPreview = this.element.querySelector('[data-draw-color-preview]') as HTMLElement;
    this.timelineRuler = this.element.querySelector('#draw-timeline-ruler') as HTMLElement;
    this.timelineTracks = this.element.querySelector('#draw-timeline-tracks') as HTMLElement;
    this.timelinePlayhead = this.element.querySelector('#draw-timeline-playhead') as HTMLElement;
    this.timelineTime = this.element.querySelector('#draw-timeline-time') as HTMLElement;
    this.timelineDuration = this.element.querySelector('#draw-timeline-duration') as HTMLInputElement;
    this.playButton = this.element.querySelector('#draw-timeline-play') as HTMLButtonElement;
    this.layerList = this.element.querySelector('#draw-layer-list') as HTMLElement;
    this.initProject();
    this.bindEvents();
    this.syncColorControls();
    this.applyViewZoom();
  }

  activate(): void {
    this.active = true;
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, this.tool === 'brush' ? '画笔' : '橡皮');
  }

  deactivate(): void {
    this.active = false;
    this.drawing = false;
    this.spaceHeld = false;
    this.viewPanning = false;
    this.stopPlayback();
    this.canvasWrap.classList.remove('is-pan-ready', 'is-panning');
  }

  private initProject(): void {
    this.layers = [];
    this.layerCounter = 0;
    this.duration = 10;
    this.currentTime = 0;
    this.timelineDuration.value = '10';
    this.layers.push(this.createLayer('图层 1'));
    this.selectedLayerId = this.layers[0].id;
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.updateTimeUI();
    this.updateHistoryButtons();
  }

  private createLayer(name: string): DrawLayer {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const layer: DrawLayer = {
      id: `draw-layer-${Date.now()}-${this.layerCounter}`,
      name,
      canvas,
      ctx,
      start: 0,
      end: this.duration,
      visible: true,
      history: [],
      historyIndex: -1
    };
    this.layerCounter += 1;
    this.pushLayerHistory(layer);
    return layer;
  }

  private activeLayer(): DrawLayer | null {
    return this.layers.find((layer) => layer.id === this.selectedLayerId) ?? null;
  }

  private pushLayerHistory(layer: DrawLayer): void {
    layer.history = layer.history.slice(0, layer.historyIndex + 1);
    layer.history.push(layer.canvas.toDataURL('image/png'));
    if (layer.history.length > HISTORY_LIMIT) layer.history.shift();
    layer.historyIndex = layer.history.length - 1;
  }

  private renderComposite(): void {
    this.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      if (this.currentTime + 0.0001 < layer.start || this.currentTime - 0.0001 > layer.end) continue;
      this.ctx.drawImage(layer.canvas, 0, 0);
    }
  }

  private queueComposite(): void {
    if (this.compositeQueued) return;
    this.compositeQueued = true;
    requestAnimationFrame(() => {
      this.compositeQueued = false;
      this.renderComposite();
    });
  }

  private selectLayer(layerId: string): void {
    const layer = this.layers.find((item) => item.id === layerId);
    if (!layer) return;
    this.selectedLayerId = layer.id;
    if (this.currentTime < layer.start || this.currentTime > layer.end) {
      this.currentTime = layer.start;
    }
    this.renderLayerList();
    this.renderTimeline();
    this.updateTimeUI();
    this.renderComposite();
    this.updateHistoryButtons();
  }

  private addLayer(name = `图层 ${this.layers.length + 1}`, select = true): DrawLayer {
    const layer = this.createLayer(name);
    this.layers.push(layer);
    if (select) {
      this.selectedLayerId = layer.id;
      this.currentTime = Math.max(0, Math.min(this.currentTime, layer.end));
    }
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.updateTimeUI();
    this.updateHistoryButtons();
    return layer;
  }

  private deleteLayer(layerId: string): void {
    if (this.layers.length <= 1) {
      this.callbacks.toast('至少保留一个图层', 'info');
      return;
    }
    const index = this.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return;
    this.layers.splice(index, 1);
    if (this.selectedLayerId === layerId) {
      this.selectedLayerId = this.layers[Math.max(0, index - 1)]?.id ?? this.layers[0].id;
    }
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.updateHistoryButtons();
  }

  private toggleLayerVisibility(layerId: string): void {
    const layer = this.layers.find((item) => item.id === layerId);
    if (!layer) return;
    layer.visible = !layer.visible;
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
  }

  private renderLayerList(): void {
    this.layerList.innerHTML = '';
    const ordered = [...this.layers].reverse();
    for (const layer of ordered) {
      const row = document.createElement('div');
      row.className = 'draw-layer-row';
      row.classList.toggle('active', layer.id === this.selectedLayerId);
      row.dataset.layerId = layer.id;

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'draw-layer-eye';
      eye.dataset.layerEye = layer.id;
      eye.textContent = layer.visible ? '◉' : '○';
      eye.title = layer.visible ? '隐藏图层' : '显示图层';

      const name = document.createElement('div');
      name.className = 'draw-layer-name';
      const strong = document.createElement('strong');
      strong.textContent = layer.name;
      const small = document.createElement('small');
      small.textContent = `${layer.start.toFixed(1)}–${layer.end.toFixed(1)} 秒`;
      name.append(strong, small);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'draw-layer-remove';
      remove.dataset.layerRemove = layer.id;
      remove.textContent = '×';
      remove.title = '删除图层';

      row.append(eye, name, remove);
      row.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        this.selectLayer(layer.id);
      });
      eye.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleLayerVisibility(layer.id);
      });
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        this.deleteLayer(layer.id);
      });
      this.layerList.append(row);
    }
  }

  private renderTimeline(): void {
    this.timelineRuler.innerHTML = '';
    const step = this.duration <= 15 ? 1 : this.duration <= 30 ? 2 : 5;
    for (let time = 0; time <= this.duration; time += step) {
      const tick = document.createElement('span');
      tick.className = 'draw-timeline-tick';
      tick.style.left = `${(time / this.duration) * 100}%`;
      tick.textContent = `${time}s`;
      this.timelineRuler.append(tick);
    }

    this.timelineTracks.innerHTML = '';
    const ordered = [...this.layers].reverse();
    for (const layer of ordered) {
      const row = document.createElement('div');
      row.className = 'draw-timeline-track';
      const clip = document.createElement('div');
      clip.className = 'draw-timeline-clip';
      clip.classList.toggle('active', layer.id === this.selectedLayerId);
      clip.classList.toggle('muted', !layer.visible);
      clip.dataset.layerId = layer.id;
      clip.style.left = `${(layer.start / this.duration) * 100}%`;
      clip.style.width = `${Math.max(0.5, ((layer.end - layer.start) / this.duration) * 100)}%`;
      const label = document.createElement('span');
      label.textContent = layer.name;
      const handleStart = document.createElement('span');
      handleStart.className = 'draw-timeline-handle start';
      handleStart.dataset.timelineHandle = 'start';
      const handleEnd = document.createElement('span');
      handleEnd.className = 'draw-timeline-handle end';
      handleEnd.dataset.timelineHandle = 'end';
      clip.append(handleStart, label, handleEnd);
      row.append(clip);
      this.timelineTracks.append(row);
    }
    this.updateTimeUI();
  }

  private updateTimeUI(): void {
    const total = this.duration;
    this.timelineTime.textContent = `${this.formatTimelineTime(this.currentTime)} / ${this.formatTimelineTime(total)}`;
    this.timelinePlayhead.style.left = `${(this.currentTime / total) * 100}%`;
    if (this.playing) {
      this.timelinePlayhead.classList.add('playing');
    } else {
      this.timelinePlayhead.classList.remove('playing');
    }
  }

  private formatTimelineTime(value: number): string {
    const minutes = Math.floor(value / 60);
    const seconds = value - minutes * 60;
    return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
  }

  private setCurrentTime(value: number): void {
    this.currentTime = Math.max(0, Math.min(this.duration, value));
    this.renderComposite();
    this.updateTimeUI();
  }

  private startPlayback(): void {
    if (this.playing) return;
    if (this.currentTime >= this.duration - 0.001) this.currentTime = 0;
    this.playing = true;
    this.playButton.textContent = '❚❚';
    this.playLast = performance.now();
    this.updateTimeUI();
    const tick = (now: number): void => {
      if (!this.playing) return;
      const delta = Math.min(0.2, (now - this.playLast) / 1000);
      this.playLast = now;
      this.currentTime += delta;
      if (this.currentTime >= this.duration) {
        this.currentTime = this.duration;
        this.renderComposite();
        this.updateTimeUI();
        this.stopPlayback();
        return;
      }
      this.renderComposite();
      this.updateTimeUI();
      this.playFrame = requestAnimationFrame(tick);
    };
    this.playFrame = requestAnimationFrame(tick);
  }

  private stopPlayback(): void {
    this.playing = false;
    this.playButton.textContent = '▶';
    if (this.playFrame) cancelAnimationFrame(this.playFrame);
    this.playFrame = 0;
    this.updateTimeUI();
  }

  private togglePlayback(): void {
    if (this.playing) this.stopPlayback();
    else this.startPlayback();
  }

  private beginTimelineDrag(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    const clip = target.closest<HTMLElement>('.draw-timeline-clip');
    if (!clip) return;
    const layer = this.layers.find((item) => item.id === clip.dataset.layerId);
    if (!layer) return;
    const handle = target.closest<HTMLElement>('[data-timeline-handle]')?.dataset.timelineHandle;
    event.preventDefault();
    event.stopPropagation();
    this.timelineDrag = {
      mode: handle === 'start' ? 'start' : handle === 'end' ? 'end' : 'move',
      layerId: layer.id,
      startClientX: event.clientX,
      start: layer.start,
      end: layer.end,
      trackWidth: this.timelineTracks.getBoundingClientRect().width
    };
    this.timelineTracks.setPointerCapture(event.pointerId);
    this.selectLayer(layer.id);
  }

  private moveTimelineDrag(event: PointerEvent): void {
    if (!this.timelineDrag) return;
    const layer = this.layers.find((item) => item.id === this.timelineDrag?.layerId);
    if (!layer) return;
    const width = Math.max(1, this.timelineDrag.trackWidth);
    const delta = ((event.clientX - this.timelineDrag.startClientX) / width) * this.duration;
    const length = this.timelineDrag.end - this.timelineDrag.start;
    if (this.timelineDrag.mode === 'move') {
      const start = Math.max(0, Math.min(this.duration - length, this.timelineDrag.start + delta));
      layer.start = start;
      layer.end = start + length;
    } else if (this.timelineDrag.mode === 'start') {
      layer.start = Math.max(0, Math.min(layer.end - 0.2, this.timelineDrag.start + delta));
    } else {
      layer.end = Math.min(this.duration, Math.max(layer.start + 0.2, this.timelineDrag.end + delta));
    }
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
  }

  private endTimelineDrag(event: PointerEvent): void {
    if (!this.timelineDrag) return;
    this.timelineDrag = null;
    try { this.timelineTracks.releasePointerCapture(event.pointerId); } catch { /* released */ }
  }

  private syncColorControls(): void {
    this.colorInput.value = this.color;
    this.colorPreview.style.background = this.color;
  }

  private applyViewZoom(): void {
    this.canvas.style.transformOrigin = 'center center';
    this.canvas.style.transform = this.viewZoom === 1 && this.viewPanX === 0 && this.viewPanY === 0
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
    this.canvasWrap.classList.remove('is-pan-ready', 'is-panning');
    this.applyViewZoom();
  }

  private zoomViewAt(clientX: number, clientY: number, nextZoom: number): void {
    const zoom = Math.max(0.25, Math.min(8, nextZoom));
    if (Math.abs(zoom - this.viewZoom) < 0.001) return;
    const before = this.canvas.getBoundingClientRect();
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
    const after = this.canvas.getBoundingClientRect();
    this.viewPanX += clientX - (after.left + u * after.width);
    this.viewPanY += clientY - (after.top + v * after.height);
    this.applyViewZoom();
  }

  private startViewPan(event: PointerEvent): void {
    if (!this.spaceHeld || !this.active) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.viewZoom <= 1.001) return;
    this.viewPanning = true;
    this.viewPanLastX = event.clientX;
    this.viewPanLastY = event.clientY;
    this.canvasWrap.setPointerCapture(event.pointerId);
    this.canvasWrap.classList.add('is-panning');
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
    this.canvasWrap.classList.remove('is-panning');
    try { this.canvasWrap.releasePointerCapture(event.pointerId); } catch { /* released */ }
  }

  private bindEvents(): void {
    this.element.querySelectorAll<HTMLElement>('[data-draw-tool]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tool = button.dataset.drawTool === 'eraser' ? 'eraser' : 'brush';
        this.element.querySelectorAll('[data-draw-tool]').forEach((item) => {
          item.classList.toggle('active', item === button);
        });
        this.canvas.style.cursor = this.tool === 'eraser' ? 'cell' : 'crosshair';
        this.callbacks.status.set(undefined, undefined, this.tool === 'brush' ? '画笔' : '橡皮');
      });
    });

    const applyColor = (color: string): void => {
      this.color = color;
      this.tool = 'brush';
      this.element.querySelectorAll('[data-draw-tool]').forEach((item) => {
        item.classList.toggle('active', (item as HTMLElement).dataset.drawTool === 'brush');
      });
      this.syncColorControls();
    };
    this.colorInput.addEventListener('input', () => applyColor(this.colorInput.value));
    this.element.querySelectorAll<HTMLElement>('[data-draw-swatch]').forEach((button) => {
      button.addEventListener('click', () => applyColor(button.dataset.drawSwatch ?? '#8fc3a2'));
    });

    this.widthInput.addEventListener('input', () => {
      this.lineWidth = Number(this.widthInput.value) || 8;
      this.widthValue.textContent = String(this.lineWidth);
    });

    this.element.querySelector('[data-draw-action="undo"]')?.addEventListener('click', () => this.undo());
    this.element.querySelector('[data-draw-action="redo"]')?.addEventListener('click', () => this.redo());
    this.element.querySelector('[data-draw-action="clear"]')?.addEventListener('click', () => this.clear());
    this.element.querySelector('[data-draw-action="open"]')?.addEventListener('click', () => void this.openImage());
    this.element.querySelector('[data-draw-action="save"]')?.addEventListener('click', () => void this.savePng());
    this.element.querySelector('[data-draw-layer-add]')?.addEventListener('click', () => {
      this.addLayer();
      this.callbacks.toast('已新建空白图层', 'success');
    });
    this.element.querySelector('[data-draw-layer-image]')?.addEventListener('click', () => void this.openImage());
    this.playButton.addEventListener('click', () => this.togglePlayback());
    this.timelineDuration.addEventListener('change', () => {
      const next = Math.max(1, Math.min(120, Number(this.timelineDuration.value) || 10));
      this.duration = next;
      this.timelineDuration.value = String(next);
      this.currentTime = Math.min(this.currentTime, next);
      for (const layer of this.layers) {
        layer.end = Math.min(layer.end, next);
        layer.start = Math.min(layer.start, Math.max(0, layer.end - 0.2));
      }
      this.renderTimeline();
      this.renderLayerList();
      this.renderComposite();
    });
    const timelineBody = this.element.querySelector('#draw-timeline-body') as HTMLElement;
    timelineBody.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('.draw-timeline-clip')) return;
      const rect = this.timelineTracks.getBoundingClientRect();
      this.setCurrentTime(((event.clientX - rect.left) / Math.max(1, rect.width)) * this.duration);
    });
    this.timelineTracks.addEventListener('pointerdown', (event) => this.beginTimelineDrag(event));
    this.timelineTracks.addEventListener('pointermove', (event) => this.moveTimelineDrag(event));
    this.timelineTracks.addEventListener('pointerup', (event) => this.endTimelineDrag(event));
    this.timelineTracks.addEventListener('pointercancel', (event) => this.endTimelineDrag(event));

    this.viewBadge.addEventListener('click', () => this.resetViewZoom());
    this.element.querySelector('[data-draw-view-fit]')?.addEventListener('click', () => this.resetViewZoom());
    this.canvasWrap.addEventListener('wheel', (event) => {
      if (!event.altKey) return;
      event.preventDefault();
      this.zoomViewAt(event.clientX, event.clientY, this.viewZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    this.canvasWrap.addEventListener('pointerdown', (event) => this.startViewPan(event), true);
    this.canvasWrap.addEventListener('pointermove', (event) => this.moveViewPan(event));
    this.canvasWrap.addEventListener('pointerup', (event) => this.endViewPan(event));
    this.canvasWrap.addEventListener('pointercancel', (event) => this.endViewPan(event));
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Space' || !this.active) return;
      const target = event.target as HTMLElement;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      this.spaceHeld = true;
      event.preventDefault();
      this.canvasWrap.classList.add('is-pan-ready');
    }, true);
    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space') return;
      this.spaceHeld = false;
      this.canvasWrap.classList.remove('is-pan-ready', 'is-panning');
    }, true);
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
      this.viewPanning = false;
      this.canvasWrap.classList.remove('is-pan-ready', 'is-panning');
    });

    this.canvas.addEventListener('pointerdown', (event) => this.startStroke(event));
    this.canvas.addEventListener('pointermove', (event) => this.moveStroke(event));
    this.canvas.addEventListener('pointerup', (event) => this.endStroke(event));
    this.canvas.addEventListener('pointercancel', (event) => this.endStroke(event));
    this.canvas.addEventListener('pointerleave', (event) => {
      if (this.drawing && event.buttons === 0) this.endStroke(event);
    });

    window.addEventListener('keydown', (event) => {
      if (!this.active || !event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
      if (event.key === '0') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.resetViewZoom();
      } else if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        this.redo();
      }
    });
  }

  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (CANVAS_WIDTH / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (CANVAS_HEIGHT / Math.max(1, rect.height))
    };
  }

  private startStroke(event: PointerEvent): void {
    if (!this.active || event.button !== 0) return;
    const layer = this.activeLayer();
    if (!layer) return;
    if (this.playing) this.stopPlayback();
    if (!layer.visible) {
      layer.visible = true;
      this.renderLayerList();
      this.renderTimeline();
    }
    if (this.currentTime < layer.start || this.currentTime > layer.end) {
      this.currentTime = layer.start;
      this.updateTimeUI();
    }
    event.preventDefault();
    const point = this.pointerPosition(event);
    this.drawing = true;
    this.lastX = point.x;
    this.lastY = point.y;
    this.canvas.setPointerCapture(event.pointerId);
    layer.ctx.save();
    layer.ctx.lineCap = 'round';
    layer.ctx.lineJoin = 'round';
    if (this.tool === 'eraser') {
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.strokeStyle = '#000000';
      layer.ctx.fillStyle = '#000000';
      layer.ctx.globalAlpha = 1;
    } else {
      layer.ctx.strokeStyle = this.color;
      layer.ctx.fillStyle = this.color;
    }
    layer.ctx.lineWidth = this.lineWidth;
    layer.ctx.beginPath();
    layer.ctx.arc(point.x, point.y, this.lineWidth / 2, 0, Math.PI * 2);
    layer.ctx.fill();
    layer.ctx.restore();
    this.queueComposite();
  }

  private moveStroke(event: PointerEvent): void {
    if (!this.drawing) return;
    const layer = this.activeLayer();
    if (!layer) return;
    event.preventDefault();
    const point = this.pointerPosition(event);
    layer.ctx.save();
    layer.ctx.lineCap = 'round';
    layer.ctx.lineJoin = 'round';
    if (this.tool === 'eraser') {
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.strokeStyle = '#000000';
      layer.ctx.globalAlpha = 1;
    } else {
      layer.ctx.strokeStyle = this.color;
    }
    layer.ctx.lineWidth = this.lineWidth;
    layer.ctx.beginPath();
    layer.ctx.moveTo(this.lastX, this.lastY);
    layer.ctx.lineTo(point.x, point.y);
    layer.ctx.stroke();
    layer.ctx.restore();
    this.lastX = point.x;
    this.lastY = point.y;
    this.queueComposite();
  }

  private endStroke(event: PointerEvent): void {
    if (!this.drawing) return;
    this.drawing = false;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    const layer = this.activeLayer();
    if (layer) {
      this.pushLayerHistory(layer);
      this.updateHistoryButtons();
    }
    this.renderComposite();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '已绘制');
  }

  private updateHistoryButtons(): void {
    const layer = this.activeLayer();
    const undo = this.element.querySelector<HTMLButtonElement>('[data-draw-action="undo"]');
    const redo = this.element.querySelector<HTMLButtonElement>('[data-draw-action="redo"]');
    if (undo) undo.disabled = !layer || layer.historyIndex <= 0;
    if (redo) redo.disabled = !layer || layer.historyIndex >= layer.history.length - 1;
  }

  private restoreHistory(index: number): void {
    const layer = this.activeLayer();
    const dataUrl = layer?.history[index];
    if (!layer || !dataUrl) return;
    const token = ++this.restoreToken;
    const image = new Image();
    image.onload = () => {
      if (token !== this.restoreToken) return;
      layer.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      layer.ctx.drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      layer.historyIndex = index;
      this.updateHistoryButtons();
      this.renderComposite();
    };
    image.src = dataUrl;
  }

  private undo(): void {
    const layer = this.activeLayer();
    if (!layer || layer.historyIndex <= 0) return;
    this.restoreHistory(layer.historyIndex - 1);
  }

  private redo(): void {
    const layer = this.activeLayer();
    if (!layer || layer.historyIndex >= layer.history.length - 1) return;
    this.restoreHistory(layer.historyIndex + 1);
  }

  private clear(): void {
    const layer = this.activeLayer();
    if (!layer) return;
    if (!window.confirm(`清空「${layer.name}」的内容？`)) return;
    layer.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.pushLayerHistory(layer);
    this.updateHistoryButtons();
    this.renderComposite();
    this.callbacks.toast('当前图层已清空', 'success');
  }

  private async openImage(): Promise<void> {
    try {
      const filePath = await window.nyxel.dialog.openImage();
      if (!filePath) return;
      const bytes = await window.nyxel.file.read(filePath);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeFromExt(filePath) });
      const url = URL.createObjectURL(blob);
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('图片读取失败'));
        image.src = url;
      });
      const scale = Math.min(CANVAS_WIDTH / image.naturalWidth, CANVAS_HEIGHT / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const name = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || `图片图层 ${this.layers.length + 1}`;
      const layer = this.addLayer(name, true);
      layer.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      layer.ctx.drawImage(image, (CANVAS_WIDTH - width) / 2, (CANVAS_HEIGHT - height) / 2, width, height);
      this.pushLayerHistory(layer);
      this.updateHistoryButtons();
      URL.revokeObjectURL(url);
      this.resetViewZoom();
      this.renderComposite();
      this.renderLayerList();
      this.renderTimeline();
      this.callbacks.toast('图片已添加为独立图层，可在时间轴上调整出现时间', 'success');
    } catch (error) {
      this.callbacks.toast(`打开图片失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async savePng(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    const button = this.element.querySelector<HTMLButtonElement>('[data-draw-action="save"]');
    if (button) button.disabled = true;
    try {
      const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('无法生成 PNG');
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const saved = await window.nyxel.file.savePng(buffer, `texture_map_${timestamp}.png`);
      if (saved) this.callbacks.toast(`已保存：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.saving = false;
      if (button) button.disabled = false;
    }
  }
}

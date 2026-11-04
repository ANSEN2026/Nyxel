import type { ViewCallbacks } from '../types';
import { mimeFromExt } from '../utils';

const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 1000;
const HISTORY_LIMIT = 30;

type DrawTool = 'brush' | 'eraser';

export class DrawView {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private active = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private colorInput: HTMLInputElement;
  private widthInput: HTMLInputElement;
  private widthValue: HTMLElement;
  private tool: DrawTool = 'brush';
  private color = '#8fc3a2';
  private lineWidth = 8;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private restoreToken = 0;
  private saving = false;

  constructor(callbacks: ViewCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view draw-view';
    this.element.innerHTML = `
      <div class="view-toolbar draw-toolbar">
        <strong class="files-title">绘画</strong>
        <span class="files-sub" id="draw-info">${CANVAS_WIDTH} × ${CANVAS_HEIGHT}</span>
        <span class="spacer"></span>
        <div class="draw-tool-group">
          <button type="button" class="active" data-draw-tool="brush">画笔</button>
          <button type="button" data-draw-tool="eraser">橡皮</button>
        </div>
        <label class="draw-field" title="画笔颜色">
          <span>颜色</span>
          <input id="draw-color" type="color" value="#8fc3a2">
        </label>
        <label class="draw-field">
          <span>粗细</span>
          <input id="draw-width" type="range" min="1" max="60" step="1" value="8">
          <span id="draw-width-value">8</span>
        </label>
        <button type="button" data-draw-action="undo" disabled>撤销</button>
        <button type="button" data-draw-action="redo" disabled>重做</button>
        <button type="button" data-draw-action="clear">清空</button>
        <button type="button" data-draw-action="open">打开图片</button>
        <button type="button" class="primary" data-draw-action="save">保存 PNG</button>
      </div>
      <div class="view-body draw-body">
        <div class="draw-canvas-wrap">
          <canvas id="draw-canvas" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
        </div>
        <div class="draw-foot">
          <span>左键绘制 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做</span>
          <span class="draw-size">画布 ${CANVAS_WIDTH} × ${CANVAS_HEIGHT}</span>
        </div>
      </div>
    `;

    this.canvas = this.element.querySelector('#draw-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.colorInput = this.element.querySelector('#draw-color') as HTMLInputElement;
    this.widthInput = this.element.querySelector('#draw-width') as HTMLInputElement;
    this.widthValue = this.element.querySelector('#draw-width-value') as HTMLElement;
    this.initCanvas();
    this.bindEvents();
  }

  activate(): void {
    this.active = true;
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, this.tool === 'brush' ? '画笔' : '橡皮');
  }

  deactivate(): void {
    this.active = false;
    this.drawing = false;
  }

  private initCanvas(): void {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.history = [this.canvas.toDataURL('image/png')];
    this.historyIndex = 0;
    this.updateHistoryButtons();
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

    this.colorInput.addEventListener('input', () => {
      this.color = this.colorInput.value;
      this.tool = 'brush';
      this.element.querySelectorAll('[data-draw-tool]').forEach((item) => {
        item.classList.toggle('active', (item as HTMLElement).dataset.drawTool === 'brush');
      });
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
      if (target.closest('input, textarea, select')) return;
      if (event.key.toLowerCase() === 'z') {
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
    if (event.button !== 0) return;
    event.preventDefault();
    const point = this.pointerPosition(event);
    this.drawing = true;
    this.lastX = point.x;
    this.lastY = point.y;
    this.canvas.setPointerCapture(event.pointerId);
    this.ctx.save();
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = this.tool === 'eraser' ? '#ffffff' : this.color;
    this.ctx.fillStyle = this.ctx.strokeStyle;
    this.ctx.lineWidth = this.lineWidth;
    this.ctx.beginPath();
    this.ctx.arc(point.x, point.y, this.lineWidth / 2, 0, Math.PI * 2);
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
    this.ctx.lineWidth = this.lineWidth;
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
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    this.pushHistory();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '已绘制');
  }

  private pushHistory(): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.canvas.toDataURL('image/png'));
    if (this.history.length > HISTORY_LIMIT) {
      this.history.shift();
    }
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  private updateHistoryButtons(): void {
    const undo = this.element.querySelector<HTMLButtonElement>('[data-draw-action="undo"]');
    const redo = this.element.querySelector<HTMLButtonElement>('[data-draw-action="redo"]');
    if (undo) undo.disabled = this.historyIndex <= 0;
    if (redo) redo.disabled = this.historyIndex >= this.history.length - 1;
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
      this.updateHistoryButtons();
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
    if (!window.confirm('清空当前画布？')) return;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.pushHistory();
    this.callbacks.toast('画布已清空', 'success');
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
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      this.ctx.drawImage(image, (CANVAS_WIDTH - width) / 2, (CANVAS_HEIGHT - height) / 2, width, height);
      URL.revokeObjectURL(url);
      this.pushHistory();
      this.callbacks.toast('图片已放入画布，可以继续绘制', 'success');
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

import type { AnalyzeResponse, PaletteColor } from '../lib/color-types';
import { imageStore } from '../lib/image-store';
import type { Settings, StatusApi, ToastApi } from '../types';
import { basename } from '../utils';

export class ColorView {
  readonly element: HTMLElement;

  private imageCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private imagePanel: HTMLElement;
  private emptyState: HTMLElement;
  private tooltip: HTMLElement;
  private colorBar: HTMLElement;
  private colorList: HTMLElement;
  private meta: HTMLElement;
  private countSelect: HTMLSelectElement;
  private ratioSelect: HTMLSelectElement;
  private ignoreInput: HTMLInputElement;

  private bitmap: ImageBitmap | HTMLCanvasElement | null = null;
  private width = 0;
  private height = 0;
  private name = '';
  private path = '';
  private palette: PaletteColor[] = [];
  private labels: Uint8Array | null = null;
  private labelWidth = 0;
  private labelHeight = 0;
  private transparentRatio = 0;
  private includedPixels = 0;
  private totalPixels = 0;
  private activeColor = -1;
  private analyzing = false;
  private worker: Worker | null = null;
  private active = false;
  private imageRect = { x: 0, y: 0, width: 0, height: 0 };
  private resizeObserver: ResizeObserver;

  private toast: ToastApi;
  private status: StatusApi;
  private getSettings: () => Settings;
  private saveSettings: (settings: Settings) => Promise<void>;

  constructor(
    toast: ToastApi,
    status: StatusApi,
    getSettings: () => Settings,
    saveSettings: (settings: Settings) => Promise<void>
  ) {
    this.toast = toast;
    this.status = status;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;

    this.element = document.createElement('div');
    this.element.className = 'view color-view';
    this.element.innerHTML = `
      <div class="view-toolbar">
        <button class="primary" data-action="open">打开图片</button>
        <button data-action="from-texture">从贴图区获取</button>
        <span class="toolbar-sep"></span>
        <label class="muted">色数
          <select id="color-count">
            <option value="4">4</option>
            <option value="6">6</option>
            <option value="8">8</option>
            <option value="12">12</option>
          </select>
        </label>
        <label class="muted">占比
          <select id="color-ratio">
            <option value="perceptual">感知</option>
            <option value="pixel">像素</option>
          </select>
        </label>
        <label class="muted"><input id="color-ignore" type="checkbox"> 忽略近黑/近白</label>
        <span class="spacer"></span>
        <button data-action="copy-all">复制全部 HEX</button>
        <button data-action="export-json">导出 JSON</button>
      </div>
      <div class="color-body">
        <div class="color-image-panel" id="color-image-panel">
          <canvas id="color-image-canvas"></canvas>
          <canvas id="color-overlay-canvas"></canvas>
          <div class="view-empty color-empty">
            <strong>打开图片，或从贴图区获取</strong>
            <span>建议先使用 RGB / P3 显示器，在 sRGB 下查看</span>
          </div>
          <div class="color-tooltip hidden"></div>
        </div>
        <aside class="color-side">
          <div class="color-bar" id="color-bar"></div>
          <div class="color-list" id="color-list"></div>
          <div class="color-meta" id="color-meta"></div>
        </aside>
      </div>
    `;

    this.imageCanvas = this.element.querySelector('#color-image-canvas') as HTMLCanvasElement;
    this.overlayCanvas = this.element.querySelector('#color-overlay-canvas') as HTMLCanvasElement;
    this.imagePanel = this.element.querySelector('#color-image-panel') as HTMLElement;
    this.emptyState = this.element.querySelector('.color-empty') as HTMLElement;
    this.tooltip = this.element.querySelector('.color-tooltip') as HTMLElement;
    this.colorBar = this.element.querySelector('#color-bar') as HTMLElement;
    this.colorList = this.element.querySelector('#color-list') as HTMLElement;
    this.meta = this.element.querySelector('#color-meta') as HTMLElement;
    this.countSelect = this.element.querySelector('#color-count') as HTMLSelectElement;
    this.ratioSelect = this.element.querySelector('#color-ratio') as HTMLSelectElement;
    this.ignoreInput = this.element.querySelector('#color-ignore') as HTMLInputElement;

    this.bind();
    this.resizeObserver = new ResizeObserver(() => this.drawImage());
    this.resizeObserver.observe(this.imagePanel);
  }

  private bind(): void {
    this.element.querySelector('[data-action="open"]')?.addEventListener('click', () => void this.pickOpen());
    this.element.querySelector('[data-action="from-texture"]')?.addEventListener('click', () => this.useCurrentImage());
    this.element.querySelector('[data-action="copy-all"]')?.addEventListener('click', () => {
      if (!this.palette.length) return;
      void this.copyText(this.palette.map((color) => color.hex).join(', '));
    });
    this.element.querySelector('[data-action="export-json"]')?.addEventListener('click', () => this.exportJson());

    this.countSelect.addEventListener('change', () => {
      const settings = this.getSettings();
      void this.saveSettings({ ...settings, colorCount: Number(this.countSelect.value) || 6 });
      void this.analyze();
    });
    this.ratioSelect.addEventListener('change', () => {
      const settings = this.getSettings();
      void this.saveSettings({ ...settings, colorRatioMode: this.ratioSelect.value as Settings['colorRatioMode'] });
      void this.analyze();
    });
    this.ignoreInput.addEventListener('change', () => {
      const settings = this.getSettings();
      void this.saveSettings({ ...settings, colorIgnoreNearBW: this.ignoreInput.checked });
      void this.analyze();
    });

    this.imagePanel.addEventListener('pointermove', (event) => this.probe(event));
    this.imagePanel.addEventListener('pointerleave', () => this.clearHighlight());
  }

  private async pickOpen(): Promise<void> {
    const filePath = await window.nyxel.dialog.openImage();
    if (filePath) await this.loadPath(filePath);
  }

  async loadPath(filePath: string): Promise<void> {
    try {
      const buffer = await window.nyxel.file.read(filePath);
      const name = basename(filePath);
      const blob = new Blob([new Uint8Array(buffer)], { type: this.mime(name) });
      const bitmap = await createImageBitmap(blob);
      this.setImage(bitmap, bitmap.width, bitmap.height, name, filePath);
    } catch (error) {
      this.toast(`打开图片失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async loadFile(file: File): Promise<void> {
    try {
      const bitmap = await createImageBitmap(file);
      this.setImage(bitmap, bitmap.width, bitmap.height, file.name, (file as File & { path?: string }).path ?? '');
    } catch (error) {
      this.toast(`打开图片失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private mime(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'gif') return 'image/gif';
    return 'image/png';
  }

  private setImage(
    bitmap: ImageBitmap | HTMLCanvasElement,
    width: number,
    height: number,
    name: string,
    path: string
  ): void {
    this.bitmap = bitmap;
    this.width = width;
    this.height = height;
    this.name = name;
    this.path = path;
    imageStore.set({ bitmap, width, height, name, path });
    this.palette = [];
    this.labels = null;
    this.activeColor = -1;
    this.emptyState.classList.add('hidden');
    this.drawImage();
    this.renderPalette();
    this.status.set(name, `${width} × ${height} · 分析中…`);
    this.updateControls();
    void this.analyze();
  }

  useCurrentImage(): void {
    const current = imageStore.get();
    if (!current) {
      this.toast('贴图区还没有图片，先在贴图工作区打开一张图', 'info');
      return;
    }
    this.setImage(current.bitmap, current.width, current.height, current.name, current.path);
  }

  private updateControls(): void {
    const settings = this.getSettings();
    this.countSelect.value = String(settings.colorCount);
    this.ratioSelect.value = settings.colorRatioMode;
    this.ignoreInput.checked = settings.colorIgnoreNearBW;
  }

  private async analyze(): Promise<void> {
    if (!this.bitmap || this.width <= 0 || this.height <= 0) return;
    const settings = this.getSettings();
    const maxSide = 256;
    const scale = Math.min(1, maxSide / Math.max(this.width, this.height));
    const width = Math.max(1, Math.round(this.width * scale));
    const height = Math.max(1, Math.round(this.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    context.drawImage(this.bitmap as CanvasImageSource, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.analyzing = true;
    this.status.set(this.name, '配色分析中…');
    this.worker = new Worker(new URL('../lib/color-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      this.analyzing = false;
      this.palette = event.data.palette;
      this.labels = event.data.labels;
      this.labelWidth = event.data.width;
      this.labelHeight = event.data.height;
      this.transparentRatio = event.data.transparentRatio;
      this.includedPixels = event.data.includedPixels;
      this.totalPixels = event.data.totalPixels;
      this.activeColor = -1;
      this.renderPalette();
      this.status.set(
        this.name,
        `${this.palette.length} 色 · 参与 ${this.includedPixels.toLocaleString()} px · 透明 ${(this.transparentRatio * 100).toFixed(1)}%`
      );
      if (this.activeColor >= 0) this.highlight(this.activeColor);
    };
    this.worker.onerror = (event) => {
      this.analyzing = false;
      this.toast(`配色分析失败：${event.message}`, 'error');
    };
    this.worker.postMessage(
      {
        pixels: imageData.data,
        width,
        height,
        colorCount: Number(this.countSelect.value) || settings.colorCount,
        ratioMode: this.ratioSelect.value as 'perceptual' | 'pixel',
        ignoreNearBW: this.ignoreInput.checked,
        alphaThreshold: settings.colorAlphaThreshold
      },
      [imageData.data.buffer]
    );
  }

  private drawImage(): void {
    const rect = this.imagePanel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.imageCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.imageCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.overlayCanvas.width = this.imageCanvas.width;
    this.overlayCanvas.height = this.imageCanvas.height;

    const context = this.imageCanvas.getContext('2d') as CanvasRenderingContext2D;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = '#b8b8b8';
    context.fillRect(0, 0, rect.width, rect.height);

    if (!this.bitmap) return;
    const scale = Math.min(rect.width / this.width, rect.height / this.height);
    const width = this.width * scale;
    const height = this.height * scale;
    const x = (rect.width - width) / 2;
    const y = (rect.height - height) / 2;
    this.imageRect = { x, y, width, height };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.bitmap as CanvasImageSource, x, y, width, height);
    if (this.activeColor >= 0) this.highlight(this.activeColor);
  }

  private renderPalette(): void {
    this.colorBar.innerHTML = '';
    this.colorList.innerHTML = '';

    if (!this.palette.length) {
      this.meta.textContent = this.analyzing ? '分析中…' : '尚未分析';
      return;
    }

    const main = this.palette.filter((color) => color.ratio >= 0.01);
    const other = this.palette.filter((color) => color.ratio < 0.01);
    const otherRatio = other.reduce((sum, color) => sum + color.ratio, 0);

    for (let index = 0; index < main.length; index += 1) {
      const color = main[index];
      const segment = document.createElement('button');
      segment.className = 'color-seg';
      segment.style.background = color.hex;
      segment.title = `${color.name} ${color.hex} ${(color.ratio * 100).toFixed(1)}%`;
      segment.addEventListener('mouseenter', () => this.highlight(index));
      segment.addEventListener('mouseleave', () => this.clearHighlight());
      segment.addEventListener('click', () => void this.copyText(color.hex));
      this.colorBar.append(segment);

      const row = document.createElement('button');
      row.className = 'color-row';
      row.type = 'button';
      row.innerHTML = `
        <span class="color-swatch" style="background:${color.hex}"></span>
        <span class="color-name">${color.name}</span>
        <span class="color-hex">${color.hex}</span>
        <span class="color-ratio">${(color.ratio * 100).toFixed(1)}%</span>
      `;
      row.addEventListener('mouseenter', () => this.highlight(index));
      row.addEventListener('mouseleave', () => this.clearHighlight());
      row.addEventListener('click', () => void this.copyText(color.hex));
      this.colorList.append(row);
    }

    if (otherRatio > 0.0001) {
      const segment = document.createElement('button');
      segment.className = 'color-seg color-seg-other';
      segment.style.background = '#5f5f5f';
      segment.style.width = `${Math.max(1, otherRatio * 100)}%`;
      segment.title = `其他 ${(otherRatio * 100).toFixed(1)}%`;
      this.colorBar.append(segment);

      const row = document.createElement('div');
      row.className = 'color-row color-row-other';
      row.innerHTML = `
        <span class="color-swatch" style="background:#5f5f5f"></span>
        <span class="color-name">其他</span>
        <span class="color-hex">${other.length} 色</span>
        <span class="color-ratio">${(otherRatio * 100).toFixed(1)}%</span>
      `;
      this.colorList.append(row);
    }

    this.meta.textContent = `${this.palette.length} 色 · 参与 ${this.includedPixels.toLocaleString()} px · 透明 ${(this.transparentRatio * 100).toFixed(1)}% · 采样 ${this.labelWidth}×${this.labelHeight}`;
  }

  private highlight(index: number): void {
    if (!this.labels || index < 0 || index >= this.palette.length) return;
    this.activeColor = index;
    const context = this.overlayCanvas.getContext('2d') as CanvasRenderingContext2D;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (!this.labelWidth || !this.labelHeight) return;

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = this.labelWidth;
    labelCanvas.height = this.labelHeight;
    const labelContext = labelCanvas.getContext('2d') as CanvasRenderingContext2D;
    const imageData = labelContext.createImageData(this.labelWidth, this.labelHeight);
    for (let i = 0; i < this.labels.length; i += 1) {
      if (this.labels[i] === index + 1) {
        imageData.data[i * 4] = 0;
        imageData.data[i * 4 + 1] = 230;
        imageData.data[i * 4 + 2] = 118;
        imageData.data[i * 4 + 3] = 180;
      }
    }
    labelContext.putImageData(imageData, 0, 0);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.drawImage(labelCanvas, this.imageRect.x, this.imageRect.y, this.imageRect.width, this.imageRect.height);
  }

  private clearHighlight(): void {
    this.activeColor = -1;
    const context = this.overlayCanvas.getContext('2d') as CanvasRenderingContext2D;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.tooltip.classList.add('hidden');
  }

  private probe(event: PointerEvent): void {
    if (!this.labels || !this.imageRect.width) return;
    const rect = this.imagePanel.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < this.imageRect.x || x > this.imageRect.x + this.imageRect.width || y < this.imageRect.y || y > this.imageRect.y + this.imageRect.height) {
      this.clearHighlight();
      return;
    }
    const u = (x - this.imageRect.x) / this.imageRect.width;
    const v = (y - this.imageRect.y) / this.imageRect.height;
    const sourceX = Math.min(this.width - 1, Math.max(0, Math.floor(u * this.width)));
    const sourceY = Math.min(this.height - 1, Math.max(0, Math.floor(v * this.height)));
    const lx = Math.min(this.labelWidth - 1, Math.max(0, Math.floor(u * this.labelWidth)));
    const ly = Math.min(this.labelHeight - 1, Math.max(0, Math.floor(v * this.labelHeight)));
    const label = this.labels[ly * this.labelWidth + lx];
    if (!label) {
      this.clearHighlight();
      return;
    }
    const index = label - 1;
    const color = this.palette[index];
    if (!color) return;
    this.highlight(index);
    this.tooltip.classList.remove('hidden');
    this.tooltip.textContent = `${color.name}  ${color.hex}  ${(color.ratio * 100).toFixed(1)}%`;
    this.tooltip.style.left = `${Math.min(rect.width - 170, Math.max(8, x + 12))}px`;
    this.tooltip.style.top = `${Math.max(8, y - 26)}px`;
  }

  private async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(`已复制 ${text}`, 'success');
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      this.toast(`已复制 ${text}`, 'success');
    }
  }

  private exportJson(): void {
    if (!this.palette.length) return;
    const payload = {
      schemaVersion: 1,
      name: this.name,
      generatedAt: new Date().toISOString(),
      options: {
        colorCount: Number(this.countSelect.value),
        ratioMode: this.ratioSelect.value,
        ignoreNearBW: this.ignoreInput.checked,
        alphaThreshold: this.getSettings().colorAlphaThreshold
      },
      palette: this.palette.map((color) => ({
        hex: color.hex,
        ratio: Number(color.ratio.toFixed(6)),
        name: color.name,
        oklch: { l: Number(color.L.toFixed(4)), c: Number(color.C.toFixed(4)), h: Number(color.H.toFixed(2)) }
      })),
      transparentRatio: Number(this.transparentRatio.toFixed(6))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.name.replace(/\.[^.]+$/, '')}-palette.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  activate(): void {
    this.active = true;
    this.updateControls();
    if (!this.bitmap && imageStore.get()) this.useCurrentImage();
    this.drawImage();
    if (this.activeColor >= 0) this.highlight(this.activeColor);
  }

  deactivate(): void {
    this.active = false;
    this.clearHighlight();
  }
}

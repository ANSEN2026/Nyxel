import * as THREE from 'three';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { imageStore } from '../lib/image-store';
import type { AiEngine, AiProgress, ViewCallbacks } from '../types';
import { basename, extname, formatBytes, mimeFromExt } from '../utils';

interface TransformState {
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

const UPSCAYL_MODEL_LABELS: Record<string, string> = {
  'upscayl-standard-4x': 'Standard 4x',
  'ultrasharp-4x': 'Ultrasharp 4x',
  'ultramix-balanced-4x': 'Ultramix Balanced 4x',
  'remacri-4x': 'Remacri 4x'
};

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  uniform sampler2D uTexture;
  uniform int uChannel;
  uniform int uMono;
  uniform float uBlack;
  uniform float uWhite;
  uniform float uGamma;
  varying vec2 vUv;
  void main() {
    vec4 color = texture2D(uTexture, vUv);
    if (uChannel == 1) color = vec4(vec3(color.r), 1.0);
    else if (uChannel == 2) color = vec4(vec3(color.g), 1.0);
    else if (uChannel == 3) color = vec4(vec3(color.b), 1.0);
    else if (uChannel == 4) color = vec4(vec3(color.a), 1.0);
    if (uMono == 1) {
      float gray = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
      float range = max(0.0001, uWhite - uBlack);
      float level = clamp((gray - uBlack) / range, 0.0, 1.0);
      level = pow(level, 1.0 / max(0.0001, uGamma));
      color.rgb = vec3(level);
    }
    gl_FragColor = color;
  }
`;

export class TextureView {
  readonly element: HTMLElement;

  private canvas: HTMLCanvasElement;
  private body: HTMLElement;
  private emptyState: HTMLElement;
  private metaBadge: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private texture: THREE.Texture | null = null;
  private bitmap: ImageBitmap | HTMLCanvasElement | null = null;
  private imageWidth = 0;
  private imageHeight = 0;
  private fileName = '';
  private filePath = '';
  private fileSize = 0;

  private rotation = 0;
  private flipH = false;
  private flipV = false;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private channel = 0;
  private background: 'black' | 'gray' | 'checker' = 'checker';
  private mono = false;
  private levelBlack = 0;
  private levelWhite = 255;
  private levelGamma = 1;
  private levelsInline: HTMLElement;
  private levelBlackInput: HTMLInputElement;
  private levelWhiteInput: HTMLInputElement;
  private levelGammaInput: HTMLInputElement;
  private levelBlackValue: HTMLElement;
  private levelWhiteValue: HTMLElement;
  private levelGammaValue: HTMLElement;

  private history: TransformState[] = [];
  private redoStack: TransformState[] = [];
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private raycaster = new THREE.Raycaster();
  private probeCanvas = document.createElement('canvas');
  private probeCtx: CanvasRenderingContext2D;
  private resizeObserver: ResizeObserver;
  private active = false;
  private raf = 0;
  private spaceHeld = false;
  private spaceZoom = 1;

  private normalBanner: HTMLElement;
  private normalText: HTMLElement;
  private isNormalMap = false;
  private normalGInverted = false;

  private packOverlay: HTMLElement;
  private packPreview: HTMLCanvasElement;
  private packPreviewCtx: CanvasRenderingContext2D;
  private packSelects: Record<'r' | 'g' | 'b' | 'a', HTMLSelectElement>;
  private packSources: Array<{ id: string; name: string; bitmap: ImageBitmap | HTMLCanvasElement }> = [];
  private packSourceSeq = 0;
  private packPreviewTimer = 0;
  private packBusy = false;

  private aiOverlay: HTMLElement;
  private aiRuntime: HTMLElement;
  private aiProgress: HTMLElement;
  private aiProgressBar: HTMLElement;
  private aiProgressText: HTMLElement;
  private aiEngineSelect: HTMLSelectElement;
  private aiEngine: AiEngine = 'upscayl';
  private aiModelRow: HTMLElement;
  private aiModelSelect: HTMLSelectElement;
  private aiUpscaylModel = 'upscayl-standard-4x';
  private aiAvailable = false;
  private aiBusy = false;

  private compareOverlay: HTMLElement;
  private compareImage: HTMLElement;
  private compareOriginal: HTMLCanvasElement;
  private compareResult: HTMLCanvasElement;
  private compareDivider: HTMLElement;
  private compareSplit = 0.5;
  private compareDragging = false;
  private pendingUpscale: {
    bitmap: ImageBitmap | HTMLCanvasElement;
    width: number;
    height: number;
    name: string;
    size: number;
  } | null = null;

  private callbacks: ViewCallbacks;
  private onAnalyze: (() => void) | undefined;

  constructor(callbacks: ViewCallbacks, onAnalyze?: () => void) {
    this.callbacks = callbacks;
    this.onAnalyze = onAnalyze;
    this.element = document.createElement('div');
    this.element.className = 'view texture-view';
    this.element.innerHTML = `
      <div class="view-toolbar">
        <button class="primary" data-action="open">打开贴图</button>
        <button data-action="fit">适配窗口</button>
        <button data-action="color">配色分析</button>
        <button data-action="pack">通道打包</button>
        <button data-action="ai">AI 超分</button>
        <button data-action="export">导出 PNG</button>
        <span class="toolbar-sep"></span>
        <button data-action="rot-l">旋转 -90°</button>
        <button data-action="rot-r">旋转 +90°</button>
        <button data-action="flip-h">水平翻转</button>
        <button data-action="flip-v">垂直翻转</button>
        <span class="toolbar-sep"></span>
        <div class="segmented" data-group="channel">
          <button data-channel="0" class="active">RGBA</button>
          <button data-channel="1">R</button>
          <button data-channel="2">G</button>
          <button data-channel="3">B</button>
          <button data-channel="4">A</button>
        </div>
        <div class="segmented" data-group="bg">
          <button data-bg="black">黑</button>
          <button data-bg="gray">灰</button>
          <button data-bg="checker" class="active">棋盘</button>
        </div>
        <button data-action="mono" id="mono-toggle">黑白</button>
        <div class="levels-inline hidden">
          <label>黑场 <input id="level-black" type="range" min="0" max="254" step="1" value="0"><span id="level-black-value">0</span></label>
          <label>白场 <input id="level-white" type="range" min="1" max="255" step="1" value="255"><span id="level-white-value">255</span></label>
          <label>伽马 <input id="level-gamma" type="range" min="0.1" max="3" step="0.01" value="1"><span id="level-gamma-value">1.00</span></label>
          <button data-action="levels-reset">重置</button>
        </div>
        <span class="spacer"></span>
        <button data-action="undo">撤销</button>
        <button data-action="redo">重做</button>
      </div>
      <div class="view-body texture-body bg-checker">
        <canvas class="view-canvas"></canvas>
        <div class="view-empty"><strong>打开或拖入一张贴图</strong><span>支持 PNG / JPG / WebP / BMP / GIF / TGA</span></div>
        <div class="texture-meta hidden"></div>
        <div class="normal-banner hidden">
          <span class="normal-title">法线贴图</span>
          <span class="normal-text" id="normal-text"></span>
          <span class="spacer"></span>
          <button data-action="normal-g">反转 G</button>
          <button data-action="normal-dismiss">忽略</button>
        </div>
        <div class="pack-overlay hidden">
          <div class="pack-card">
            <div class="pack-header">
              <h3>通道打包</h3>
              <button class="ghost" data-pack-close title="关闭">×</button>
            </div>
            <p class="pack-desc">把不同来源的通道合成到 R / G / B / A，常用于 AO / Roughness / Metallic 打包成 ORM。</p>
            <div class="pack-grid">
              <div class="pack-row">
                <span class="pack-channel r">R</span>
                <select data-pack-slot="r"></select>
                <button data-pack-load="r">载入…</button>
              </div>
              <div class="pack-row">
                <span class="pack-channel g">G</span>
                <select data-pack-slot="g"></select>
                <button data-pack-load="g">载入…</button>
              </div>
              <div class="pack-row">
                <span class="pack-channel b">B</span>
                <select data-pack-slot="b"></select>
                <button data-pack-load="b">载入…</button>
              </div>
              <div class="pack-row">
                <span class="pack-channel a">A</span>
                <select data-pack-slot="a"></select>
                <button data-pack-load="a">载入…</button>
              </div>
            </div>
            <div class="pack-preview-wrap"><canvas id="pack-preview"></canvas></div>
            <div class="pack-actions">
              <span class="pack-hint" id="pack-size"></span>
              <span class="spacer"></span>
              <button data-pack-apply>应用到当前贴图</button>
              <button class="primary" data-pack-export>导出 PNG</button>
              <button data-pack-close>关闭</button>
            </div>
          </div>
        </div>
        <div class="pack-overlay ai-overlay hidden">
          <div class="pack-card ai-card">
            <div class="pack-header">
              <h3>AI 超分</h3>
              <button class="ghost" data-ai-close title="关闭">×</button>
            </div>
            <p class="pack-desc">Upscayl / Real-ESRGAN 首次使用需要下载对应运行时，下载后保存在本机，后续可离线使用。</p>
            <div class="ai-engine-row">
              <label for="ai-engine">超分引擎</label>
              <select id="ai-engine">
                <option value="upscayl">Upscayl</option>
                <option value="realesrgan">Real-ESRGAN x4plus</option>
              </select>
            </div>
            <div class="ai-engine-row" id="ai-model-row">
              <label for="ai-model">Upscayl 模型</label>
              <select id="ai-model">
                <option value="upscayl-standard-4x">Standard 4x · 通用</option>
                <option value="ultrasharp-4x">Ultrasharp 4x · 锐利</option>
                <option value="ultramix-balanced-4x">Ultramix Balanced 4x · 均衡</option>
                <option value="remacri-4x">Remacri 4x · 照片</option>
              </select>
            </div>
            <div class="ai-runtime" id="ai-runtime">检查运行时…</div>
            <div class="ai-progress hidden">
              <div class="ai-progress-track"><div id="ai-progress-bar"></div></div>
              <div class="ai-progress-text" id="ai-progress-text"></div>
            </div>
            <div class="ai-group">
              <div class="ai-group-title">快速放大（本地高质量重采样）</div>
              <div class="ai-buttons">
                <button data-quick-scale="2">2×</button>
                <button data-quick-scale="3">3×</button>
              </div>
            </div>
            <div class="ai-group">
              <div class="ai-group-title" id="ai-engine-label">AI 超分（Upscayl Standard 4x）</div>
              <div class="ai-buttons">
                <button data-ai-scale="2">2×</button>
                <button data-ai-scale="3">3×</button>
                <button data-ai-scale="4">4×</button>
              </div>
            </div>
            <div class="ai-actions">
              <button data-ai-download>下载运行时</button>
              <button data-ai-cancel>取消</button>
              <span class="spacer"></span>
              <button data-ai-close>关闭</button>
            </div>
          </div>
        </div>
        <div class="compare-overlay hidden">
          <div class="compare-actions">
            <span class="compare-hint">拖动中间线对比原图与超分结果</span>
            <span class="spacer"></span>
            <button data-compare-cancel>取消</button>
            <button class="primary" data-compare-apply>应用超分结果</button>
          </div>
          <div class="compare-stage">
            <div class="compare-image" id="compare-image">
              <canvas class="compare-canvas original"></canvas>
              <canvas class="compare-canvas result"></canvas>
              <div class="compare-divider" id="compare-divider"></div>
              <span class="compare-tag left">原图</span>
              <span class="compare-tag right">超分</span>
            </div>
          </div>
        </div>
      </div>
    `;

    this.canvas = this.element.querySelector('canvas') as HTMLCanvasElement;
    this.body = this.element.querySelector('.texture-body') as HTMLElement;
    this.emptyState = this.element.querySelector('.view-empty') as HTMLElement;
    this.metaBadge = this.element.querySelector('.texture-meta') as HTMLElement;
    this.normalBanner = this.element.querySelector('.normal-banner') as HTMLElement;
    this.normalText = this.element.querySelector('#normal-text') as HTMLElement;
    this.packOverlay = this.element.querySelector('.pack-overlay') as HTMLElement;
    this.packPreview = this.element.querySelector('#pack-preview') as HTMLCanvasElement;
    this.packPreviewCtx = this.packPreview.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.packSelects = {
      r: this.element.querySelector('[data-pack-slot="r"]') as HTMLSelectElement,
      g: this.element.querySelector('[data-pack-slot="g"]') as HTMLSelectElement,
      b: this.element.querySelector('[data-pack-slot="b"]') as HTMLSelectElement,
      a: this.element.querySelector('[data-pack-slot="a"]') as HTMLSelectElement
    };
    this.aiOverlay = this.element.querySelector('.ai-overlay') as HTMLElement;
    this.aiRuntime = this.element.querySelector('#ai-runtime') as HTMLElement;
    this.aiProgress = this.element.querySelector('.ai-progress') as HTMLElement;
    this.aiProgressBar = this.element.querySelector('#ai-progress-bar') as HTMLElement;
    this.aiProgressText = this.element.querySelector('#ai-progress-text') as HTMLElement;
    this.aiEngineSelect = this.element.querySelector('#ai-engine') as HTMLSelectElement;
    this.aiModelRow = this.element.querySelector('#ai-model-row') as HTMLElement;
    this.aiModelSelect = this.element.querySelector('#ai-model') as HTMLSelectElement;
    this.compareOverlay = this.element.querySelector('.compare-overlay') as HTMLElement;
    this.compareImage = this.element.querySelector('#compare-image') as HTMLElement;
    this.compareOriginal = this.element.querySelector('.compare-canvas.original') as HTMLCanvasElement;
    this.compareResult = this.element.querySelector('.compare-canvas.result') as HTMLCanvasElement;
    this.compareDivider = this.element.querySelector('#compare-divider') as HTMLElement;
    this.levelsInline = this.element.querySelector('.levels-inline') as HTMLElement;
    this.levelBlackInput = this.element.querySelector('#level-black') as HTMLInputElement;
    this.levelWhiteInput = this.element.querySelector('#level-white') as HTMLInputElement;
    this.levelGammaInput = this.element.querySelector('#level-gamma') as HTMLInputElement;
    this.levelBlackValue = this.element.querySelector('#level-black-value') as HTMLElement;
    this.levelWhiteValue = this.element.querySelector('#level-white-value') as HTMLElement;
    this.levelGammaValue = this.element.querySelector('#level-gamma-value') as HTMLElement;
    this.probeCtx = this.probeCanvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.camera.position.set(0, 0, 1);

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.body);
    this.resize();
  }

  private bindEvents(): void {
    this.element.querySelector('[data-action="open"]')?.addEventListener('click', () => void this.pickOpen());
    this.element.querySelector('[data-action="fit"]')?.addEventListener('click', () => this.fit());
    this.element.querySelector('[data-action="color"]')?.addEventListener('click', () => this.onAnalyze?.());
    this.element.querySelector('[data-action="pack"]')?.addEventListener('click', () => this.openPackPanel());
    this.element.querySelector('[data-action="ai"]')?.addEventListener('click', () => void this.openAiPanel());
    this.element.querySelector('[data-action="export"]')?.addEventListener('click', () => void this.exportCurrent());
    this.element.querySelectorAll('[data-ai-close]').forEach((button) => {
      button.addEventListener('click', () => this.closeAiPanel());
    });
    this.element.querySelector('[data-ai-download]')?.addEventListener('click', () => void this.downloadAiRuntime());
    this.element.querySelector('[data-ai-cancel]')?.addEventListener('click', () => void this.cancelAi());
    this.aiEngineSelect.addEventListener('change', () => {
      this.aiEngine = (this.aiEngineSelect.value as AiEngine) || 'upscayl';
      this.aiAvailable = false;
      this.updateAiButtons();
      void this.refreshAiStatus();
    });
    this.aiModelSelect.addEventListener('change', () => {
      this.aiUpscaylModel = this.aiModelSelect.value || 'upscayl-standard-4x';
      this.aiAvailable = false;
      this.updateAiButtons();
      void this.refreshAiStatus();
    });
    this.element.querySelectorAll('[data-quick-scale]').forEach((button) => {
      button.addEventListener('click', () => {
        void this.quickScale(Number((button as HTMLElement).dataset.quickScale));
      });
    });
    this.element.querySelectorAll('[data-ai-scale]').forEach((button) => {
      button.addEventListener('click', () => {
        void this.aiScale(Number((button as HTMLElement).dataset.aiScale));
      });
    });
    window.nyxel.ai.onProgress((progress) => this.updateAiProgress(progress));

    this.element.querySelector('[data-compare-apply]')?.addEventListener('click', () => this.applyCompare());
    this.element.querySelector('[data-compare-cancel]')?.addEventListener('click', () => this.discardCompare());
    this.compareImage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.compareDragging = true;
      try {
        this.compareImage.setPointerCapture(event.pointerId);
      } catch {
        // synthetic pointer events in automation have no active pointer
      }
      this.updateCompareFromPointer(event);
    });
    this.compareImage.addEventListener('pointermove', (event) => {
      if (this.compareDragging) this.updateCompareFromPointer(event);
    });
    const stopCompareDrag = (event: PointerEvent) => {
      this.compareDragging = false;
      try {
        this.compareImage.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    };
    this.compareImage.addEventListener('pointerup', stopCompareDrag);
    this.compareImage.addEventListener('pointercancel', stopCompareDrag);

    this.element.querySelectorAll('[data-pack-close]').forEach((button) => {
      button.addEventListener('click', () => this.closePackPanel());
    });
    this.element.querySelector('[data-pack-export]')?.addEventListener('click', () => void this.exportPack());
    this.element.querySelector('[data-pack-apply]')?.addEventListener('click', () => void this.applyPack());
    this.element.querySelectorAll('[data-pack-load]').forEach((button) => {
      button.addEventListener('click', () => {
        const slot = (button as HTMLElement).dataset.packLoad as 'r' | 'g' | 'b' | 'a';
        void this.loadPackSource(slot);
      });
    });
    Object.values(this.packSelects).forEach((select) => {
      select.addEventListener('change', () => this.schedulePackPreview());
    });
    this.element.querySelector('[data-action="normal-g"]')?.addEventListener('click', () => {
      this.toggleNormalG();
    });
    this.element.querySelector('[data-action="normal-dismiss"]')?.addEventListener('click', () => {
      this.normalBanner.classList.add('hidden');
    });
    this.element.querySelector('[data-action="rot-l"]')?.addEventListener('click', () => this.rotate(-90));
    this.element.querySelector('[data-action="rot-r"]')?.addEventListener('click', () => this.rotate(90));
    this.element.querySelector('[data-action="flip-h"]')?.addEventListener('click', () => this.flip('h'));
    this.element.querySelector('[data-action="flip-v"]')?.addEventListener('click', () => this.flip('v'));
    this.element.querySelector('[data-action="undo"]')?.addEventListener('click', () => this.undo());
    this.element.querySelector('[data-action="redo"]')?.addEventListener('click', () => this.redo());

    this.element.querySelectorAll('[data-channel]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = Number((button as HTMLElement).dataset.channel);
        this.setChannel(value);
      });
    });

    this.element.querySelectorAll('[data-bg]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = (button as HTMLElement).dataset.bg as 'black' | 'gray' | 'checker';
        this.setBackground(value);
      });
    });

    this.element.querySelector('[data-action="mono"]')?.addEventListener('click', () => this.setMono(!this.mono));
    this.element.querySelector('[data-action="levels-reset"]')?.addEventListener('click', () => this.resetLevels());
    this.levelBlackInput.addEventListener('input', () => {
      this.levelBlack = Math.min(Number(this.levelBlackInput.value), this.levelWhite - 1);
      this.syncLevelInputs();
      this.updateLevelUniforms();
    });
    this.levelWhiteInput.addEventListener('input', () => {
      this.levelWhite = Math.max(Number(this.levelWhiteInput.value), this.levelBlack + 1);
      this.syncLevelInputs();
      this.updateLevelUniforms();
    });
    this.levelGammaInput.addEventListener('input', () => {
      this.levelGamma = Number(this.levelGammaInput.value) || 1;
      this.syncLevelInputs();
      this.updateLevelUniforms();
    });

    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (!this.mesh) return;
      const factor = Math.exp(-event.deltaY * 0.0015);
      this.zoom = THREE.MathUtils.clamp(this.zoom * factor, 0.02, 40);
      this.updateCamera();
    }, { passive: false });

    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.mesh || event.button !== 0) return;
      this.dragging = true;
      this.dragX = event.clientX;
      this.dragY = event.clientY;
      this.body.classList.add('dragging');
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.mesh) return;
      if (this.dragging) {
        const dx = event.clientX - this.dragX;
        const dy = event.clientY - this.dragY;
        this.dragX = event.clientX;
        this.dragY = event.clientY;
        const worldWidth = (this.camera.right - this.camera.left) / this.camera.zoom;
        const worldHeight = (this.camera.top - this.camera.bottom) / this.camera.zoom;
        this.panX -= (dx / Math.max(1, this.canvas.clientWidth)) * worldWidth;
        this.panY += (dy / Math.max(1, this.canvas.clientHeight)) * worldHeight;
        this.updateCamera();
      } else {
        this.probe(event);
      }
    });

    const stopDrag = (event: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.body.classList.remove('dragging');
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', stopDrag);
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.dragging) this.callbacks.status.set(this.fileName, this.metaText());
    });

    window.addEventListener('paste', (event) => {
      if (!this.active) return;
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) {
        event.preventDefault();
        void this.loadFile(file);
      }
    });

    window.addEventListener('keydown', (event) => {
      if (!this.active || event.code !== 'Space' || event.repeat) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (['input', 'select', 'textarea', 'button'].includes(tag)) return;
      event.preventDefault();
      this.spaceHeld = true;
      this.spaceZoom = this.zoom;
      this.zoom = Math.max(
        1,
        this.imageWidth / Math.max(1, this.body.clientWidth),
        this.imageHeight / Math.max(1, this.body.clientHeight)
      );
      this.updateCamera();
    });
    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space' || !this.spaceHeld) return;
      this.spaceHeld = false;
      this.zoom = this.spaceZoom;
      this.updateCamera();
    });
  }

  private async pickOpen(): Promise<void> {
    const filePath = await window.nyxel.dialog.openImage();
    if (filePath) await this.loadPath(filePath);
  }

  async loadPath(filePath: string): Promise<void> {
    try {
      const buffer = await window.nyxel.file.read(filePath);
      const name = basename(filePath);
      await this.loadBuffer(buffer, name, extname(filePath), filePath, buffer.byteLength);
    } catch (error) {
      this.callbacks.toast(`打开贴图失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async loadFile(file: File): Promise<void> {
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      await this.loadBuffer(buffer, file.name, extname(file.name), '', file.size);
    } catch (error) {
      this.callbacks.toast(`打开贴图失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async loadBuffer(buffer: Uint8Array, name: string, ext: string, filePath: string, size: number): Promise<void> {
    this.discardCompare();
    let source: ImageBitmap | HTMLCanvasElement;
    if (ext === '.tga') {
      source = this.decodeTga(buffer);
    } else if (ext === '.exr' || ext === '.hdr') {
      throw new Error('EXR / HDR 预览将在后续版本加入，当前请使用 PNG / JPG / WebP / BMP / TGA');
    } else {
      const blob = new Blob([new Uint8Array(buffer)], { type: mimeFromExt(name) });
      source = await createImageBitmap(blob);
    }
    const width = source.width;
    const height = source.height;
    this.setImage(source, width, height, name, filePath, size);
  }

  private decodeTga(buffer: Uint8Array): HTMLCanvasElement {
    const loader = new TGALoader();
    const parsed = loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
    const image = parsed.image as { data: Uint8Array; width: number; height: number };
    const { width, height, data } = image;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const rgba = new Uint8ClampedArray(width * height * 4);
    if (data.length >= width * height * 4) {
      rgba.set(data.subarray(0, width * height * 4));
    } else {
      for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
        rgba[i * 4] = data[j] ?? 0;
        rgba[i * 4 + 1] = data[j + 1] ?? 0;
        rgba[i * 4 + 2] = data[j + 2] ?? 0;
        rgba[i * 4 + 3] = 255;
      }
    }
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    (parsed as unknown as THREE.Texture).dispose();
    return canvas;
  }

  private setImage(
    source: ImageBitmap | HTMLCanvasElement,
    width: number,
    height: number,
    name: string,
    filePath: string,
    size: number,
    options: { preserveTransform?: boolean; preserveHistory?: boolean; skipNormalDetect?: boolean } = {}
  ): void {
    const previous = {
      rotation: this.rotation,
      flipH: this.flipH,
      flipV: this.flipV,
      history: this.history,
      redoStack: this.redoStack
    };

    this.disposeImage();
    this.bitmap = source;
    this.imageWidth = width;
    this.imageHeight = height;
    this.fileName = name;
    this.filePath = filePath;
    this.fileSize = size;
    imageStore.set({ bitmap: source, width, height, name, path: filePath });

    if (options.preserveTransform) {
      this.rotation = previous.rotation;
      this.flipH = previous.flipH;
      this.flipV = previous.flipV;
    } else {
      this.rotation = 0;
      this.flipH = false;
      this.flipV = false;
    }
    if (options.preserveHistory) {
      this.history = previous.history;
      this.redoStack = previous.redoStack;
    } else {
      this.history = [];
      this.redoStack = [];
    }

    // ImageBitmap uploads can ignore THREE.Texture.flipY in Electron, which
    // shows the image upside down. Normalize through a canvas first.
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = width;
    textureCanvas.height = height;
    const textureContext = textureCanvas.getContext('2d');
    if (textureContext) textureContext.drawImage(source as CanvasImageSource, 0, 0, width, height);
    this.texture = new THREE.Texture(textureCanvas as unknown as HTMLImageElement);
    // This is a raw image viewer, not a lit material. Keep the texture in its
    // original sRGB values so the custom shader outputs them unchanged;
    // SRGBColorSpace would decode to linear and darken/oversaturate the preview.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: this.texture },
        uChannel: { value: this.channel },
        uMono: { value: this.mono ? 1 : 0 },
        uBlack: { value: this.levelBlack / 255 },
        uWhite: { value: this.levelWhite / 255 },
        uGamma: { value: this.levelGamma }
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    const aspect = width / height;
    const geometry = new THREE.PlaneGeometry(aspect, 1);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.scene.add(this.mesh);

    this.emptyState.classList.add('hidden');
    this.metaBadge.classList.remove('hidden');
    this.metaBadge.textContent = `${width} × ${height} · ${name} · ${formatBytes(size)}`;
    this.applyTransform();
    this.fit();
    this.callbacks.status.set(name, `${width} × ${height} · ${formatBytes(size)}`);
    if (filePath) this.callbacks.pushRecent('texture', filePath, name);

    this.isNormalMap = false;
    this.normalGInverted = false;
    this.normalBanner.classList.add('hidden');
    if (!options.skipNormalDetect) this.detectNormalMap();
  }

  private detectNormalMap(): void {
    const bitmap = this.bitmap;
    if (!bitmap || !this.imageWidth || !this.imageHeight) return;
    const scale = Math.min(1, 192 / Math.max(this.imageWidth, this.imageHeight));
    const width = Math.max(1, Math.round(this.imageWidth * scale));
    const height = Math.max(1, Math.round(this.imageHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;

    let count = 0;
    let sumLength = 0;
    let nearUnit = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 16) continue;
      const r = data[index] / 255;
      const g = data[index + 1] / 255;
      const b = data[index + 2] / 255;
      const x = r * 2 - 1;
      const y = g * 2 - 1;
      const z = b * 2 - 1;
      const length = Math.sqrt(x * x + y * y + z * z);
      sumLength += length;
      if (length >= 0.55 && length <= 1.35) nearUnit += 1;
      sumR += r;
      sumG += g;
      sumB += b;
      count += 1;
    }
    if (!count) return;

    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;
    const avgLength = sumLength / count;
    const nearRatio = nearUnit / count;
    const nameHint = /normal|nrm|法线|_n\./i.test(this.fileName);
    const looksNormal = avgB > 0.52 &&
      avgB > avgR + 0.04 &&
      avgB > avgG + 0.04 &&
      avgR > 0.25 && avgR < 0.75 &&
      avgG > 0.25 && avgG < 0.75 &&
      avgLength > 0.65 && avgLength < 1.35 &&
      nearRatio > 0.65;

    if (looksNormal || (nameHint && avgB > 0.45 && nearRatio > 0.4)) {
      this.isNormalMap = true;
      this.normalGInverted = false;
      this.showNormalBanner();
    }
  }

  private showNormalBanner(): void {
    this.normalBanner.classList.remove('hidden');
    this.normalText.textContent = this.normalGInverted
      ? '检测到法线贴图 · G 通道已反转'
      : '检测到法线贴图 · 可切换 G 通道方向（OpenGL / DirectX）';
    const button = this.element.querySelector('[data-action="normal-g"]') as HTMLButtonElement | null;
    if (button) button.textContent = this.normalGInverted ? '恢复 G' : '反转 G';
  }

  private toggleNormalG(): void {
    const bitmap = this.bitmap;
    if (!bitmap || !this.isNormalMap) return;
    const width = this.imageWidth;
    const height = this.imageHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(bitmap as CanvasImageSource, 0, 0);
    const image = context.getImageData(0, 0, width, height);
    for (let index = 1; index < image.data.length; index += 4) {
      image.data[index] = 255 - image.data[index];
    }
    context.putImageData(image, 0, 0);

    const wasInverted = this.normalGInverted;
    this.setImage(
      canvas,
      width,
      height,
      this.fileName || 'normal.png',
      this.filePath,
      this.fileSize,
      { preserveTransform: true, preserveHistory: true, skipNormalDetect: true }
    );
    this.isNormalMap = true;
    this.normalGInverted = !wasInverted;
    this.showNormalBanner();
    this.callbacks.toast(this.normalGInverted ? '已反转 G 通道' : '已恢复 G 通道', 'success');
  }

  private openPackPanel(): void {
    if (!this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    if (!this.compareOverlay.classList.contains('hidden')) this.discardCompare();
    this.aiOverlay.classList.add('hidden');
    this.packOverlay.classList.remove('hidden');
    this.refreshPackSelects();
    this.schedulePackPreview();
  }

  private closePackPanel(): void {
    this.packOverlay.classList.add('hidden');
    window.clearTimeout(this.packPreviewTimer);
    for (const source of this.packSources) {
      if (source.bitmap instanceof ImageBitmap) source.bitmap.close();
    }
    this.packSources = [];
    this.packSourceSeq = 0;
  }

  private refreshPackSelects(): void {
    const slots: Array<'r' | 'g' | 'b' | 'a'> = ['r', 'g', 'b', 'a'];
    const channelLabels: Array<[string, string]> = [
      ['r', 'R'], ['g', 'G'], ['b', 'B'], ['a', 'A'], ['l', '亮度']
    ];
    const defaults: Record<'r' | 'g' | 'b' | 'a', string> = {
      r: 'current:r', g: 'current:g', b: 'current:b', a: 'current:a'
    };

    for (const slot of slots) {
      const select = this.packSelects[slot];
      const previous = select.value;
      select.innerHTML = '';

      if (this.bitmap) {
        for (const [value, label] of channelLabels) {
          select.append(new Option(`当前图 · ${label}`, `current:${value}`));
        }
      }
      select.append(new Option('常量 0', 'const0'), new Option('常量 1', 'const1'));
      for (const source of this.packSources) {
        for (const [value, label] of channelLabels) {
          select.append(new Option(`${source.name} · ${label}`, `${source.id}:${value}`));
        }
      }

      const hasPrevious = Array.from(select.options).some((option) => option.value === previous);
      select.value = hasPrevious ? previous : defaults[slot];
    }
  }

  private schedulePackPreview(): void {
    window.clearTimeout(this.packPreviewTimer);
    this.packPreviewTimer = window.setTimeout(() => this.updatePackPreview(), 60);
  }

  private updatePackPreview(): void {
    if (this.packOverlay.classList.contains('hidden')) return;
    const canvas = this.composePack(512);
    if (!canvas) return;
    this.packPreview.width = canvas.width;
    this.packPreview.height = canvas.height;
    this.packPreviewCtx.clearRect(0, 0, canvas.width, canvas.height);
    this.packPreviewCtx.drawImage(canvas, 0, 0);
    const size = this.element.querySelector('#pack-size') as HTMLElement | null;
    if (size) size.textContent = `${this.imageWidth} × ${this.imageHeight} · 输出 PNG`;
  }

  private resolvePackSource(value: string):
    | { kind: 'constant'; value: number }
    | { kind: 'image'; bitmap: ImageBitmap | HTMLCanvasElement; channel: string }
    | null {
    if (value === 'const0') return { kind: 'constant', value: 0 };
    if (value === 'const1') return { kind: 'constant', value: 255 };
    const [id, channel] = value.split(':');
    if (!channel) return null;
    if (id === 'current') {
      return this.bitmap ? { kind: 'image', bitmap: this.bitmap, channel } : null;
    }
    const source = this.packSources.find((entry) => entry.id === id);
    return source ? { kind: 'image', bitmap: source.bitmap, channel } : null;
  }

  private composePack(maxSize: number): HTMLCanvasElement | null {
    if (!this.bitmap || !this.imageWidth || !this.imageHeight) return null;
    let width = this.imageWidth;
    let height = this.imageHeight;
    if (maxSize > 0) {
      const scale = Math.min(1, maxSize / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    } else if (Math.max(width, height) > 4096) {
      const scale = 4096 / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      this.callbacks.toast('输出超过 4096，已按比例缩小', 'info');
    }

    const slots: Array<'r' | 'g' | 'b' | 'a'> = ['r', 'g', 'b', 'a'];
    const channels: Record<'r' | 'g' | 'b' | 'a', Uint8Array> = {
      r: new Uint8Array(width * height),
      g: new Uint8Array(width * height),
      b: new Uint8Array(width * height),
      a: new Uint8Array(width * height)
    };
    const pixelCache = new Map<ImageBitmap | HTMLCanvasElement, Uint8ClampedArray>();

    const getPixels = (source: ImageBitmap | HTMLCanvasElement): Uint8ClampedArray | null => {
      const cached = pixelCache.get(source);
      if (cached) return cached;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(source as CanvasImageSource, 0, 0, width, height);
      const data = context.getImageData(0, 0, width, height).data;
      pixelCache.set(source, data);
      return data;
    };

    for (const slot of slots) {
      const resolved = this.resolvePackSource(this.packSelects[slot].value);
      const output = channels[slot];
      if (!resolved) {
        output.fill(0);
        continue;
      }
      if (resolved.kind === 'constant') {
        output.fill(resolved.value);
        continue;
      }
      const pixels = getPixels(resolved.bitmap);
      if (!pixels) {
        output.fill(0);
        continue;
      }
      const channel = resolved.channel;
      for (let index = 0; index < output.length; index += 1) {
        const offset = index * 4;
        if (channel === 'r') output[index] = pixels[offset];
        else if (channel === 'g') output[index] = pixels[offset + 1];
        else if (channel === 'b') output[index] = pixels[offset + 2];
        else if (channel === 'a') output[index] = pixels[offset + 3];
        else {
          output[index] = Math.round(
            pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722
          );
        }
      }
    }

    const output = new ImageData(width, height);
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      output.data[offset] = channels.r[index];
      output.data[offset + 1] = channels.g[index];
      output.data[offset + 2] = channels.b[index];
      output.data[offset + 3] = channels.a[index];
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.putImageData(output, 0, 0);
    return canvas;
  }

  private packOutputName(): string {
    const base = this.fileName.replace(/\.[^.]+$/, '') || 'texture';
    return `${base}_packed.png`;
  }

  private async loadPackSource(slot: 'r' | 'g' | 'b' | 'a'): Promise<void> {
    const filePath = await window.nyxel.dialog.openImage();
    if (!filePath) return;
    try {
      const buffer = await window.nyxel.file.read(filePath);
      const ext = extname(filePath);
      let source: ImageBitmap | HTMLCanvasElement;
      if (ext === '.tga') {
        source = this.decodeTga(buffer);
      } else {
        const blob = new Blob([new Uint8Array(buffer)], { type: mimeFromExt(basename(filePath)) });
        source = await createImageBitmap(blob);
      }
      const id = `src${this.packSourceSeq + 1}`;
      this.packSourceSeq += 1;
      this.packSources.push({ id, name: basename(filePath), bitmap: source });
      this.refreshPackSelects();
      this.packSelects[slot].value = `${id}:l`;
      this.schedulePackPreview();
    } catch (error) {
      this.callbacks.toast(
        `载入打包源失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private async exportPack(): Promise<void> {
    if (this.packBusy) return;
    this.packBusy = true;
    try {
      const canvas = this.composePack(0);
      if (!canvas) return;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const saved = await window.nyxel.file.savePng(data, this.packOutputName());
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(
        `导出失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    } finally {
      this.packBusy = false;
    }
  }

  private async applyPack(): Promise<void> {
    if (this.packBusy) return;
    this.packBusy = true;
    try {
      const canvas = this.composePack(0);
      if (!canvas) return;
      const name = this.packOutputName();
      this.setImage(
        canvas,
        canvas.width,
        canvas.height,
        name,
        '',
        canvas.width * canvas.height * 4
      );
      this.closePackPanel();
      this.callbacks.toast('已应用到当前贴图', 'success');
    } catch (error) {
      this.callbacks.toast(
        `应用失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    } finally {
      this.packBusy = false;
    }
  }

  private currentBaseName(): string {
    return this.fileName.replace(/\.[^.]+$/, '') || 'texture';
  }

  private aiModelLabel(): string {
    return UPSCAYL_MODEL_LABELS[this.aiUpscaylModel] ?? this.aiUpscaylModel;
  }

  private aiEngineLabel(): string {
    return this.aiEngine === 'upscayl' ? `Upscayl · ${this.aiModelLabel()}` : 'Real-ESRGAN x4plus';
  }

  private async exportCurrent(): Promise<void> {
    if (!this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = this.imageWidth;
      canvas.height = this.imageHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('无法创建导出画布');
      context.drawImage(this.bitmap as CanvasImageSource, 0, 0);
      if (this.mono) this.applyMonoToCanvas(canvas);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const suffix = this.mono ? '_bw_export.png' : '_export.png';
      const saved = await window.nyxel.file.savePng(data, `${this.currentBaseName()}${suffix}`);
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(
        `导出失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private async openAiPanel(): Promise<void> {
    if (!this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    if (!this.compareOverlay.classList.contains('hidden')) this.discardCompare();
    if (!this.packOverlay.classList.contains('hidden')) this.closePackPanel();
    this.aiOverlay.classList.remove('hidden');
    this.aiProgress.classList.add('hidden');
    this.aiProgressBar.style.width = '0%';
    this.aiProgressText.textContent = '';
    this.updateAiButtons();
    await this.refreshAiStatus();
  }

  private closeAiPanel(): void {
    this.aiOverlay.classList.add('hidden');
  }

  private async refreshAiStatus(): Promise<void> {
    const status = await window.nyxel.ai.status(this.aiEngine, this.aiUpscaylModel);
    this.aiAvailable = status.available;
    const label = this.aiEngineLabel();
    const size = this.aiEngine === 'upscayl' ? '约 33 MB' : '约 45 MB';
    this.aiRuntime.classList.toggle('ready', status.available);
    this.aiRuntime.textContent = status.available
      ? `${label} 运行时已就绪 · ${status.dir}`
      : status.downloading
        ? `正在下载 ${label} 运行时…`
        : `尚未下载 ${label} 运行时（${size}）`;
    const labelElement = this.element.querySelector('#ai-engine-label') as HTMLElement | null;
    if (labelElement) labelElement.textContent = `AI 超分（${label}）`;
    this.aiEngineSelect.value = this.aiEngine;
    this.aiModelSelect.value = this.aiUpscaylModel;
    this.updateAiButtons();
  }

  private updateAiButtons(): void {
    this.element.querySelectorAll<HTMLButtonElement>('[data-ai-scale]').forEach((button) => {
      button.disabled = !this.aiAvailable || this.aiBusy;
    });
    this.element.querySelectorAll<HTMLButtonElement>('[data-quick-scale]').forEach((button) => {
      button.disabled = this.aiBusy;
    });
    const download = this.element.querySelector('[data-ai-download]') as HTMLButtonElement | null;
    if (download) {
      download.style.display = this.aiAvailable ? 'none' : '';
      download.disabled = this.aiBusy;
      download.textContent = `下载 ${this.aiEngineLabel()} 运行时`;
    }
    const cancel = this.element.querySelector('[data-ai-cancel]') as HTMLButtonElement | null;
    if (cancel) cancel.disabled = !this.aiBusy;
    this.aiEngineSelect.disabled = this.aiBusy;
    this.aiModelSelect.disabled = this.aiBusy;
    this.aiModelRow.style.display = this.aiEngine === 'upscayl' ? 'flex' : 'none';
  }

  private updateAiProgress(progress: AiProgress): void {
    this.aiProgress.classList.remove('hidden');
    const percent = Math.max(0, Math.min(100, progress.percent || 0));
    this.aiProgressBar.style.width = `${percent}%`;
    const suffix = progress.phase === 'done' || progress.phase === 'error'
      ? ''
      : ` · ${percent.toFixed(0)}%`;
    this.aiProgressText.textContent = `${progress.message ?? progress.phase}${suffix}`;
    if (progress.phase === 'error') {
      this.aiRuntime.textContent = progress.message ?? 'AI 运行时出错';
    }
  }

  private async downloadAiRuntime(): Promise<void> {
    if (this.aiBusy) return;
    const engine = this.aiEngine;
    const model = this.aiUpscaylModel;
    this.aiBusy = true;
    this.updateAiButtons();
    try {
      const result = await window.nyxel.ai.download(engine, model);
      if (!result.ok) {
        this.callbacks.toast(`下载失败：${result.error ?? '未知错误'}`, 'error');
      } else {
        this.callbacks.toast(`${engine === 'upscayl' ? 'Upscayl' : 'Real-ESRGAN'} 运行时已就绪`, 'success');
      }
      await this.refreshAiStatus();
    } catch (error) {
      this.callbacks.toast(
        `下载失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    } finally {
      this.aiBusy = false;
      this.updateAiButtons();
    }
  }

  private async quickScale(scale: number): Promise<void> {
    if (!this.bitmap || this.aiBusy) return;
    const width = Math.round(this.imageWidth * scale);
    const height = Math.round(this.imageHeight * scale);
    if (width > 16384 || height > 16384) {
      this.callbacks.toast('目标尺寸超过 16384，已取消', 'error');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.bitmap as CanvasImageSource, 0, 0, width, height);
    this.showCompare(
      this.bitmap,
      this.imageWidth,
      this.imageHeight,
      canvas,
      width,
      height,
      `${this.currentBaseName()}_${scale}x.png`,
      width * height * 4
    );
    this.closeAiPanel();
    this.callbacks.toast(`已生成 ${scale}× 结果，拖动中间线对比`, 'success');
  }

  private async aiScale(scale: number): Promise<void> {
    if (!this.bitmap || this.aiBusy) return;
    if (!this.aiAvailable) {
      this.callbacks.toast(`请先下载 ${this.aiEngineLabel()} 运行时`, 'info');
      return;
    }
    if (this.imageWidth * scale > 16384 || this.imageHeight * scale > 16384) {
      this.callbacks.toast('目标尺寸超过 16384，已取消', 'error');
      return;
    }
    this.aiBusy = true;
    this.updateAiButtons();
    this.aiProgress.classList.remove('hidden');
    this.aiProgressBar.style.width = '0%';
    this.aiProgressText.textContent = '准备图片…';
    try {
      const source = document.createElement('canvas');
      source.width = this.imageWidth;
      source.height = this.imageHeight;
      const sourceContext = source.getContext('2d');
      if (!sourceContext) throw new Error('无法创建源图');
      sourceContext.drawImage(this.bitmap as CanvasImageSource, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('源图编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());

      const result = await window.nyxel.ai.upscale(data, scale, this.aiEngine, this.aiUpscaylModel);
      if (!result.ok || !result.data || !result.width || !result.height) {
        if (result.error !== '已取消') {
          this.callbacks.toast(`AI 超分失败：${result.error ?? '未知错误'}`, 'error');
        }
        return;
      }
      const output = new Blob([new Uint8Array(result.data)], { type: 'image/png' });
      const bitmap = await createImageBitmap(output);
      this.showCompare(
        this.bitmap,
        this.imageWidth,
        this.imageHeight,
        bitmap,
        result.width,
        result.height,
        `${this.currentBaseName()}_${this.aiEngine === 'upscayl' ? this.aiUpscaylModel.replace(/-4x$/, '') : 'realesrgan'}_${scale}x.png`,
        result.data.length
      );
      this.closeAiPanel();
      this.callbacks.toast(`AI 超分完成，拖动中间线对比`, 'success');
    } catch (error) {
      this.callbacks.toast(
        `AI 超分失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    } finally {
      this.aiBusy = false;
      this.updateAiButtons();
    }
  }

  private async cancelAi(): Promise<void> {
    const cancelled = await window.nyxel.ai.cancel();
    if (cancelled) this.callbacks.toast('已请求取消 AI 任务', 'info');
  }

  private showCompare(
    original: ImageBitmap | HTMLCanvasElement,
    originalWidth: number,
    originalHeight: number,
    result: ImageBitmap | HTMLCanvasElement,
    resultWidth: number,
    resultHeight: number,
    name: string,
    size: number
  ): void {
    this.discardCompare();
    this.pendingUpscale = { bitmap: result, width: resultWidth, height: resultHeight, name, size };
    this.compareOriginal.width = originalWidth;
    this.compareOriginal.height = originalHeight;
    this.compareResult.width = resultWidth;
    this.compareResult.height = resultHeight;
    this.compareOriginal.getContext('2d')?.drawImage(original as CanvasImageSource, 0, 0, originalWidth, originalHeight);
    this.compareResult.getContext('2d')?.drawImage(result as CanvasImageSource, 0, 0, resultWidth, resultHeight);
    this.compareOverlay.classList.remove('hidden');
    this.compareSplit = 0.5;
    this.updateCompareLayout();
    this.setCompareSplit(0.5);
  }

  private updateCompareLayout(): void {
    if (this.compareOverlay.classList.contains('hidden')) return;
    const stage = this.compareImage.parentElement as HTMLElement;
    const availableWidth = Math.max(1, stage.clientWidth - 36);
    const availableHeight = Math.max(1, stage.clientHeight - 36);
    const aspect = this.compareOriginal.width / Math.max(1, this.compareOriginal.height);
    let width = availableWidth;
    let height = width / aspect;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * aspect;
    }
    this.compareImage.style.width = `${Math.max(1, Math.round(width))}px`;
    this.compareImage.style.height = `${Math.max(1, Math.round(height))}px`;
    this.setCompareSplit(this.compareSplit);
  }

  private setCompareSplit(split: number): void {
    const value = Math.min(0.98, Math.max(0.02, split));
    this.compareSplit = value;
    this.compareDivider.style.left = `${value * 100}%`;
    this.compareResult.style.clipPath = `inset(0 0 0 ${value * 100}%)`;
  }

  private updateCompareFromPointer(event: PointerEvent): void {
    const rect = this.compareImage.getBoundingClientRect();
    if (rect.width <= 0) return;
    this.setCompareSplit((event.clientX - rect.left) / rect.width);
  }

  private applyCompare(): void {
    const pending = this.pendingUpscale;
    if (!pending) return;
    this.pendingUpscale = null;
    this.hideCompare();
    this.setImage(
      pending.bitmap,
      pending.width,
      pending.height,
      pending.name,
      '',
      pending.size,
      { preserveTransform: true, preserveHistory: false }
    );
    this.callbacks.toast('已应用超分结果', 'success');
  }

  private discardCompare(): void {
    const pending = this.pendingUpscale;
    this.pendingUpscale = null;
    this.hideCompare();
    if (pending?.bitmap instanceof ImageBitmap) pending.bitmap.close();
  }

  private hideCompare(): void {
    this.compareDragging = false;
    this.compareOverlay.classList.add('hidden');
    this.compareOriginal.width = 0;
    this.compareOriginal.height = 0;
    this.compareResult.width = 0;
    this.compareResult.height = 0;
  }

  private disposeImage(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.bitmap = null;
  }

  private fit(): void {
    if (!this.imageWidth || !this.imageHeight) return;
    const viewAspect = Math.max(0.001, this.body.clientWidth / Math.max(1, this.body.clientHeight));
    const imageAspect = this.imageWidth / this.imageHeight;
    const displayAspect = this.rotation % 180 === 0 ? imageAspect : 1 / imageAspect;
    if (displayAspect >= viewAspect) {
      const halfWidth = displayAspect / 2;
      const halfHeight = halfWidth / viewAspect;
      this.camera.left = -halfWidth;
      this.camera.right = halfWidth;
      this.camera.top = halfHeight;
      this.camera.bottom = -halfHeight;
    } else {
      const halfHeight = 0.5;
      const halfWidth = halfHeight * viewAspect;
      this.camera.left = -halfWidth;
      this.camera.right = halfWidth;
      this.camera.top = halfHeight;
      this.camera.bottom = -halfHeight;
    }
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.camera.zoom = 1;
    this.camera.position.set(0, 0, 1);
    this.camera.updateProjectionMatrix();
  }

  private updateCamera(): void {
    this.camera.zoom = this.zoom;
    this.camera.position.set(this.panX, this.panY, 1);
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const width = Math.max(1, this.body.clientWidth);
    const height = Math.max(1, this.body.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (this.mesh) this.fit();
    this.renderer.render(this.scene, this.camera);
    this.updateCompareLayout();
  }

  private applyTransform(): void {
    if (!this.mesh) return;
    this.mesh.rotation.z = THREE.MathUtils.degToRad(this.rotation);
    this.mesh.scale.set(this.flipH ? -1 : 1, this.flipV ? -1 : 1, 1);
  }

  private snapshot(): TransformState {
    return { rotation: this.rotation, flipH: this.flipH, flipV: this.flipV };
  }

  private restore(state: TransformState): void {
    this.rotation = state.rotation;
    this.flipH = state.flipH;
    this.flipV = state.flipV;
    this.applyTransform();
    this.fit();
  }

  private pushHistory(): void {
    this.history.push(this.snapshot());
    if (this.history.length > 20) this.history.shift();
    this.redoStack = [];
  }

  private rotate(delta: number): void {
    if (!this.mesh) return;
    this.pushHistory();
    this.rotation = (this.rotation + delta + 360) % 360;
    this.applyTransform();
    this.fit();
  }

  private flip(axis: 'h' | 'v'): void {
    if (!this.mesh) return;
    if (axis === 'h' && this.isNormalMap) {
      this.callbacks.toast('检测到法线贴图：水平翻转会改变法线左右方向，请确认用途', 'info');
    }
    this.pushHistory();
    if (axis === 'h') this.flipH = !this.flipH;
    else this.flipV = !this.flipV;
    this.applyTransform();
    this.fit();
  }

  private undo(): void {
    if (!this.history.length) return;
    this.redoStack.push(this.snapshot());
    const state = this.history.pop() as TransformState;
    this.restore(state);
  }

  private redo(): void {
    if (!this.redoStack.length) return;
    this.history.push(this.snapshot());
    const state = this.redoStack.pop() as TransformState;
    this.restore(state);
  }

  private setChannel(value: number): void {
    this.channel = value;
    if (this.material) this.material.uniforms.uChannel.value = value;
    this.element.querySelectorAll('[data-channel]').forEach((button) => {
      button.classList.toggle('active', Number((button as HTMLElement).dataset.channel) === value);
    });
  }

  private setMono(value: boolean): void {
    this.mono = value;
    const button = this.element.querySelector('#mono-toggle') as HTMLButtonElement | null;
    if (button) button.classList.toggle('active', value);
    this.levelsInline.classList.toggle('hidden', !value);
    this.updateLevelUniforms();
    this.callbacks.status.set(this.fileName, this.metaText());
  }

  private resetLevels(): void {
    this.levelBlack = 0;
    this.levelWhite = 255;
    this.levelGamma = 1;
    this.syncLevelInputs();
    this.updateLevelUniforms();
  }

  private syncLevelInputs(): void {
    this.levelBlackInput.value = String(this.levelBlack);
    this.levelWhiteInput.value = String(this.levelWhite);
    this.levelGammaInput.value = String(this.levelGamma);
    this.levelBlackInput.max = String(this.levelWhite - 1);
    this.levelWhiteInput.min = String(this.levelBlack + 1);
    this.levelBlackValue.textContent = String(this.levelBlack);
    this.levelWhiteValue.textContent = String(this.levelWhite);
    this.levelGammaValue.textContent = this.levelGamma.toFixed(2);
  }

  private updateLevelUniforms(): void {
    if (!this.material) return;
    this.material.uniforms.uMono.value = this.mono ? 1 : 0;
    this.material.uniforms.uBlack.value = this.levelBlack / 255;
    this.material.uniforms.uWhite.value = Math.max(this.levelBlack + 1, this.levelWhite) / 255;
    this.material.uniforms.uGamma.value = Math.max(0.01, this.levelGamma);
  }

  private applyMonoToCanvas(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const black = this.levelBlack / 255;
    const range = Math.max(1 / 255, (this.levelWhite - this.levelBlack) / 255);
    const inverseGamma = 1 / Math.max(0.01, this.levelGamma);
    for (let index = 0; index < image.data.length; index += 4) {
      const r = image.data[index] / 255;
      const g = image.data[index + 1] / 255;
      const b = image.data[index + 2] / 255;
      const gray = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const level = Math.pow(Math.min(1, Math.max(0, (gray - black) / range)), inverseGamma);
      const value = Math.round(level * 255);
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
    }
    context.putImageData(image, 0, 0);
  }

  private setBackground(value: 'black' | 'gray' | 'checker'): void {
    this.background = value;
    this.body.classList.remove('bg-black', 'bg-gray', 'bg-checker');
    this.body.classList.add(`bg-${value}`);
    this.element.querySelectorAll('[data-bg]').forEach((button) => {
      button.classList.toggle('active', (button as HTMLElement).dataset.bg === value);
    });
  }

  private probe(event: PointerEvent): void {
    if (!this.mesh || !this.bitmap) return;
    const rect = this.canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      return;
    }
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv) return;
    let u = hit.uv.x;
    let v = hit.uv.y;
    if (this.flipH) u = 1 - u;
    if (this.flipV) v = 1 - v;
    const x = Math.min(this.imageWidth - 1, Math.max(0, Math.floor(u * this.imageWidth)));
    const y = Math.min(this.imageHeight - 1, Math.max(0, Math.floor((1 - v) * this.imageHeight)));
    this.probeCtx.clearRect(0, 0, 1, 1);
    this.probeCtx.drawImage(this.bitmap as CanvasImageSource, x, y, 1, 1, 0, 0, 1, 1);
    const [r, g, b, a] = this.probeCtx.getImageData(0, 0, 1, 1).data;
    const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    this.callbacks.status.set(
      this.fileName,
      `X ${x}  Y ${y}   R ${r}  G ${g}  B ${b}  A ${a}   ${hex}   ${(r / 255).toFixed(2)}, ${(g / 255).toFixed(2)}, ${(b / 255).toFixed(2)}, ${(a / 255).toFixed(2)}`
    );
  }

  private metaText(): string {
    return `${this.imageWidth} × ${this.imageHeight} · ${formatBytes(this.fileSize)}`;
  }

  activate(): void {
    this.active = true;
    this.resize();
    const loop = () => {
      if (!this.active) return;
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  deactivate(): void {
    this.active = false;
    cancelAnimationFrame(this.raf);
  }
}

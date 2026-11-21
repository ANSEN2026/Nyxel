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

interface PenPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

interface PenSample {
  x: number;
  y: number;
  t: number;
}

const UPSCAYL_MODEL_LABELS: Record<string, string> = {
  'ultrasharp-4x': 'Ultrasharp 4x · 锐利（线条推荐）',
  'upscayl-standard-4x': 'Standard 4x · 通用',
  'ultramix-balanced-4x': 'Ultramix Balanced 4x · 均衡',
  'remacri-4x': 'Remacri 4x · 照片'
};

const REALESRGAN_MODEL_LABELS: Record<string, string> = {
  'realesrgan-x4plus-anime': 'Anime x4 · 线条 / 特效贴图',
  'realesrgan-x4plus': 'x4plus · 通用 / 照片'
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
  uniform sampler2D uCurve;
  uniform int uChannel;
  uniform int uLevels;
  uniform int uCurves;
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
    if (uLevels == 1) {
      float range = max(0.0001, uWhite - uBlack);
      vec3 level = clamp((color.rgb - uBlack) / range, 0.0, 1.0);
      level = pow(level, vec3(1.0 / max(0.0001, uGamma)));
      color.rgb = level;
    }
    if (uCurves == 1) {
      color.r = texture2D(uCurve, vec2(clamp(color.r, 0.0, 1.0), 0.5)).r;
      color.g = texture2D(uCurve, vec2(clamp(color.g, 0.0, 1.0), 0.5)).r;
      color.b = texture2D(uCurve, vec2(clamp(color.b, 0.0, 1.0), 0.5)).r;
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
  private levelsEnabled = false;
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

  private composeOverlay: HTMLElement;
  private composePreview: HTMLCanvasElement;
  private composePreviewCtx: CanvasRenderingContext2D;
  private composeSource: { name: string; bitmap: ImageBitmap | HTMLCanvasElement } | null = null;
  private composeSourceName: HTMLElement;
  private composeParentThumb: HTMLImageElement;
  private composeChildThumb: HTMLImageElement;
  private composeChildEmpty: HTMLElement;
  private composeParentName: HTMLElement;
  private composeParentBlend: HTMLSelectElement;
  private composeParentOpacity: HTMLInputElement;
  private composeParentOpacityValue: HTMLElement;
  private composeChildBlend: HTMLSelectElement;
  private composeChildOpacity: HTMLInputElement;
  private composeChildOpacityValue: HTMLElement;
  private composeTarget: HTMLSelectElement;
  private composeAlphaMode: HTMLSelectElement;
  private composeChildGroup: HTMLElement;
  private composeAddChild: HTMLButtonElement;
  private composeColorRow: HTMLElement;
  private composeChannelRow: HTMLElement;
  private composeFeatherRow: HTMLElement;
  private composeKey: HTMLInputElement;
  private composeTolerance: HTMLInputElement;
  private composeToleranceValue: HTMLElement;
  private composeFeather: HTMLInputElement;
  private composeFeatherValue: HTMLElement;
  private composeGroupDrag: { group: HTMLElement; pointerId: number; grip: HTMLElement } | null = null;
  private composeChannel: HTMLSelectElement;
  private composeInvert: HTMLInputElement;
  private composePickButton: HTMLButtonElement;
  private composePreviewTimer = 0;
  private composeBusy = false;
  private composePicking = false;
  private textureMenu: HTMLElement;

  private curvesEnabled = false;
  private curvePanel: HTMLElement;
  private curveCanvas: HTMLCanvasElement;
  private curveCtx: CanvasRenderingContext2D;
  private curveToggle: HTMLButtonElement;
  private curvePoints: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  private curveDragIndex = -1;
  private curveData = new Uint8Array(256 * 4);
  private curveTexture: THREE.DataTexture;

  private aiOverlay: HTMLElement;
  private aiPluginWarning: HTMLElement;
  private aiRuntime: HTMLElement;
  private aiProgress: HTMLElement;
  private aiProgressBar: HTMLElement;
  private aiProgressText: HTMLElement;
  private aiEngineSelect: HTMLSelectElement;
  private aiEngine: AiEngine = 'upscayl';
  private aiModelRow: HTMLElement;
  private aiModelSelect: HTMLSelectElement;
  private aiUpscaylModel = 'ultrasharp-4x';
  private aiRealesrganModel = 'realesrgan-x4plus-anime';
  private aiAvailable = false;
  private aiBusy = false;

  private composePanel: HTMLElement;
  private composeBody: HTMLElement;
  private aiPanelBody: HTMLElement;
  private toolsPanelBody: HTMLElement;
  private aiEntryButton: HTMLButtonElement;
  private toolsEntryButton: HTMLButtonElement;
  private detailTabButton: HTMLButtonElement;
  private panelMode: 'detail' | 'ai' | 'tools' = 'detail';
  private aiMode = false;
  private aiPanelStatus: HTMLElement;
  private aiCutTolerance: HTMLInputElement;
  private aiCutToleranceValue: HTMLElement;
  private aiCutFeather: HTMLInputElement;
  private aiCutFeatherValue: HTMLElement;
  private aiCutRestoreButton: HTMLButtonElement;
  private aiCutoutBackup: {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    name: string;
    path: string;
    size: number;
  } | null = null;

  private tilePreview: HTMLCanvasElement;
  private tilePreviewCtx: CanvasRenderingContext2D;
  private tileRepeatX: HTMLInputElement;
  private tileRepeatY: HTMLInputElement;
  private tileOffsetX: HTMLInputElement;
  private tileOffsetXValue: HTMLInputElement;
  private tileOffsetY: HTMLInputElement;
  private tileOffsetYValue: HTMLInputElement;
  private tileMode: HTMLSelectElement;
  private tileEdgeBlend: HTMLInputElement;
  private tileSharp: HTMLInputElement;
  private tileBlend: HTMLInputElement;
  private tileBlendValue: HTMLElement;
  private tileSeed: HTMLInputElement;
  private tileCustomSize: HTMLInputElement;
  private tileWidth: HTMLInputElement;
  private tileHeight: HTMLInputElement;
  private tileOutput: HTMLCanvasElement | null = null;
  private tilePreviewTimer = 0;

  private dispersionPreview: HTMLCanvasElement;
  private dispersionCtx: CanvasRenderingContext2D;
  private dispersionMode: HTMLSelectElement;
  private dispersionTransparent: HTMLInputElement;
  private dispersionOffsetX: HTMLInputElement;
  private dispersionOffsetXValue: HTMLInputElement;
  private dispersionOffsetY: HTMLInputElement;
  private dispersionOffsetYValue: HTMLInputElement;
  private dispersionBlack = false;
  private dispersionOutput: HTMLCanvasElement | null = null;
  private dispersionTimer = 0;

  private gradientPreview: HTMLCanvasElement;
  private gradientCtx: CanvasRenderingContext2D;
  private gradientBarFill: HTMLElement;
  private gradientBarMarkers: HTMLElement;
  private gradientAlphaBarFill: HTMLElement;
  private gradientAlphaMarkers: HTMLElement;
  private gradientColor: HTMLInputElement;
  private gradientPosition: HTMLInputElement;
  private gradientAlpha: HTMLInputElement;
  private gradientAlphaValue: HTMLElement;
  private gradientStatus: HTMLElement;
  private gradientStops: Array<{ position: number; color: string }> = [
    { position: 0, color: '#ff7878' },
    { position: 100, color: '#ff3b3b' }
  ];
  private gradientAlphaStops: Array<{ position: number; alpha: number }> = [
    { position: 0, alpha: 1 },
    { position: 100, alpha: 1 }
  ];
  private gradientSelected = 1;
  private gradientAlphaSelected = 1;
  private gradientTimer = 0;

  private pathPreview: HTMLCanvasElement;
  private pathCtx: CanvasRenderingContext2D;
  private pathWidth: HTMLInputElement;
  private pathWidthValue: HTMLInputElement;
  private pathHardness: HTMLInputElement;
  private pathHardnessValue: HTMLInputElement;
  private pathHeadWidth: HTMLInputElement;
  private pathHeadWidthValue: HTMLInputElement;
  private pathMiddleWidth: HTMLInputElement;
  private pathMiddleWidthValue: HTMLInputElement;
  private pathTailWidth: HTMLInputElement;
  private pathTailWidthValue: HTMLInputElement;
  private pathOpacity: HTMLInputElement;
  private pathOpacityValue: HTMLInputElement;
  private pathCustomSize: HTMLInputElement;
  private pathEqual: HTMLInputElement;
  private pathShow: HTMLInputElement;
  private pathSizeW: HTMLInputElement;
  private pathSizeH: HTMLInputElement;
  private pathStatus: HTMLElement;
  private pathOutput: HTMLCanvasElement | null = null;
  private pathTimer = 0;
  private penOverlay: HTMLCanvasElement;
  private penCtx: CanvasRenderingContext2D;
  private penEffectCanvas = document.createElement('canvas');
  private penEffectCtx: CanvasRenderingContext2D;
  private penPoints: PenPoint[] = [];
  private penEditing = false;
  private penVisible = true;
  private penDrag: { kind: 'anchor' | 'in' | 'out' | 'new'; index: number; moved: boolean } | null = null;
  private penPanning = false;
  private penPanX = 0;
  private penPanY = 0;

  private aiSeqSource: HTMLSelectElement;
  private aiSeqCols: HTMLInputElement;
  private aiSeqRows: HTMLInputElement;
  private aiSeqGrid: HTMLCanvasElement;
  private aiSeqGridCtx: CanvasRenderingContext2D;
  private aiSeqPreview: HTMLCanvasElement;
  private aiSeqPreviewCtx: CanvasRenderingContext2D;
  private aiSeqCount: HTMLElement;
  private aiSeqStatus: HTMLElement;
  private aiSeqPlayButton: HTMLButtonElement;
  private aiSeqFps: HTMLInputElement;
  private aiSeqFpsValue: HTMLElement;
  private aiSeqLoop: HTMLInputElement;
  private aiSeqSelected = new Set<number>();
  private aiSeqLastCell = -1;
  private aiSeqPlaying = false;
  private aiSeqRaf = 0;
  private aiSeqFrameIndex = 0;
  private aiSeqLastTime = 0;
  private aiSeqLayout = { x: 0, y: 0, width: 1, height: 1, cellWidth: 1, cellHeight: 1 };

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
      <div class="view-toolbar texture-actionbar">
        <button class="primary" data-action="open">打开贴图</button>
        <span class="spacer"></span>
        <button data-action="ai" title="AI 超分">超分</button>
        <button data-action="export" title="导出 PNG">导出</button>
        <span class="toolbar-sep"></span>
        <button data-action="undo">撤销</button>
        <button data-action="redo">重做</button>
      </div>
      <div class="view-body texture-body bg-checker">
        <canvas class="view-canvas"></canvas>
        <canvas class="pen-overlay hidden"></canvas>
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
        <div class="compose-panel hidden">
          <div class="compose-panel-head">
            <button type="button" class="compose-tab detail-tab active" data-compose-tab="detail" role="tab" aria-selected="true">
              <strong>细节调节</strong>
              <span>父级 / 子级</span>
            </button>
            <button type="button" class="compose-tab ai-tab" data-ai-panel-toggle role="tab" aria-selected="false" title="打开 AI 调节">
              <strong>AI 调节</strong>
              <span>超分 / 抠图 / 序列</span>
            </button>
            <button type="button" class="compose-tab tools-tab" data-tools-panel-toggle role="tab" aria-selected="false" title="打开工具">
              <strong>工具</strong>
              <span>平铺 / 色散 / 渐变</span>
            </button>
            <button type="button" class="compose-add-child" data-compose-add-child title="载入附件图 2">＋ 附件</button>
          </div>
          <div class="ai-panel-body hidden">
            <div class="ai-panel-tools">
              <span>AI 模块</span>
              <span class="spacer"></span>
              <button type="button" data-ai-expand-all>展开全部</button>
              <button type="button" data-ai-collapse-all>收起全部</button>
            </div>
            <section class="ai-section" data-ai-section="upscale">
              <div class="ai-section-head"><span>AI 超分 / 无损放大</span><span class="ai-pill">GPU</span></div>
              <p class="ai-copy">使用本地 Upscayl / Real-ESRGAN 运行时，首次使用需下载模型；图片不会上传。</p>
              <div class="ai-panel-status" id="ai-panel-status">检查 AI 运行时…</div>
              <div class="ai-button-row">
                <button type="button" data-ai-panel-scale="2">2× 超分</button>
                <button type="button" class="primary" data-ai-panel-scale="4">4× 无损放大</button>
                <button type="button" data-ai-panel-settings>详细设置</button>
              </div>
            </section>

            <section class="ai-section" data-ai-section="cutout">
              <div class="ai-section-head"><span>AI 抠图</span><span class="ai-pill">本地</span></div>
              <p class="ai-copy">自动从图像边缘识别背景，保留主体并平滑边缘，不上传图片。</p>
              <div class="ai-row">
                <span>容差</span>
                <input id="ai-cut-tolerance" type="range" min="0" max="128" step="1" value="28">
                <span id="ai-cut-tolerance-value">28</span>
              </div>
              <div class="ai-row">
                <span>柔边</span>
                <input id="ai-cut-feather" type="range" min="0" max="24" step="1" value="6">
                <span id="ai-cut-feather-value">6</span>
              </div>
              <div class="ai-button-row">
                <button type="button" class="primary" data-ai-cut>一键抠图</button>
                <button type="button" data-ai-cut-restore disabled>还原抠图</button>
              </div>
            </section>

            <section class="ai-section tile-section" data-ai-section="tile">
              <div class="ai-section-head"><span>平铺合成</span><span class="ai-pill">无缝</span></div>
              <p class="ai-copy">把图片合成为无缝平铺贴图，可控制重复、位移、边缘融合和输出尺寸。</p>
              <div class="tile-preview-wrap">
                <canvas id="tile-preview" width="320" height="320"></canvas>
              </div>
              <div class="ai-button-row tile-actions">
                <button type="button" class="primary" data-tile-apply>应用</button>
                <button type="button" data-tile-export>导出 PNG</button>
                <button type="button" data-tile-reset>重置</button>
              </div>
              <div class="tile-pair">
                <label>水平重复 <input id="tile-repeat-x" type="number" min="1" max="8" value="1"></label>
                <label>垂直重复 <input id="tile-repeat-y" type="number" min="1" max="8" value="1"></label>
              </div>
              <div class="tile-slider-row">
                <span>水平位移</span>
                <input id="tile-offset-x" type="range" min="0" max="2048" step="1" value="0">
                <input id="tile-offset-x-value" class="tile-number" type="number" min="0" max="4096" step="1" value="0">
              </div>
              <div class="tile-slider-row">
                <span>垂直位移</span>
                <input id="tile-offset-y" type="range" min="0" max="2048" step="1" value="0">
                <input id="tile-offset-y-value" class="tile-number" type="number" min="0" max="4096" step="1" value="0">
              </div>
              <div class="tile-mode-row">
                <span>混合模式</span>
                <select id="tile-mode">
                  <option value="both" selected>四方连续</option>
                  <option value="horizontal">左右二方连续</option>
                  <option value="vertical">上下二方连续</option>
                </select>
              </div>
              <div class="tile-checks">
                <label><input id="tile-edge-blend" type="checkbox" checked> 边缘混合</label>
                <label><input id="tile-sharp" type="checkbox"> 清晰衔接</label>
              </div>
              <div class="tile-slider-row">
                <span>边缘混合</span>
                <input id="tile-blend" type="range" min="0" max="50" step="1" value="20">
                <span id="tile-blend-value">20%</span>
              </div>
              <div class="tile-row">
                <span>随机种子</span>
                <input id="tile-seed" type="number" min="1" max="9999" step="1" value="1">
              </div>
              <div class="tile-row tile-custom-row">
                <label><input id="tile-custom-size" type="checkbox"> 启用自定义尺寸</label>
                <div class="tile-size-inputs">
                  <input id="tile-width" type="number" min="1" max="4096" value="512" disabled>
                  <input id="tile-height" type="number" min="1" max="4096" value="512" disabled>
                </div>
              </div>
            </section>

            <section class="ai-section dispersion-section" data-ai-section="dispersion">
              <div class="ai-section-head"><span>色散分离</span><span class="ai-pill">RGB</span></div>
              <p class="ai-copy">RGB 通道水平 / 垂直色散，用于故障风、镜头色差和边缘分离。</p>
              <div class="dispersion-preview-wrap" id="dispersion-preview-wrap">
                <canvas id="dispersion-preview" width="320" height="320"></canvas>
              </div>
              <div class="ai-button-row">
                <button type="button" class="primary" data-dispersion-apply>应用</button>
                <button type="button" data-dispersion-export>导出 PNG</button>
                <button type="button" data-dispersion-reset>重置</button>
                <button type="button" data-dispersion-black>黑底</button>
              </div>
              <div class="tile-mode-row">
                <span>模式</span>
                <select id="dispersion-mode">
                  <option value="b" selected>B / 蓝通道</option>
                  <option value="r">R / 红通道</option>
                  <option value="g">G / 绿通道</option>
                </select>
              </div>
              <div class="tile-checks">
                <label><input id="dispersion-transparent" type="checkbox" checked> PNG 位移样式（保留透明边缘）</label>
              </div>
              <div class="tile-slider-row">
                <span>水平位移</span>
                <input id="dispersion-offset-x" type="range" min="-20" max="20" step="1" value="2">
                <input id="dispersion-offset-x-value" class="tile-number" type="number" min="-20" max="20" step="1" value="2">
              </div>
              <div class="dispersion-quick-row">
                <button type="button" data-dispersion-x="-3">-3</button>
                <button type="button" data-dispersion-x="-2">-2</button>
                <button type="button" data-dispersion-x="2">+2</button>
                <button type="button" data-dispersion-x="3">+3</button>
              </div>
              <div class="tile-slider-row">
                <span>垂直位移</span>
                <input id="dispersion-offset-y" type="range" min="-20" max="20" step="1" value="-2">
                <input id="dispersion-offset-y-value" class="tile-number" type="number" min="-20" max="20" step="1" value="-2">
              </div>
              <div class="dispersion-quick-row">
                <button type="button" data-dispersion-y="-3">-3</button>
                <button type="button" data-dispersion-y="-2">-2</button>
                <button type="button" data-dispersion-y="2">+2</button>
                <button type="button" data-dispersion-y="3">+3</button>
              </div>
            </section>

            <section class="ai-section" data-ai-section="sequence">
              <div class="ai-section-head"><span>AI 序列贴图</span><span class="ai-pill">帧</span></div>
              <p class="ai-copy">把序列帧拼图按网格拆分，点击格子选择帧，可逐帧播放和取用当前帧。</p>
              <div class="ai-row">
                <span>来源</span>
                <select id="ai-seq-source">
                  <option value="parent" selected>当前贴图</option>
                  <option value="child">附件图 2</option>
                </select>
              </div>
              <div class="ai-row">
                <span>网格</span>
                <div class="ai-grid-inputs">
                  <label>列 <input id="ai-seq-cols" type="number" min="1" max="32" value="7"></label>
                  <label>行 <input id="ai-seq-rows" type="number" min="1" max="32" value="7"></label>
                </div>
              </div>
              <div class="ai-seq-grid-wrap"><canvas id="ai-seq-grid" width="360" height="260"></canvas></div>
              <div class="ai-button-row ai-seq-select-row">
                <button type="button" data-ai-seq-all>全选</button>
                <button type="button" data-ai-seq-row>选中行</button>
                <button type="button" data-ai-seq-clear>清空</button>
                <span id="ai-seq-count">0 / 0</span>
              </div>
              <div class="ai-seq-player">
                <canvas id="ai-seq-preview" width="160" height="120"></canvas>
                <div class="ai-seq-controls">
                  <button type="button" data-ai-seq-play>播放</button>
                  <label>帧率 <input id="ai-seq-fps" type="range" min="1" max="30" step="1" value="12"><span id="ai-seq-fps-value">12</span></label>
                  <label class="ai-loop"><input id="ai-seq-loop" type="checkbox" checked> 循环</label>
                </div>
                <div class="ai-seq-status" id="ai-seq-status">选择帧后开始播放</div>
              </div>
              <div class="ai-button-row">
                <button type="button" class="primary" data-ai-seq-apply>应用当前帧</button>
                <button type="button" data-ai-panel-back>返回贴图调节</button>
              </div>
            </section>
          </div>
          <div class="tools-panel-body hidden">
            <div class="ai-panel-tools">
              <span>工具模块</span>
              <span class="spacer"></span>
              <button type="button" data-tools-expand-all>展开全部</button>
              <button type="button" data-tools-collapse-all>收起全部</button>
            </div>
            <section class="ai-section gradient-section" data-ai-section="gradient">
              <div class="ai-section-head"><span>渐变图</span><span class="ai-pill">渐变编辑</span></div>
              <p class="ai-copy">点击色条添加色标；左键色标调色，右键删除，拖动调整位置。</p>
              <div class="gradient-preview-wrap"><canvas id="gradient-preview" width="320" height="220"></canvas></div>
              <div class="gradient-alpha-bar" id="gradient-alpha-bar" title="透明度标：左键添加，右键删除，拖动调整位置">
                <div class="gradient-alpha-fill" id="gradient-alpha-fill"></div>
                <div class="gradient-alpha-markers" id="gradient-alpha-markers"></div>
              </div>
              <div class="gradient-bar" id="gradient-bar" title="颜色标：左键添加，右键删除，拖动调整位置">
                <div class="gradient-bar-fill" id="gradient-bar-fill"></div>
                <div class="gradient-bar-markers" id="gradient-bar-markers"></div>
              </div>
              <div class="gradient-edit-row">
                <label>位置 <input id="gradient-position" type="number" min="0" max="100" step="1" value="100"><span>%</span></label>
                <input id="gradient-color" class="gradient-color-input" type="color" value="#ff7878" tabindex="-1" aria-hidden="true">
              </div>
              <div class="gradient-edit-row">
                <label>透明度 <input id="gradient-alpha" type="range" min="0" max="1" step="0.01" value="1"><span id="gradient-alpha-value">1.00</span></label>
              </div>
              <div class="ai-button-row">
                <button type="button" class="primary" data-gradient-apply>创建贴图</button>
                <button type="button" data-gradient-export>导出</button>
                <button type="button" data-gradient-reset>恢复默认</button>
              </div>
              <div class="gradient-status" id="gradient-status">左键色标调色 · 右键删除 · 拖动调整</div>
            </section>

            <section class="ai-section path-gradient-section" data-ai-section="path">
              <div class="ai-section-head"><span>路径渐变</span><span class="ai-pill">钢笔</span></div>
              <p class="ai-copy">用钢笔在左侧贴图上绘制路径，颜色读取「渐变图」，沿路径生成头→尾笔触。</p>
              <div class="dispersion-preview-wrap path-preview-wrap">
                <canvas id="path-preview" width="320" height="220"></canvas>
              </div>
              <div class="ai-button-row">
                <button type="button" data-path-pen>钢笔工具</button>
                <button type="button" data-path-pick>拾取路径</button>
                <button type="button" data-path-reset>恢复默认</button>
              </div>
              <div class="tile-slider-row">
                <span>笔触宽度</span>
                <input id="path-width" type="range" min="1" max="100" step="1" value="59">
                <input id="path-width-value" class="tile-number" type="number" min="1" max="100" value="59">
              </div>
              <div class="tile-slider-row">
                <span>硬度</span>
                <input id="path-hardness" type="range" min="0" max="100" step="1" value="70">
                <input id="path-hardness-value" class="tile-number" type="number" min="0" max="100" value="70">
              </div>
              <div class="tile-slider-row">
                <span>头部粗细</span>
                <input id="path-head-width" type="range" min="0" max="200" step="1" value="100">
                <input id="path-head-width-value" class="tile-number" type="number" min="0" max="200" value="100">
              </div>
              <div class="tile-slider-row">
                <span>中部粗细</span>
                <input id="path-middle-width" type="range" min="0" max="200" step="1" value="100">
                <input id="path-middle-width-value" class="tile-number" type="number" min="0" max="200" value="100">
              </div>
              <div class="tile-slider-row">
                <span>尾部粗细</span>
                <input id="path-tail-width" type="range" min="0" max="200" step="1" value="100">
                <input id="path-tail-width-value" class="tile-number" type="number" min="0" max="200" value="100">
              </div>
              <div class="tile-slider-row">
                <span>透明度</span>
                <input id="path-opacity" type="range" min="0" max="100" step="1" value="100">
                <input id="path-opacity-value" class="tile-number" type="number" min="0" max="100" value="100">
              </div>
              <div class="tile-checks">
                <label><input id="path-show" type="checkbox" checked> 显示路径</label>
                <label><input id="path-custom-size" type="checkbox"> 启用自定义尺寸</label>
                <label><input id="path-equal" type="checkbox" checked> 等比</label>
              </div>
              <div class="tile-row path-size-row">
                <span>尺寸</span>
                <input id="path-size-w" type="number" min="1" max="4096" value="687" disabled>
                <span>×</span>
                <input id="path-size-h" type="number" min="1" max="4096" value="794" disabled>
              </div>
              <div class="ai-button-row">
                <button type="button" class="primary" data-path-apply>应用</button>
                <button type="button" data-path-export>导出</button>
                <button type="button" data-path-clear>清除路径</button>
              </div>
              <div class="gradient-status" id="path-status">先用钢笔在左侧绘制路径</div>
            </section>
          </div>
          <div class="compose-panel-body">
            <section class="compose-group" data-compose-group="parent">
              <div class="compose-group-title">父级图片</div>
              <div class="compose-layer parent">
                <span class="compose-layer-badge">父</span>
                <div class="compose-thumb"><img id="compose-parent-thumb" alt=""></div>
                <div class="compose-layer-text">
                  <strong>父级 · 当前贴图</strong>
                  <span id="compose-parent-name">当前贴图</span>
                </div>
              </div>
              <div class="compose-subgroup">
                <div class="compose-row">
                  <span class="compose-label">混合模式</span>
                  <select id="compose-parent-blend">
                    <option value="source-over" selected>正常</option>
                    <option value="multiply">正片叠底</option>
                    <option value="screen">滤色</option>
                    <option value="overlay">叠加</option>
                    <option value="darken">变暗</option>
                    <option value="lighten">变亮</option>
                  </select>
                </div>
                <div class="compose-row">
                  <span class="compose-label">不透明度</span>
                  <input id="compose-parent-opacity" type="range" min="0" max="100" step="1" value="100">
                  <span id="compose-parent-opacity-value" class="compose-value">100%</span>
                </div>
              </div>
            </section>

            <section class="compose-group" data-compose-group="child">
              <div class="compose-group-title">子级图片</div>
              <div class="compose-layer child standalone">
                <span class="compose-layer-badge child">子</span>
                <div class="compose-thumb">
                  <img id="compose-child-thumb" alt="">
                  <span id="compose-child-empty">图片 2</span>
                </div>
                <div class="compose-layer-text">
                  <strong>子级 · 附件图 2</strong>
                  <span id="compose-source-name">未载入</span>
                </div>
                <div class="compose-layer-actions">
                  <button data-compose-load>载入</button>
                  <button data-compose-clear>清除</button>
                </div>
              </div>
              <div class="compose-subgroup">
                <div class="compose-row">
                  <span class="compose-label">混合模式</span>
                  <select id="compose-child-blend">
                    <option value="source-over" selected>正常</option>
                    <option value="multiply">正片叠底</option>
                    <option value="screen">滤色</option>
                    <option value="overlay">叠加</option>
                    <option value="darken">变暗</option>
                    <option value="lighten">变亮</option>
                  </select>
                </div>
                <div class="compose-row">
                  <span class="compose-label">不透明度</span>
                  <input id="compose-child-opacity" type="range" min="0" max="100" step="1" value="100">
                  <span id="compose-child-opacity-value" class="compose-value">100%</span>
                </div>
              </div>
            </section>

            <section class="compose-group" data-compose-group="view">
              <div class="compose-group-title">视图</div>
              <div class="compose-view-tools">
                <div class="compose-view-row">
                  <button data-action="pack" class="compose-tool-button" title="通道打包">打包…</button>
                  <span class="compose-view-hint">右键画布：适配 / 旋转 / 翻转</span>
                </div>
                <div class="compose-view-row">
                  <span class="compose-view-label">通道</span>
                  <div class="segmented" data-group="channel">
                    <button data-channel="0" class="active">RGBA</button>
                    <button data-channel="1">R</button>
                    <button data-channel="2">G</button>
                    <button data-channel="3">B</button>
                    <button data-channel="4">A</button>
                  </div>
                </div>
                <div class="compose-view-row">
                  <span class="compose-view-label">背景</span>
                  <div class="segmented" data-group="bg">
                    <button data-bg="black">黑</button>
                    <button data-bg="gray">灰</button>
                    <button data-bg="checker" class="active">棋盘</button>
                  </div>
                </div>
              </div>
            </section>

            <section class="compose-group" data-compose-group="adjust">
              <div class="compose-group-title">调整</div>
              <div class="compose-view-row">
                <span class="compose-view-label">调整</span>
                <button data-action="mono" id="mono-toggle">色阶</button>
                <button type="button" id="curve-toggle">曲线</button>
              </div>
              <div class="levels-inline hidden">
                <label>黑场 <input id="level-black" type="range" min="0" max="254" step="1" value="0"><span id="level-black-value">0</span></label>
                <label>白场 <input id="level-white" type="range" min="1" max="255" step="1" value="255"><span id="level-white-value">255</span></label>
                <label>伽马 <input id="level-gamma" type="range" min="0.1" max="3" step="0.01" value="1"><span id="level-gamma-value">1.00</span></label>
                <button data-action="levels-reset">重置</button>
              </div>
              <div class="curve-editor hidden">
                <canvas id="curve-canvas" width="260" height="130"></canvas>
                <div class="curve-hint">拖动控制点调整曲线；双击空白添加，双击控制点删除</div>
                <button type="button" data-curve-reset>重置曲线</button>
              </div>
            </section>

            <section class="compose-group" data-compose-group="transparency">
              <div class="compose-group-title">透明处理</div>
              <div class="compose-row">
                <span class="compose-label">目标</span>
                <select id="compose-target">
                  <option value="source" selected>子级 · 附件图 2</option>
                  <option value="base">父级 · 当前图</option>
                </select>
                <select id="compose-alpha-mode">
                  <option value="none">不处理</option>
                  <option value="color" selected>删除底色</option>
                  <option value="channel">通道遮罩</option>
                </select>
              </div>
              <div class="compose-row" id="compose-color-row">
                <span class="compose-label">底色</span>
                <input id="compose-key" type="color" value="#ffffff">
                <button data-compose-pick title="从预览拾取底色">拾取</button>
                <label class="compose-inline">容差
                  <input id="compose-tolerance" type="range" min="0" max="128" step="1" value="18">
                  <span id="compose-tolerance-value">18</span>
                </label>
              </div>
              <div class="compose-row" id="compose-feather-row">
                <span class="compose-label">柔边</span>
                <input id="compose-feather" type="range" min="0" max="32" step="1" value="0">
                <span id="compose-feather-value" class="compose-value">0</span>
              </div>
              <div class="compose-row hidden" id="compose-channel-row">
                <span class="compose-label">遮罩通道</span>
                <select id="compose-channel">
                  <option value="l" selected>亮度</option>
                  <option value="r">R</option>
                  <option value="g">G</option>
                  <option value="b">B</option>
                  <option value="a">A</option>
                </select>
                <label class="compose-inline"><input id="compose-invert" type="checkbox"> 反向</label>
              </div>
            </section>

            <section class="compose-group" data-compose-group="preview">
              <div class="compose-group-title">预览</div>
              <div class="pack-preview-wrap compose-preview-wrap"><canvas id="compose-preview"></canvas></div>
              <div class="pack-actions">
                <span class="pack-hint" id="compose-size"></span>
                <span class="spacer"></span>
                <button class="primary" data-compose-apply title="应用到当前贴图">应用</button>
                <button data-compose-export title="导出 PNG">导出</button>
              </div>
            </section>
          </div>
        </div>
        <div class="pack-overlay ai-overlay hidden">
          <div class="pack-card ai-card">
            <div class="pack-header">
              <h3>AI 超分</h3>
              <button class="ghost" data-ai-close title="关闭">×</button>
            </div>
            <div class="plugin-warning ai-plugin-warning" id="ai-plugin-warning">
              <span class="plugin-warning-icon">!</span>
              <div class="plugin-warning-body">
                <strong>需要下载外部运行时</strong>
                <span>AI 超分依赖 Upscayl / Real-ESRGAN 运行时和模型（约 33–45 MB），首次使用会联网下载，之后可离线使用。</span>
              </div>
            </div>
            <div class="ai-engine-row">
              <label for="ai-engine">超分引擎</label>
              <select id="ai-engine">
                <option value="upscayl">Upscayl</option>
                <option value="realesrgan">Real-ESRGAN</option>
              </select>
            </div>
            <div class="ai-engine-row" id="ai-model-row">
              <label for="ai-model">超分模型</label>
              <select id="ai-model">
                <option value="ultrasharp-4x">Ultrasharp 4x · 锐利（线条推荐）</option>
                <option value="upscayl-standard-4x">Standard 4x · 通用</option>
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
              <div class="ai-group-title" id="ai-engine-label">AI 超分（Upscayl Ultrasharp 4x）</div>
              <div class="ai-buttons">
                <button data-ai-scale="2">2×</button>
                <button data-ai-scale="3">3×</button>
                <button data-ai-scale="4">4×</button>
              </div>
            </div>
            <div class="ai-group">
              <div class="ai-group-title">特效贴图预设</div>
              <div class="ai-buttons">
                <button data-ai-preset="vfx" title="Real-ESRGAN Anime：线条干净、边缘清晰，适合遮罩和特效贴图；纹理会被适度平滑">线条 / 特效 4×</button>
                <button data-ai-preset="texture" title="Upscayl Ultrasharp：强化纹理和边缘细节，可能放大噪点">纹理细节 4×</button>
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
    this.composePanel = this.element.querySelector('.compose-panel') as HTMLElement;
    this.composeOverlay = this.composePanel;
    this.composeBody = this.element.querySelector('.compose-panel-body') as HTMLElement;
    this.aiPanelBody = this.element.querySelector('.ai-panel-body') as HTMLElement;
    this.aiEntryButton = this.element.querySelector('[data-ai-panel-toggle]') as HTMLButtonElement;
    this.detailTabButton = this.element.querySelector('[data-compose-tab="detail"]') as HTMLButtonElement;
    this.aiPanelStatus = this.element.querySelector('#ai-panel-status') as HTMLElement;
    this.aiCutTolerance = this.element.querySelector('#ai-cut-tolerance') as HTMLInputElement;
    this.aiCutToleranceValue = this.element.querySelector('#ai-cut-tolerance-value') as HTMLElement;
    this.aiCutFeather = this.element.querySelector('#ai-cut-feather') as HTMLInputElement;
    this.aiCutFeatherValue = this.element.querySelector('#ai-cut-feather-value') as HTMLElement;
    this.aiCutRestoreButton = this.element.querySelector('[data-ai-cut-restore]') as HTMLButtonElement;
    this.tilePreview = this.element.querySelector('#tile-preview') as HTMLCanvasElement;
    this.tilePreviewCtx = this.tilePreview.getContext('2d') as CanvasRenderingContext2D;
    this.tileRepeatX = this.element.querySelector('#tile-repeat-x') as HTMLInputElement;
    this.tileRepeatY = this.element.querySelector('#tile-repeat-y') as HTMLInputElement;
    this.tileOffsetX = this.element.querySelector('#tile-offset-x') as HTMLInputElement;
    this.tileOffsetXValue = this.element.querySelector('#tile-offset-x-value') as HTMLInputElement;
    this.tileOffsetY = this.element.querySelector('#tile-offset-y') as HTMLInputElement;
    this.tileOffsetYValue = this.element.querySelector('#tile-offset-y-value') as HTMLInputElement;
    this.tileMode = this.element.querySelector('#tile-mode') as HTMLSelectElement;
    this.tileEdgeBlend = this.element.querySelector('#tile-edge-blend') as HTMLInputElement;
    this.tileSharp = this.element.querySelector('#tile-sharp') as HTMLInputElement;
    this.tileBlend = this.element.querySelector('#tile-blend') as HTMLInputElement;
    this.tileBlendValue = this.element.querySelector('#tile-blend-value') as HTMLElement;
    this.tileSeed = this.element.querySelector('#tile-seed') as HTMLInputElement;
    this.tileCustomSize = this.element.querySelector('#tile-custom-size') as HTMLInputElement;
    this.tileWidth = this.element.querySelector('#tile-width') as HTMLInputElement;
    this.tileHeight = this.element.querySelector('#tile-height') as HTMLInputElement;
    this.dispersionPreview = this.element.querySelector('#dispersion-preview') as HTMLCanvasElement;
    this.dispersionCtx = this.dispersionPreview.getContext('2d') as CanvasRenderingContext2D;
    this.dispersionMode = this.element.querySelector('#dispersion-mode') as HTMLSelectElement;
    this.dispersionTransparent = this.element.querySelector('#dispersion-transparent') as HTMLInputElement;
    this.dispersionOffsetX = this.element.querySelector('#dispersion-offset-x') as HTMLInputElement;
    this.dispersionOffsetXValue = this.element.querySelector('#dispersion-offset-x-value') as HTMLInputElement;
    this.dispersionOffsetY = this.element.querySelector('#dispersion-offset-y') as HTMLInputElement;
    this.dispersionOffsetYValue = this.element.querySelector('#dispersion-offset-y-value') as HTMLInputElement;
    this.toolsPanelBody = this.element.querySelector('.tools-panel-body') as HTMLElement;
    this.toolsEntryButton = this.element.querySelector('[data-tools-panel-toggle]') as HTMLButtonElement;
    this.gradientPreview = this.element.querySelector('#gradient-preview') as HTMLCanvasElement;
    this.gradientCtx = this.gradientPreview.getContext('2d') as CanvasRenderingContext2D;
    this.gradientBarFill = this.element.querySelector('#gradient-bar-fill') as HTMLElement;
    this.gradientBarMarkers = this.element.querySelector('#gradient-bar-markers') as HTMLElement;
    this.gradientAlphaBarFill = this.element.querySelector('#gradient-alpha-fill') as HTMLElement;
    this.gradientAlphaMarkers = this.element.querySelector('#gradient-alpha-markers') as HTMLElement;
    this.gradientColor = this.element.querySelector('#gradient-color') as HTMLInputElement;
    this.gradientPosition = this.element.querySelector('#gradient-position') as HTMLInputElement;
    this.gradientAlpha = this.element.querySelector('#gradient-alpha') as HTMLInputElement;
    this.gradientAlphaValue = this.element.querySelector('#gradient-alpha-value') as HTMLElement;
    this.gradientStatus = this.element.querySelector('#gradient-status') as HTMLElement;
    this.pathPreview = this.element.querySelector('#path-preview') as HTMLCanvasElement;
    this.pathCtx = this.pathPreview.getContext('2d') as CanvasRenderingContext2D;
    this.pathWidth = this.element.querySelector('#path-width') as HTMLInputElement;
    this.pathWidthValue = this.element.querySelector('#path-width-value') as HTMLInputElement;
    this.pathHardness = this.element.querySelector('#path-hardness') as HTMLInputElement;
    this.pathHardnessValue = this.element.querySelector('#path-hardness-value') as HTMLInputElement;
    this.pathHeadWidth = this.element.querySelector('#path-head-width') as HTMLInputElement;
    this.pathHeadWidthValue = this.element.querySelector('#path-head-width-value') as HTMLInputElement;
    this.pathMiddleWidth = this.element.querySelector('#path-middle-width') as HTMLInputElement;
    this.pathMiddleWidthValue = this.element.querySelector('#path-middle-width-value') as HTMLInputElement;
    this.pathTailWidth = this.element.querySelector('#path-tail-width') as HTMLInputElement;
    this.pathTailWidthValue = this.element.querySelector('#path-tail-width-value') as HTMLInputElement;
    this.pathOpacity = this.element.querySelector('#path-opacity') as HTMLInputElement;
    this.pathOpacityValue = this.element.querySelector('#path-opacity-value') as HTMLInputElement;
    this.pathCustomSize = this.element.querySelector('#path-custom-size') as HTMLInputElement;
    this.pathEqual = this.element.querySelector('#path-equal') as HTMLInputElement;
    this.pathShow = this.element.querySelector('#path-show') as HTMLInputElement;
    this.pathSizeW = this.element.querySelector('#path-size-w') as HTMLInputElement;
    this.pathSizeH = this.element.querySelector('#path-size-h') as HTMLInputElement;
    this.pathStatus = this.element.querySelector('#path-status') as HTMLElement;
    this.penOverlay = this.element.querySelector('.pen-overlay') as HTMLCanvasElement;
    this.penCtx = this.penOverlay.getContext('2d') as CanvasRenderingContext2D;
    this.penEffectCtx = this.penEffectCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.aiSeqSource = this.element.querySelector('#ai-seq-source') as HTMLSelectElement;
    this.aiSeqCols = this.element.querySelector('#ai-seq-cols') as HTMLInputElement;
    this.aiSeqRows = this.element.querySelector('#ai-seq-rows') as HTMLInputElement;
    this.aiSeqGrid = this.element.querySelector('#ai-seq-grid') as HTMLCanvasElement;
    this.aiSeqGridCtx = this.aiSeqGrid.getContext('2d') as CanvasRenderingContext2D;
    this.aiSeqPreview = this.element.querySelector('#ai-seq-preview') as HTMLCanvasElement;
    this.aiSeqPreviewCtx = this.aiSeqPreview.getContext('2d') as CanvasRenderingContext2D;
    this.aiSeqCount = this.element.querySelector('#ai-seq-count') as HTMLElement;
    this.aiSeqStatus = this.element.querySelector('#ai-seq-status') as HTMLElement;
    this.aiSeqPlayButton = this.element.querySelector('[data-ai-seq-play]') as HTMLButtonElement;
    this.aiSeqFps = this.element.querySelector('#ai-seq-fps') as HTMLInputElement;
    this.aiSeqFpsValue = this.element.querySelector('#ai-seq-fps-value') as HTMLElement;
    this.aiSeqLoop = this.element.querySelector('#ai-seq-loop') as HTMLInputElement;
    this.composePreview = this.element.querySelector('#compose-preview') as HTMLCanvasElement;
    this.composePreviewCtx = this.composePreview.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.composeSourceName = this.element.querySelector('#compose-source-name') as HTMLElement;
    this.composeParentThumb = this.element.querySelector('#compose-parent-thumb') as HTMLImageElement;
    this.composeChildThumb = this.element.querySelector('#compose-child-thumb') as HTMLImageElement;
    this.composeChildEmpty = this.element.querySelector('#compose-child-empty') as HTMLElement;
    this.composeParentName = this.element.querySelector('#compose-parent-name') as HTMLElement;
    this.composeParentBlend = this.element.querySelector('#compose-parent-blend') as HTMLSelectElement;
    this.composeParentOpacity = this.element.querySelector('#compose-parent-opacity') as HTMLInputElement;
    this.composeParentOpacityValue = this.element.querySelector('#compose-parent-opacity-value') as HTMLElement;
    this.composeChildBlend = this.element.querySelector('#compose-child-blend') as HTMLSelectElement;
    this.composeChildOpacity = this.element.querySelector('#compose-child-opacity') as HTMLInputElement;
    this.composeChildOpacityValue = this.element.querySelector('#compose-child-opacity-value') as HTMLElement;
    this.composeTarget = this.element.querySelector('#compose-target') as HTMLSelectElement;
    this.composeAlphaMode = this.element.querySelector('#compose-alpha-mode') as HTMLSelectElement;
    this.composeChildGroup = this.element.querySelector('[data-compose-group="child"]') as HTMLElement;
    this.composeAddChild = this.element.querySelector('[data-compose-add-child]') as HTMLButtonElement;
    this.composeColorRow = this.element.querySelector('#compose-color-row') as HTMLElement;
    this.composeChannelRow = this.element.querySelector('#compose-channel-row') as HTMLElement;
    this.composeFeatherRow = this.element.querySelector('#compose-feather-row') as HTMLElement;
    this.composeKey = this.element.querySelector('#compose-key') as HTMLInputElement;
    this.composeTolerance = this.element.querySelector('#compose-tolerance') as HTMLInputElement;
    this.composeToleranceValue = this.element.querySelector('#compose-tolerance-value') as HTMLElement;
    this.composeFeather = this.element.querySelector('#compose-feather') as HTMLInputElement;
    this.composeFeatherValue = this.element.querySelector('#compose-feather-value') as HTMLElement;
    this.composeChannel = this.element.querySelector('#compose-channel') as HTMLSelectElement;
    this.composeInvert = this.element.querySelector('#compose-invert') as HTMLInputElement;
    this.composePickButton = this.element.querySelector('[data-compose-pick]') as HTMLButtonElement;
    this.curvePanel = this.element.querySelector('.curve-editor') as HTMLElement;
    this.curveCanvas = this.element.querySelector('#curve-canvas') as HTMLCanvasElement;
    this.curveCtx = this.curveCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.curveToggle = this.element.querySelector('#curve-toggle') as HTMLButtonElement;
    this.aiOverlay = this.element.querySelector('.ai-overlay') as HTMLElement;
    this.aiPluginWarning = this.element.querySelector('#ai-plugin-warning') as HTMLElement;
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
    for (let index = 0; index < 256; index += 1) {
      const offset = index * 4;
      this.curveData[offset] = index;
      this.curveData[offset + 1] = index;
      this.curveData[offset + 2] = index;
      this.curveData[offset + 3] = 255;
    }
    this.curveTexture = new THREE.DataTexture(this.curveData, 256, 1, THREE.RGBAFormat);
    this.curveTexture.minFilter = THREE.LinearFilter;
    this.curveTexture.magFilter = THREE.LinearFilter;
    this.curveTexture.needsUpdate = true;
    this.textureMenu = document.createElement('div');
    this.textureMenu.className = 'context-menu texture-context-menu hidden';
    document.body.append(this.textureMenu);

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

    const firstToolSection = this.toolsPanelBody.querySelector('[data-ai-section="gradient"]');
    for (const key of ['tile', 'dispersion']) {
      const section = this.aiPanelBody.querySelector(`[data-ai-section="${key}"]`);
      if (section) this.toolsPanelBody.insertBefore(section, firstToolSection);
    }

    this.setupComposeGroups();
    this.setupAiSections(this.aiPanelBody, 'upscale');
    this.setupAiSections(this.toolsPanelBody, 'tile');
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.body);
    this.resizeObserver.observe(this.canvas);
    this.resize();
  }

  private bindEvents(): void {
    this.element.querySelector('[data-action="open"]')?.addEventListener('click', () => void this.pickOpen());
    this.element.querySelector('[data-action="fit"]')?.addEventListener('click', () => this.fit());
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
      this.syncAiModelOptions();
      this.aiAvailable = false;
      this.updateAiButtons();
      void this.refreshAiStatus();
    });
    this.aiModelSelect.addEventListener('change', () => {
      const value = this.aiModelSelect.value;
      if (this.aiEngine === 'upscayl') this.aiUpscaylModel = value || 'ultrasharp-4x';
      else this.aiRealesrganModel = value || 'realesrgan-x4plus-anime';
      this.aiAvailable = false;
      this.updateAiButtons();
      void this.refreshAiStatus();
    });
    this.element.querySelectorAll('[data-ai-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        void this.applyAiPreset((button as HTMLElement).dataset.aiPreset === 'texture' ? 'texture' : 'vfx');
      });
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

    this.element.querySelector('[data-compose-load]')?.addEventListener('click', () => void this.loadComposeSource());
    this.element.querySelector('[data-compose-clear]')?.addEventListener('click', () => this.clearComposeSource());
    this.composeAddChild.addEventListener('click', () => void this.loadComposeSource());

    this.aiEntryButton.addEventListener('click', () => this.setPanelMode('ai'));
    this.toolsEntryButton.addEventListener('click', () => this.setPanelMode('tools'));
    this.detailTabButton.addEventListener('click', () => this.setPanelMode('detail'));
    this.element.querySelector('[data-ai-panel-back]')?.addEventListener('click', () => this.setAiMode(false));
    this.element.querySelector('[data-ai-panel-settings]')?.addEventListener('click', () => void this.openAiPanel());
    this.element.querySelectorAll<HTMLButtonElement>('[data-ai-panel-scale]').forEach((button) => {
      button.addEventListener('click', () => void this.runAiPanelScale(Number(button.dataset.aiPanelScale)));
    });
    this.aiCutTolerance.addEventListener('input', () => {
      this.aiCutToleranceValue.textContent = this.aiCutTolerance.value;
    });
    this.aiCutFeather.addEventListener('input', () => {
      this.aiCutFeatherValue.textContent = this.aiCutFeather.value;
    });
    this.element.querySelector('[data-ai-cut]')?.addEventListener('click', () => this.runAiCutout());
    this.aiCutRestoreButton.addEventListener('click', () => this.restoreAiCutout());
    const scheduleTilePreview = (): void => {
      window.clearTimeout(this.tilePreviewTimer);
      this.tilePreviewTimer = window.setTimeout(() => this.renderTilePreview(), 80);
    };
    this.tileRepeatX.addEventListener('change', scheduleTilePreview);
    this.tileRepeatY.addEventListener('change', scheduleTilePreview);
    this.tileMode.addEventListener('change', scheduleTilePreview);
    this.tileEdgeBlend.addEventListener('change', scheduleTilePreview);
    this.tileSharp.addEventListener('change', scheduleTilePreview);
    this.tileSeed.addEventListener('change', scheduleTilePreview);
    this.tileCustomSize.addEventListener('change', () => {
      const custom = this.tileCustomSize.checked;
      this.tileWidth.disabled = !custom;
      this.tileHeight.disabled = !custom;
      scheduleTilePreview();
    });
    this.tileWidth.addEventListener('change', scheduleTilePreview);
    this.tileHeight.addEventListener('change', scheduleTilePreview);
    this.tileOffsetX.addEventListener('input', () => {
      this.tileOffsetXValue.value = this.tileOffsetX.value;
      scheduleTilePreview();
    });
    this.tileOffsetY.addEventListener('input', () => {
      this.tileOffsetYValue.value = this.tileOffsetY.value;
      scheduleTilePreview();
    });
    this.tileOffsetXValue.addEventListener('change', () => {
      const value = Math.max(0, Math.min(4096, Number(this.tileOffsetXValue.value) || 0));
      this.tileOffsetX.value = String(value);
      this.tileOffsetXValue.value = String(value);
      scheduleTilePreview();
    });
    this.tileOffsetYValue.addEventListener('change', () => {
      const value = Math.max(0, Math.min(4096, Number(this.tileOffsetYValue.value) || 0));
      this.tileOffsetY.value = String(value);
      this.tileOffsetYValue.value = String(value);
      scheduleTilePreview();
    });
    this.tileBlend.addEventListener('input', () => {
      this.tileBlendValue.textContent = `${this.tileBlend.value}%`;
      scheduleTilePreview();
    });
    this.element.querySelector('[data-tile-apply]')?.addEventListener('click', () => this.applyTileOutput());
    this.element.querySelector('[data-tile-export]')?.addEventListener('click', () => void this.exportTileOutput());
    this.element.querySelector('[data-tile-reset]')?.addEventListener('click', () => this.resetTileControls());

    const scheduleDispersionPreview = (): void => {
      window.clearTimeout(this.dispersionTimer);
      this.dispersionTimer = window.setTimeout(() => this.renderDispersionPreview(), 60);
    };
    this.dispersionMode.addEventListener('change', scheduleDispersionPreview);
    this.dispersionTransparent.addEventListener('change', scheduleDispersionPreview);
    this.dispersionOffsetX.addEventListener('input', () => {
      this.dispersionOffsetXValue.value = this.dispersionOffsetX.value;
      scheduleDispersionPreview();
    });
    this.dispersionOffsetY.addEventListener('input', () => {
      this.dispersionOffsetYValue.value = this.dispersionOffsetY.value;
      scheduleDispersionPreview();
    });
    this.dispersionOffsetXValue.addEventListener('change', () => {
      const value = Math.max(-20, Math.min(20, Math.round(Number(this.dispersionOffsetXValue.value) || 0)));
      this.dispersionOffsetX.value = String(value);
      this.dispersionOffsetXValue.value = String(value);
      scheduleDispersionPreview();
    });
    this.dispersionOffsetYValue.addEventListener('change', () => {
      const value = Math.max(-20, Math.min(20, Math.round(Number(this.dispersionOffsetYValue.value) || 0)));
      this.dispersionOffsetY.value = String(value);
      this.dispersionOffsetYValue.value = String(value);
      scheduleDispersionPreview();
    });
    this.element.querySelectorAll<HTMLElement>('[data-dispersion-x]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = Number(button.dataset.dispersionX) || 0;
        this.dispersionOffsetX.value = String(value);
        this.dispersionOffsetXValue.value = String(value);
        scheduleDispersionPreview();
      });
    });
    this.element.querySelectorAll<HTMLElement>('[data-dispersion-y]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = Number(button.dataset.dispersionY) || 0;
        this.dispersionOffsetY.value = String(value);
        this.dispersionOffsetYValue.value = String(value);
        scheduleDispersionPreview();
      });
    });
    this.element.querySelector('[data-dispersion-black]')?.addEventListener('click', () => {
      this.dispersionBlack = !this.dispersionBlack;
      const wrap = this.element.querySelector('#dispersion-preview-wrap') as HTMLElement | null;
      wrap?.classList.toggle('black', this.dispersionBlack);
      const button = this.element.querySelector('[data-dispersion-black]') as HTMLButtonElement | null;
      if (button) button.textContent = this.dispersionBlack ? '棋盘' : '黑底';
      this.renderDispersionPreview();
    });
    this.element.querySelector('[data-dispersion-apply]')?.addEventListener('click', () => this.applyDispersionOutput());
    this.element.querySelector('[data-dispersion-export]')?.addEventListener('click', () => void this.exportDispersionOutput());
    this.element.querySelector('[data-dispersion-reset]')?.addEventListener('click', () => this.resetDispersionControls());

    const scheduleGradient = (): void => {
      window.clearTimeout(this.gradientTimer);
      this.gradientTimer = window.setTimeout(() => this.renderGradientEditor(), 40);
    };
    this.gradientColor.addEventListener('input', () => {
      const stop = this.gradientStops[this.gradientSelected];
      if (!stop) return;
      stop.color = this.gradientColor.value;
      scheduleGradient();
    });
    this.gradientPosition.addEventListener('change', () => {
      const stop = this.gradientStops[this.gradientSelected];
      if (!stop) return;
      stop.position = Math.max(0, Math.min(100, Number(this.gradientPosition.value) || 0));
      scheduleGradient();
    });
    this.gradientAlpha.addEventListener('input', () => {
      const stop = this.gradientAlphaStops[this.gradientAlphaSelected];
      if (!stop) return;
      stop.alpha = Math.max(0, Math.min(1, Number(this.gradientAlpha.value) || 0));
      this.gradientAlphaValue.textContent = stop.alpha.toFixed(2);
      scheduleGradient();
    });
    this.gradientBarMarkers.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-gradient-stop]');
      if (!target) return;
      this.gradientSelected = Number(target.dataset.gradientStop) || 0;
      this.syncGradientInputs();
      this.renderGradientEditor();
    });
    this.gradientAlphaMarkers.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-gradient-alpha-stop]');
      if (!target) return;
      this.gradientAlphaSelected = Number(target.dataset.gradientAlphaStop) || 0;
      this.syncGradientInputs();
      this.renderGradientEditor();
    });
    const bindGradientDrag = (markers: HTMLElement, kind: 'color' | 'alpha'): void => {
      markers.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-gradient-stop], [data-gradient-alpha-stop]');
        if (!target) return;
        const index = kind === 'color'
          ? Number(target.dataset.gradientStop) || 0
          : Number(target.dataset.gradientAlphaStop) || 0;
        const bar = markers.getBoundingClientRect();
        if (bar.width <= 0) return;
        event.preventDefault();
        if (kind === 'color') this.gradientSelected = index;
        else this.gradientAlphaSelected = index;
        target.classList.add('dragging');
        let moved = false;
        const startX = event.clientX;
        const move = (moveEvent: PointerEvent): void => {
          if (Math.abs(moveEvent.clientX - startX) > 2) moved = true;
          const position = Math.max(0, Math.min(100, ((moveEvent.clientX - bar.left) / bar.width) * 100));
          if (kind === 'color') {
            const stop = this.gradientStops[index];
            if (!stop) return;
            stop.position = position;
            this.gradientPosition.value = String(Math.round(position));
          } else {
            const stop = this.gradientAlphaStops[index];
            if (!stop) return;
            stop.position = position;
          }
          this.renderGradientEditor();
          const selector = kind === 'color'
            ? `[data-gradient-stop="${index}"]`
            : `[data-gradient-alpha-stop="${index}"]`;
          markers.querySelector<HTMLElement>(selector)?.classList.add('dragging');
        };
        const finish = (finishEvent: Event): void => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          this.renderGradientEditor();
          if (finishEvent.type === 'pointerup' && kind === 'color' && !moved) {
            this.openGradientColorPicker(index);
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      });
      markers.addEventListener('contextmenu', (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-gradient-stop], [data-gradient-alpha-stop]');
        if (!target) return;
        event.preventDefault();
        const index = kind === 'color'
          ? Number(target.dataset.gradientStop) || 0
          : Number(target.dataset.gradientAlphaStop) || 0;
        if (kind === 'color') this.removeGradientStopAt(index);
        else this.removeAlphaStopAt(index);
      });
    };
    bindGradientDrag(this.gradientBarMarkers, 'color');
    bindGradientDrag(this.gradientAlphaMarkers, 'alpha');
    this.element.querySelector('#gradient-bar')?.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-gradient-stop]')) return;
      const bar = event.currentTarget as HTMLElement;
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return;
      this.addGradientStopAt(((event as MouseEvent).clientX - rect.left) / rect.width * 100);
    });
    this.element.querySelector('#gradient-alpha-bar')?.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-gradient-alpha-stop]')) return;
      const bar = event.currentTarget as HTMLElement;
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return;
      this.addAlphaStopAt(((event as MouseEvent).clientX - rect.left) / rect.width * 100);
    });
    this.element.querySelector('[data-gradient-reset]')?.addEventListener('click', () => this.resetGradient());
    this.element.querySelector('[data-gradient-apply]')?.addEventListener('click', () => this.applyGradientOutput());
    this.element.querySelector('[data-gradient-export]')?.addEventListener('click', () => void this.exportGradientOutput());

    const schedulePath = (): void => {
      window.clearTimeout(this.pathTimer);
      this.pathTimer = window.setTimeout(() => this.renderPathGradient(), 50);
    };
    const syncPathNumber = (range: HTMLInputElement, number: HTMLInputElement): void => {
      range.addEventListener('input', () => {
        number.value = range.value;
        schedulePath();
      });
      number.addEventListener('change', () => {
        const value = Math.max(Number(range.min) || 0, Math.min(Number(range.max) || 100, Math.round(Number(number.value) || 0)));
        range.value = String(value);
        number.value = String(value);
        schedulePath();
      });
    };
    syncPathNumber(this.pathWidth, this.pathWidthValue);
    syncPathNumber(this.pathHardness, this.pathHardnessValue);
    syncPathNumber(this.pathHeadWidth, this.pathHeadWidthValue);
    syncPathNumber(this.pathMiddleWidth, this.pathMiddleWidthValue);
    syncPathNumber(this.pathTailWidth, this.pathTailWidthValue);
    syncPathNumber(this.pathOpacity, this.pathOpacityValue);
    this.pathShow.addEventListener('change', () => {
      this.penVisible = this.pathShow.checked;
      this.syncPenOverlayVisibility();
    });
    this.pathCustomSize.addEventListener('change', () => {
      this.pathSizeW.disabled = !this.pathCustomSize.checked;
      this.pathSizeH.disabled = !this.pathCustomSize.checked;
      schedulePath();
    });
    this.pathEqual.addEventListener('change', schedulePath);
    this.pathSizeW.addEventListener('change', () => {
      if (this.pathEqual.checked) this.pathSizeH.value = this.pathSizeW.value;
      schedulePath();
    });
    this.pathSizeH.addEventListener('change', () => {
      if (this.pathEqual.checked) this.pathSizeW.value = this.pathSizeH.value;
      schedulePath();
    });
    this.element.querySelector('[data-path-pen]')?.addEventListener('click', () => this.setPenEditing(!this.penEditing));
    this.element.querySelector('[data-path-pick]')?.addEventListener('click', () => this.pickPenPath());
    this.element.querySelector('[data-path-apply]')?.addEventListener('click', () => this.applyPathGradient());
    this.element.querySelector('[data-path-export]')?.addEventListener('click', () => void this.exportPathGradient());
    this.element.querySelector('[data-path-clear]')?.addEventListener('click', () => this.clearPenPath(true));
    this.element.querySelector('[data-path-reset]')?.addEventListener('click', () => this.resetPathGradient());

    this.penOverlay.addEventListener('wheel', (event) => {
      if (!this.penEditing) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      this.zoom = THREE.MathUtils.clamp(this.zoom * factor, 0.02, 40);
      this.updateCamera();
    }, { passive: false });
    this.penOverlay.addEventListener('pointerdown', (event) => this.penPointerDown(event));
    window.addEventListener('pointermove', (event) => this.penPointerMove(event));
    window.addEventListener('pointerup', () => this.penPointerUp());
    window.addEventListener('pointercancel', () => this.penPointerUp());
    this.penOverlay.addEventListener('contextmenu', (event) => this.penContextMenu(event));
    window.addEventListener('keydown', (event) => {
      if (!this.active || !this.penEditing) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (['input', 'select', 'textarea', 'button'].includes(tag)) return;
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        this.setPenEditing(false);
      }
    });
    this.aiSeqSource.addEventListener('change', () => {
      this.resetAiSequenceSelection();
      this.renderAiSequenceGrid();
    });
    const resetSequenceGrid = (): void => {
      this.aiSeqCols.value = String(this.clampSequenceGrid(this.aiSeqCols.value));
      this.aiSeqRows.value = String(this.clampSequenceGrid(this.aiSeqRows.value));
      this.resetAiSequenceSelection();
      this.renderAiSequenceGrid();
    };
    this.aiSeqCols.addEventListener('change', resetSequenceGrid);
    this.aiSeqRows.addEventListener('change', resetSequenceGrid);
    this.aiSeqGrid.addEventListener('pointerdown', (event) => this.selectAiSequenceCell(event));
    this.element.querySelector('[data-ai-seq-all]')?.addEventListener('click', () => {
      this.selectAllAiSequenceFrames();
      this.renderAiSequenceGrid();
    });
    this.element.querySelector('[data-ai-seq-row]')?.addEventListener('click', () => {
      this.selectAiSequenceRow();
      this.renderAiSequenceGrid();
    });
    this.element.querySelector('[data-ai-seq-clear]')?.addEventListener('click', () => {
      this.stopAiSequence();
      this.aiSeqSelected.clear();
      this.aiSeqFrameIndex = 0;
      this.renderAiSequenceGrid();
    });
    this.aiSeqPlayButton.addEventListener('click', () => this.toggleAiSequencePlay());
    this.aiSeqFps.addEventListener('input', () => {
      this.aiSeqFpsValue.textContent = this.aiSeqFps.value;
    });
    this.element.querySelector('[data-ai-seq-apply]')?.addEventListener('click', () => this.applyAiSequenceFrame());
    this.element.querySelector('[data-compose-apply]')?.addEventListener('click', () => void this.applyCompose());
    this.element.querySelector('[data-compose-export]')?.addEventListener('click', () => void this.exportCompose());
    this.composeParentBlend.addEventListener('change', () => this.scheduleComposePreview());
    this.composeParentOpacity.addEventListener('input', () => {
      this.composeParentOpacityValue.textContent = `${this.composeParentOpacity.value}%`;
      this.scheduleComposePreview();
    });
    this.composeChildBlend.addEventListener('change', () => this.scheduleComposePreview());
    this.composeChildOpacity.addEventListener('input', () => {
      this.composeChildOpacityValue.textContent = `${this.composeChildOpacity.value}%`;
      this.scheduleComposePreview();
    });
    this.composeTarget.addEventListener('change', () => this.updateComposeRows());
    this.composeAlphaMode.addEventListener('change', () => {
      this.updateComposeRows();
      this.scheduleComposePreview();
    });
    this.composeKey.addEventListener('input', () => this.scheduleComposePreview());
    this.composeTolerance.addEventListener('input', () => {
      this.composeToleranceValue.textContent = this.composeTolerance.value;
      this.scheduleComposePreview();
    });
    this.composeFeather.addEventListener('input', () => {
      this.composeFeatherValue.textContent = this.composeFeather.value;
      this.scheduleComposePreview();
    });
    this.composeChannel.addEventListener('change', () => this.scheduleComposePreview());
    this.composeInvert.addEventListener('change', () => this.scheduleComposePreview());
    this.composePickButton.addEventListener('click', () => {
      this.composePicking = !this.composePicking;
      this.composePickButton.textContent = this.composePicking ? '拾取中…' : '拾取';
      this.composePreview.classList.toggle('picking', this.composePicking);
    });
    this.composePreview.addEventListener('click', (event) => this.pickComposeColor(event));
    this.composeOverlay.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types || !Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
    });
    this.composeOverlay.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      event.preventDefault();
      event.stopPropagation();
      void this.loadComposeFile(file);
    });
    this.element.querySelector('[data-action="normal-g"]')?.addEventListener('click', () => {
      this.toggleNormalG();
    });
    this.element.querySelector('[data-action="normal-dismiss"]')?.addEventListener('click', () => {
      this.normalBanner.classList.add('hidden');
    });
    this.element.querySelector('[data-action="undo"]')?.addEventListener('click', () => this.undo());
    this.element.querySelector('[data-action="redo"]')?.addEventListener('click', () => this.redo());
    this.canvas.addEventListener('contextmenu', (event) => {
      if (!this.bitmap) return;
      event.preventDefault();
      this.showTextureMenu(event.clientX, event.clientY);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.textureMenu.contains(event.target as Node)) this.hideTextureMenu();
    });
    window.addEventListener('blur', () => this.hideTextureMenu());
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hideTextureMenu();
    });

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

    this.element.querySelector('[data-action="mono"]')?.addEventListener('click', () => this.setLevelsEnabled(!this.levelsEnabled));
    this.element.querySelector('[data-action="levels-reset"]')?.addEventListener('click', () => this.resetLevels());
    this.curveToggle.addEventListener('click', () => this.setCurvesEnabled(!this.curvesEnabled));
    this.element.querySelector('[data-curve-reset]')?.addEventListener('click', () => this.resetCurve());
    this.bindCurveEditor();
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
        this.imageWidth / Math.max(1, this.canvas.clientWidth),
        this.imageHeight / Math.max(1, this.canvas.clientHeight)
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
    this.stopAiSequence();
    this.aiCutoutBackup = null;
    this.updateAiCutButtons();
    this.setAiMode(false);
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
    options: { preserveTransform?: boolean; preserveHistory?: boolean; skipNormalDetect?: boolean; preservePath?: boolean } = {}
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
        uCurve: { value: this.curveTexture },
        uChannel: { value: this.channel },
        uLevels: { value: this.levelsEnabled ? 1 : 0 },
        uCurves: { value: this.curvesEnabled ? 1 : 0 },
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
    this.openComposePanel();
    this.applyTransform();
    this.fit();
    if (options.preservePath) {
      this.syncPenOverlayVisibility();
      this.renderPenOverlay();
    } else {
      this.clearPenPath(false);
    }
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

  private openComposePanel(): void {
    if (!this.bitmap) return;
    this.body.classList.add('compose-docked');
    this.composeOverlay.classList.remove('hidden');
    this.refreshComposeThumbs();
    this.updateComposeRows();
    this.scheduleComposePreview();
  }

  private updateComposeRows(): void {
    const mode = this.composeAlphaMode.value;
    this.composeColorRow.classList.toggle('hidden', mode !== 'color');
    this.composeFeatherRow.classList.toggle('hidden', mode !== 'color');
    this.composeChannelRow.classList.toggle('hidden', mode !== 'channel');
    this.scheduleComposePreview();
  }

  private setupComposeGroups(): void {
    const body = this.element.querySelector('.compose-panel-body');
    if (!body) return;
    const groups = [...body.querySelectorAll<HTMLElement>(':scope > .compose-group[data-compose-group]')];
    for (const group of groups) {
      const key = group.dataset.composeGroup;
      const title = group.querySelector<HTMLElement>('.compose-group-title');
      if (!key || !title) continue;
      const head = document.createElement('div');
      head.className = 'compose-group-head';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'compose-group-toggle';
      toggle.dataset.composeGroupToggle = key;
      toggle.setAttribute('aria-expanded', 'true');
      toggle.innerHTML = `
        <span class="compose-group-head-left">
          <span class="compose-group-grip" data-compose-group-grip title="拖动排序">≡</span>
          <span class="compose-group-title"></span>
        </span>
        <span class="compose-group-caret">▾</span>
      `;
      const titleText = toggle.querySelector('.compose-group-title');
      if (titleText) titleText.textContent = title.textContent ?? '';
      title.replaceWith(head);
      head.append(toggle);
      const content = document.createElement('div');
      content.className = 'compose-group-body';
      while (head.nextSibling) content.append(head.nextSibling);
      group.append(content);

      const apply = (collapsed: boolean): void => {
        group.classList.toggle('collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
      };
      const defaultCollapsed = key === 'view' || key === 'adjust' || key === 'transparency' || key === 'preview';
      try {
        const stored = localStorage.getItem(`texturemap.texture.compose.collapsed.${key}`);
        apply(stored === null ? defaultCollapsed : stored === '1');
      } catch {
        apply(defaultCollapsed);
      }
      toggle.addEventListener('click', () => {
        const collapsed = !group.classList.contains('collapsed');
        apply(collapsed);
        try {
          localStorage.setItem(`texturemap.texture.compose.collapsed.${key}`, collapsed ? '1' : '0');
        } catch {
          // storage unavailable
        }
      });
      const grip = toggle.querySelector<HTMLElement>('[data-compose-group-grip]');
      grip?.addEventListener('pointerdown', (event) => this.startComposeGroupDrag(event, grip));
      grip?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    try {
      const raw = localStorage.getItem('texturemap.texture.compose.order');
      const order = raw ? JSON.parse(raw) as string[] : [];
      if (Array.isArray(order)) {
        for (const key of order) {
          const group = body.querySelector<HTMLElement>(`:scope > .compose-group[data-compose-group="${key}"]`);
          if (group) body.append(group);
        }
      }
    } catch {
      // keep current order
    }

    window.addEventListener('pointermove', (event) => this.moveComposeGroupDrag(event));
    window.addEventListener('pointerup', (event) => this.endComposeGroupDrag(event));
    window.addEventListener('pointercancel', (event) => this.endComposeGroupDrag(event));
  }

  private setupAiSections(container: HTMLElement, defaultExpanded: string): void {
    const sections = [...container.querySelectorAll<HTMLElement>(':scope > .ai-section[data-ai-section]')];
    const entries: Array<{
      key: string;
      apply: (collapsed: boolean) => void;
      toggle: () => void;
    }> = [];
    for (const section of sections) {
      const key = section.dataset.aiSection;
      const head = section.querySelector<HTMLElement>('.ai-section-head');
      if (!key || !head) continue;
      const body = document.createElement('div');
      body.className = 'ai-section-body';
      while (head.nextSibling) body.append(head.nextSibling);
      section.append(body);
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      const apply = (collapsed: boolean): void => {
        section.classList.toggle('collapsed', collapsed);
        head.setAttribute('aria-expanded', String(!collapsed));
        if (collapsed && key === 'sequence') this.stopAiSequence();
        if (!collapsed && key === 'tile') this.renderTilePreview();
        if (!collapsed && key === 'dispersion') this.renderDispersionPreview();
        if (!collapsed && key === 'gradient') this.renderGradientEditor();
        if (collapsed && key === 'path') this.setPenEditing(false);
        if (!collapsed && key === 'path') {
          this.pathSizeW.disabled = !this.pathCustomSize.checked;
          this.pathSizeH.disabled = !this.pathCustomSize.checked;
          this.syncPathDefaults();
          this.renderPathGradient();
          this.syncPenOverlayVisibility();
        }
      };
      const toggle = (): void => {
        apply(!section.classList.contains('collapsed'));
      };
      apply(key !== defaultExpanded);
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
      entries.push({ key, apply, toggle });
    }
    container.querySelector('[data-ai-expand-all], [data-tools-expand-all]')?.addEventListener('click', () => {
      for (const entry of entries) entry.apply(false);
    });
    container.querySelector('[data-ai-collapse-all], [data-tools-collapse-all]')?.addEventListener('click', () => {
      for (const entry of entries) entry.apply(true);
    });
  }

  private startComposeGroupDrag(event: PointerEvent, grip: HTMLElement): void {
    if (event.button !== 0) return;
    const group = grip.closest<HTMLElement>('.compose-group');
    if (!group) return;
    event.preventDefault();
    event.stopPropagation();
    this.composeGroupDrag = { group, pointerId: event.pointerId, grip };
    group.classList.add('is-group-dragging');
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointer events in automation have no active pointer
    }
  }

  private moveComposeGroupDrag(event: PointerEvent): void {
    const drag = this.composeGroupDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const body = this.element.querySelector('.compose-panel-body');
    if (!body) return;
    const groups = [...body.querySelectorAll<HTMLElement>(':scope > .compose-group')];
    let placed = false;
    for (const group of groups) {
      if (group === drag.group) continue;
      const rect = group.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        body.insertBefore(drag.group, group);
        placed = true;
        break;
      }
    }
    if (!placed) body.append(drag.group);
  }

  private endComposeGroupDrag(event: PointerEvent): void {
    const drag = this.composeGroupDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.composeGroupDrag = null;
    drag.group.classList.remove('is-group-dragging');
    try {
      drag.grip.releasePointerCapture(event.pointerId);
    } catch {
      // released
    }
    try {
      const body = this.element.querySelector('.compose-panel-body');
      if (!body) return;
      const order = [...body.querySelectorAll<HTMLElement>(':scope > .compose-group')]
        .map((group) => group.dataset.composeGroup)
        .filter(Boolean);
      localStorage.setItem('texturemap.texture.compose.order', JSON.stringify(order));
    } catch {
      // storage unavailable
    }
  }

  private scheduleComposePreview(): void {
    window.clearTimeout(this.composePreviewTimer);
    this.composePreviewTimer = window.setTimeout(() => this.updateComposePreview(), 60);
  }

  private updateComposePreview(): void {
    if (this.composeOverlay.classList.contains('hidden')) return;
    const canvas = this.composeImage(512);
    if (!canvas) return;
    this.composePreview.width = canvas.width;
    this.composePreview.height = canvas.height;
    this.composePreviewCtx.clearRect(0, 0, canvas.width, canvas.height);
    this.composePreviewCtx.drawImage(canvas, 0, 0);
    const size = this.element.querySelector('#compose-size') as HTMLElement | null;
    if (size) {
      size.textContent = `${this.imageWidth} × ${this.imageHeight} · 输出 PNG${canvas.width !== this.imageWidth ? '（预览已缩放）' : ''}`;
    }
  }

  private composeImage(maxSize: number): HTMLCanvasElement | null {
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

    const parentCanvas = document.createElement('canvas');
    parentCanvas.width = width;
    parentCanvas.height = height;
    const parentContext = parentCanvas.getContext('2d', { willReadFrequently: true });
    if (!parentContext) return null;
    parentContext.drawImage(this.bitmap as CanvasImageSource, 0, 0, width, height);
    const target = this.composeTarget.value;
    const alphaMode = this.composeAlphaMode.value;

    if (target === 'base' && alphaMode !== 'none') {
      this.applyComposeTransparency(parentContext, width, height);
    }

    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const outputContext = output.getContext('2d');
    if (!outputContext) return null;
    outputContext.save();
    outputContext.globalAlpha = Math.max(0, Math.min(1, Number(this.composeParentOpacity.value) / 100));
    outputContext.globalCompositeOperation = this.composeParentBlend.value as GlobalCompositeOperation;
    outputContext.drawImage(parentCanvas, 0, 0);
    outputContext.restore();

    if (this.composeSource) {
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
      if (!sourceContext) return null;
      sourceContext.drawImage(this.composeSource.bitmap as CanvasImageSource, 0, 0, width, height);
      if (target === 'source' && alphaMode !== 'none') {
        this.applyComposeTransparency(sourceContext, width, height);
      }
      outputContext.save();
      outputContext.globalAlpha = Math.max(0, Math.min(1, Number(this.composeChildOpacity.value) / 100));
      outputContext.globalCompositeOperation = this.composeChildBlend.value as GlobalCompositeOperation;
      outputContext.drawImage(sourceCanvas, 0, 0);
      outputContext.restore();
    }

    return output;
  }

  private applyComposeTransparency(context: CanvasRenderingContext2D, width: number, height: number): void {
    const image = context.getImageData(0, 0, width, height);
    const data = image.data;
    if (this.composeAlphaMode.value === 'color') {
      const color = this.composeKey.value.replace('#', '');
      const keyR = Number.parseInt(color.slice(0, 2), 16) || 0;
      const keyG = Number.parseInt(color.slice(2, 4), 16) || 0;
      const keyB = Number.parseInt(color.slice(4, 6), 16) || 0;
      const tolerance = Math.max(0, Math.min(255, Number(this.composeTolerance.value) || 0));
      const feather = Math.max(0, Math.min(32, Number(this.composeFeather.value) || 0));
      const softRange = feather * 4;
      for (let index = 0; index < data.length; index += 4) {
        const distance = Math.max(
          Math.abs(data[index] - keyR),
          Math.abs(data[index + 1] - keyG),
          Math.abs(data[index + 2] - keyB)
        );
        if (distance <= tolerance) {
          data[index + 3] = 0;
        } else if (softRange > 0 && distance < tolerance + softRange) {
          const t = (distance - tolerance) / softRange;
          data[index + 3] = Math.round(data[index + 3] * t);
        }
      }
    } else if (this.composeAlphaMode.value === 'channel') {
      const channel = this.composeChannel.value;
      const invert = this.composeInvert.checked;
      for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const a = data[index + 3];
        let value = 0;
        if (channel === 'r') value = r;
        else if (channel === 'g') value = g;
        else if (channel === 'b') value = b;
        else if (channel === 'a') value = a;
        else value = Math.round(r * 0.2126 + g * 0.7152 + b * 0.0722);
        if (invert) value = 255 - value;
        data[index + 3] = Math.round(a * (value / 255));
      }
    }
    context.putImageData(image, 0, 0);
  }

  private async loadComposeSource(): Promise<void> {
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
      this.clearComposeSource();
      this.composeSource = { name: basename(filePath), bitmap: source };
      this.refreshComposeThumbs();
      this.scheduleComposePreview();
    } catch (error) {
      this.callbacks.toast(
        `载入附件图 2 失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private async loadComposeFile(file: File): Promise<void> {
    try {
      const source = await createImageBitmap(file);
      this.clearComposeSource();
      this.composeSource = { name: file.name || '附件图 2', bitmap: source };
      this.refreshComposeThumbs();
      this.scheduleComposePreview();
    } catch (error) {
      this.callbacks.toast(
        `载入附件图 2 失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private clearComposeSource(): void {
    if (this.composeSource?.bitmap instanceof ImageBitmap) this.composeSource.bitmap.close();
    this.composeSource = null;
    this.refreshComposeThumbs();
  }

  private composeThumbnail(source: ImageBitmap | HTMLCanvasElement): string {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return '';
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const scale = Math.min(64 / Math.max(1, sourceWidth), 64 / Math.max(1, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    context.drawImage(
      source as CanvasImageSource,
      Math.round((64 - width) / 2),
      Math.round((64 - height) / 2),
      width,
      height
    );
    return canvas.toDataURL('image/png');
  }

  private refreshComposeThumbs(): void {
    if (!this.composeParentThumb || !this.composeChildThumb) return;
    this.composeParentName.textContent = this.fileName || '当前贴图';
    if (this.bitmap) {
      this.composeParentThumb.src = this.composeThumbnail(this.bitmap);
      this.composeParentThumb.classList.remove('hidden');
    } else {
      this.composeParentThumb.removeAttribute('src');
      this.composeParentThumb.classList.add('hidden');
    }
    if (this.composeSource) {
      this.composeChildThumb.src = this.composeThumbnail(this.composeSource.bitmap);
      this.composeChildThumb.classList.remove('hidden');
      this.composeChildEmpty.classList.add('hidden');
      this.composeSourceName.textContent = this.composeSource.name;
    } else {
      this.composeChildThumb.removeAttribute('src');
      this.composeChildThumb.classList.add('hidden');
      this.composeChildEmpty.classList.remove('hidden');
      this.composeSourceName.textContent = '未载入';
    }
    this.composeChildGroup.classList.toggle('hidden', !this.composeSource);
    this.composeAddChild.classList.toggle('hidden', Boolean(this.composeSource));
  }

  private composeOutputName(): string {
    return `${this.currentBaseName()}_compose.png`;
  }

  private async applyCompose(): Promise<void> {
    if (this.composeBusy) return;
    this.composeBusy = true;
    try {
      const canvas = this.composeImage(0);
      if (!canvas) return;
      const hadSource = Boolean(this.composeSource);
      this.setImage(canvas, canvas.width, canvas.height, this.composeOutputName(), '', canvas.width * canvas.height * 4);
      if (hadSource) this.clearComposeSource();
      this.callbacks.toast('已应用合成结果', 'success');
    } catch (error) {
      this.callbacks.toast(`应用失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.composeBusy = false;
    }
  }

  private async exportCompose(): Promise<void> {
    if (this.composeBusy) return;
    this.composeBusy = true;
    try {
      const canvas = this.composeImage(0);
      if (!canvas) return;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const saved = await window.nyxel.file.savePng(data, this.composeOutputName());
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.composeBusy = false;
    }
  }

  private pickComposeColor(event: MouseEvent): void {
    if (!this.composePicking) return;
    const source = this.composeTarget.value === 'source' ? this.composeSource?.bitmap : this.bitmap;
    if (!source) {
      this.callbacks.toast('当前透明处理目标还没有图片', 'info');
      return;
    }
    const rect = this.composePreview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const x = Math.max(0, Math.min(sourceWidth - 1, Math.floor(((event.clientX - rect.left) / rect.width) * sourceWidth)));
    const y = Math.max(0, Math.min(sourceHeight - 1, Math.floor(((event.clientY - rect.top) / rect.height) * sourceHeight)));
    const sample = document.createElement('canvas');
    sample.width = sourceWidth;
    sample.height = sourceHeight;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(source as CanvasImageSource, 0, 0);
    const pixel = context.getImageData(x, y, 1, 1).data;
    const hex = `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    this.composeKey.value = hex;
    this.composeAlphaMode.value = 'color';
    this.updateComposeRows();
    this.composePicking = false;
    this.composePickButton.textContent = '拾取';
    this.composePreview.classList.remove('picking');
    this.scheduleComposePreview();
  }

  private currentBaseName(): string {
    return this.fileName.replace(/\.[^.]+$/, '') || 'texture';
  }

  private currentAiModel(): string {
    return this.aiEngine === 'upscayl' ? this.aiUpscaylModel : this.aiRealesrganModel;
  }

  private aiModelLabel(): string {
    const labels = this.aiEngine === 'upscayl' ? UPSCAYL_MODEL_LABELS : REALESRGAN_MODEL_LABELS;
    const model = this.currentAiModel();
    return labels[model] ?? model;
  }

  private aiEngineLabel(): string {
    return this.aiEngine === 'upscayl'
      ? `Upscayl · ${this.aiModelLabel()}`
      : `Real-ESRGAN · ${this.aiModelLabel()}`;
  }

  private syncAiModelOptions(): void {
    const labels = this.aiEngine === 'upscayl' ? UPSCAYL_MODEL_LABELS : REALESRGAN_MODEL_LABELS;
    const models = Object.keys(labels);
    const current = this.currentAiModel();
    const selected = models.includes(current) ? current : models[0];
    this.aiModelSelect.innerHTML = models
      .map((model) => `<option value="${model}">${labels[model]}</option>`)
      .join('');
    this.aiModelSelect.value = selected;
    if (this.aiEngine === 'upscayl') this.aiUpscaylModel = selected;
    else this.aiRealesrganModel = selected;
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
      if (this.levelsEnabled) this.applyLevelsToCanvas(canvas);
      if (this.curvesEnabled) this.applyCurvesToCanvas(canvas);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const suffix = this.levelsEnabled && this.curvesEnabled
        ? '_adjusted_export.png'
        : this.levelsEnabled
          ? '_levels_export.png'
          : this.curvesEnabled
            ? '_curves_export.png'
            : '_export.png';
      const saved = await window.nyxel.file.savePng(data, `${this.currentBaseName()}${suffix}`);
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(
        `导出失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private setAiMode(active: boolean): void {
    this.setPanelMode(active ? 'ai' : 'detail');
  }

  private setPanelMode(mode: 'detail' | 'ai' | 'tools'): void {
    if (mode !== 'detail' && !this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    if (mode !== 'tools') this.setPenEditing(false);
    this.panelMode = mode;
    this.aiMode = mode === 'ai';
    this.element.classList.toggle('ai-theme', mode === 'ai');
    this.element.classList.toggle('tools-theme', mode === 'tools');
    this.composePanel.classList.toggle('ai-mode', mode === 'ai');
    this.composePanel.classList.toggle('tools-mode', mode === 'tools');
    this.composeBody.classList.toggle('hidden', mode !== 'detail');
    this.aiPanelBody.classList.toggle('hidden', mode !== 'ai');
    this.toolsPanelBody.classList.toggle('hidden', mode !== 'tools');
    this.detailTabButton.classList.toggle('active', mode === 'detail');
    this.aiEntryButton.classList.toggle('active', mode === 'ai');
    this.toolsEntryButton.classList.toggle('active', mode === 'tools');
    this.detailTabButton.setAttribute('aria-selected', String(mode === 'detail'));
    this.aiEntryButton.setAttribute('aria-selected', String(mode === 'ai'));
    this.toolsEntryButton.setAttribute('aria-selected', String(mode === 'tools'));
    if (mode === 'ai') {
      if (!this.composeSource && this.aiSeqSource.value === 'child') this.aiSeqSource.value = 'parent';
      this.updateAiCutButtons();
      this.resetAiSequenceSelection();
      this.renderAiSequenceGrid();
      void this.refreshAiStatus();
    } else if (mode === 'tools') {
      this.stopAiSequence();
      this.syncTileDefaults();
      this.pathSizeW.disabled = !this.pathCustomSize.checked;
      this.pathSizeH.disabled = !this.pathCustomSize.checked;
      this.syncPathDefaults();
      if (!this.toolsPanelBody.querySelector('[data-ai-section="tile"]')?.classList.contains('collapsed')) {
        this.renderTilePreview();
      }
      if (!this.toolsPanelBody.querySelector('[data-ai-section="dispersion"]')?.classList.contains('collapsed')) {
        this.renderDispersionPreview();
      }
      if (!this.toolsPanelBody.querySelector('[data-ai-section="gradient"]')?.classList.contains('collapsed')) {
        this.renderGradientEditor();
      }
      if (!this.toolsPanelBody.querySelector('[data-ai-section="path"]')?.classList.contains('collapsed')) {
        this.renderPathGradient();
      }
    } else {
      this.stopAiSequence();
    }
    this.syncPenOverlayVisibility();
  }

  private async runAiPanelScale(scale: number): Promise<void> {
    if (!this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    await this.refreshAiStatus();
    if (!this.aiAvailable) {
      this.callbacks.toast(`请先下载 ${this.aiEngineLabel()} 运行时`, 'info');
      void this.openAiPanel();
      return;
    }
    await this.aiScale(scale);
  }

  private updateAiCutButtons(): void {
    this.aiCutRestoreButton.disabled = !this.aiCutoutBackup;
  }

  private runAiCutout(): void {
    if (!this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    const tolerance = Math.max(0, Number(this.aiCutTolerance.value) || 0);
    const feather = Math.max(0, Number(this.aiCutFeather.value) || 0);
    const width = this.imageWidth;
    const height = this.imageHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(this.bitmap as CanvasImageSource, 0, 0);
    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;

    const colorCounts = new Map<number, number>();
    const sampleBorder = (x: number, y: number): void => {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 16) return;
      const key = ((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4);
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
    };
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 64))) {
      sampleBorder(x, 0);
      sampleBorder(x, height - 1);
    }
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 64))) {
      sampleBorder(0, y);
      sampleBorder(width - 1, y);
    }
    let backgroundKey = 0;
    let backgroundCount = -1;
    colorCounts.forEach((count, key) => {
      if (count > backgroundCount) {
        backgroundCount = count;
        backgroundKey = key;
      }
    });
    const backgroundR = ((backgroundKey >> 8) & 0xf) * 17 + 8;
    const backgroundG = ((backgroundKey >> 4) & 0xf) * 17 + 8;
    const backgroundB = (backgroundKey & 0xf) * 17 + 8;

    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let queueStart = 0;
    let queueEnd = 0;
    const softRange = Math.max(1, feather * 6);
    const distanceAt = (index: number): number => {
      const offset = index * 4;
      const dr = data[offset] - backgroundR;
      const dg = data[offset + 1] - backgroundG;
      const db = data[offset + 2] - backgroundB;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };
    const seed = (x: number, y: number): void => {
      const index = y * width + x;
      if (visited[index]) return;
      const distance = distanceAt(index);
      if (distance > tolerance) return;
      visited[index] = 1;
      data[index * 4 + 3] = 0;
      queue[queueEnd++] = index;
    };
    for (let x = 0; x < width; x += 1) {
      seed(x, 0);
      seed(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
      seed(0, y);
      seed(width - 1, y);
    }
    while (queueStart < queueEnd) {
      const index = queue[queueStart++];
      const x = index % width;
      const y = (index / width) | 0;
      const visit = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const next = ny * width + nx;
        if (visited[next]) return;
        const distance = distanceAt(next);
        if (distance <= tolerance) {
          visited[next] = 1;
          data[next * 4 + 3] = 0;
          queue[queueEnd++] = next;
        } else if (distance <= tolerance + softRange) {
          visited[next] = 1;
          data[next * 4 + 3] = Math.min(data[next * 4 + 3], Math.round(((distance - tolerance) / softRange) * 255));
        }
      };
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
    context.putImageData(imageData, 0, 0);

    const backup = document.createElement('canvas');
    backup.width = width;
    backup.height = height;
    backup.getContext('2d')?.drawImage(this.bitmap as CanvasImageSource, 0, 0);
    this.aiCutoutBackup = {
      canvas: backup,
      width,
      height,
      name: this.fileName,
      path: this.filePath,
      size: this.fileSize
    };

    this.setImage(
      canvas,
      width,
      height,
      `${this.currentBaseName()}_cutout.png`,
      '',
      width * height * 4,
      { preserveTransform: true, preserveHistory: false }
    );
    this.setAiMode(true);
    this.callbacks.toast('AI 抠图完成；可继续调节容差后再次抠图', 'success');
  }

  private restoreAiCutout(): void {
    const backup = this.aiCutoutBackup;
    if (!backup) return;
    this.aiCutoutBackup = null;
    this.setImage(
      backup.canvas,
      backup.width,
      backup.height,
      backup.name,
      backup.path,
      backup.size,
      { preserveTransform: true, preserveHistory: false }
    );
    this.setAiMode(true);
    this.callbacks.toast('已还原抠图前的图片', 'success');
  }

  private syncTileDefaults(): void {
    if (!this.bitmap || !this.imageWidth || !this.imageHeight) return;
    const maxRepeatX = Math.max(1, Math.min(8, Math.floor(4096 / this.imageWidth)));
    const maxRepeatY = Math.max(1, Math.min(8, Math.floor(4096 / this.imageHeight)));
    this.tileRepeatX.max = String(maxRepeatX);
    this.tileRepeatY.max = String(maxRepeatY);
    this.tileRepeatX.value = String(Math.min(Number(this.tileRepeatX.value) || 1, maxRepeatX));
    this.tileRepeatY.value = String(Math.min(Number(this.tileRepeatY.value) || 1, maxRepeatY));
    this.tileOffsetX.max = String(this.imageWidth);
    this.tileOffsetY.max = String(this.imageHeight);
    if (!this.tileCustomSize.checked) {
      this.tileWidth.value = String(this.imageWidth);
      this.tileHeight.value = String(this.imageHeight);
    }
  }

  private tileValue(input: HTMLInputElement, fallback: number, min: number, max: number): number {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
  }

  private buildTileOutput(): HTMLCanvasElement | null {
    if (!this.bitmap || !this.imageWidth || !this.imageHeight) return null;
    const repeatX = this.tileValue(this.tileRepeatX, 1, 1, 8);
    const repeatY = this.tileValue(this.tileRepeatY, 1, 1, 8);
    this.tileRepeatX.value = String(repeatX);
    this.tileRepeatY.value = String(repeatY);
    const custom = this.tileCustomSize.checked;
    const width = custom
      ? this.tileValue(this.tileWidth, this.imageWidth, 1, 4096)
      : Math.min(4096, this.imageWidth * repeatX);
    const height = custom
      ? this.tileValue(this.tileHeight, this.imageHeight, 1, 4096)
      : Math.min(4096, this.imageHeight * repeatY);
    if (custom) {
      this.tileWidth.value = String(width);
      this.tileHeight.value = String(height);
    }
    const seed = this.tileValue(this.tileSeed, 1, 1, 9999);
    this.tileSeed.value = String(seed);
    const random = (value: number): number => {
      const n = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
      return n - Math.floor(n);
    };
    const offsetX = (Number(this.tileOffsetXValue.value) || 0) + random(seed) * this.imageWidth;
    const offsetY = (Number(this.tileOffsetYValue.value) || 0) + random(seed + 1) * this.imageHeight;

    const sourceTile = document.createElement('canvas');
    sourceTile.width = this.imageWidth;
    sourceTile.height = this.imageHeight;
    const sourceContext = sourceTile.getContext('2d');
    if (!sourceContext) return null;
    const startX = -(((offsetX % this.imageWidth) + this.imageWidth) % this.imageWidth);
    const startY = -(((offsetY % this.imageHeight) + this.imageHeight) % this.imageHeight);
    for (let x = startX; x < this.imageWidth; x += this.imageWidth) {
      for (let y = startY; y < this.imageHeight; y += this.imageHeight) {
        sourceContext.drawImage(this.bitmap as CanvasImageSource, x, y);
      }
    }

    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    const cellsX = Math.ceil(width / this.imageWidth);
    const cellsY = Math.ceil(height / this.imageHeight);
    for (let row = 0; row < cellsY; row += 1) {
      for (let col = 0; col < cellsX; col += 1) {
        const flipX = col % 2 === 1;
        const flipY = row % 2 === 1;
        context.save();
        context.translate(col * this.imageWidth + (flipX ? this.imageWidth : 0), row * this.imageHeight + (flipY ? this.imageHeight : 0));
        context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        context.drawImage(sourceTile, 0, 0);
        context.restore();
      }
    }

    if (this.tileEdgeBlend.checked) {
      const percent = Math.max(0, Math.min(50, Number(this.tileBlend.value) || 0));
      this.applyTileEdgeBlend(output, percent, this.tileMode.value as 'both' | 'horizontal' | 'vertical', this.tileSharp.checked);
    }
    return output;
  }

  private applyTileEdgeBlend(
    canvas: HTMLCanvasElement,
    percent: number,
    mode: 'both' | 'horizontal' | 'vertical',
    sharp: boolean
  ): void {
    if (percent <= 0) return;
    const width = canvas.width;
    const height = canvas.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const imageData = context.getImageData(0, 0, width, height);
    let data = imageData.data;
    let band = Math.max(1, Math.round(Math.min(width, height) * percent / 100));
    if (sharp) band = Math.max(1, Math.round(band * 0.65));
    band = Math.min(band, Math.floor(width / 2), Math.floor(height / 2));
    const blend = (t: number): number => t * t * (3 - 2 * t);
    if (mode === 'horizontal' || mode === 'both') {
      for (let y = 0; y < height; y += 1) {
        const row = y * width * 4;
        const left = row;
        const right = row + (width - 1) * 4;
        const seam = [
          (data[left] + data[right]) / 2,
          (data[left + 1] + data[right + 1]) / 2,
          (data[left + 2] + data[right + 2]) / 2,
          (data[left + 3] + data[right + 3]) / 2
        ];
        for (let x = 0; x < band; x += 1) {
          const t = blend(x / band);
          const target = row + x * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            data[target + channel] = Math.round(seam[channel] * (1 - t) + data[target + channel] * t);
          }
          const mirror = row + (width - 1 - x) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            data[mirror + channel] = Math.round(seam[channel] * (1 - t) + data[mirror + channel] * t);
          }
        }
      }
    }
    if (mode === 'vertical' || mode === 'both') {
      data = imageData.data;
      for (let x = 0; x < width; x += 1) {
        const top = x * 4;
        const bottom = ((height - 1) * width + x) * 4;
        const seam = [
          (data[top] + data[bottom]) / 2,
          (data[top + 1] + data[bottom + 1]) / 2,
          (data[top + 2] + data[bottom + 2]) / 2,
          (data[top + 3] + data[bottom + 3]) / 2
        ];
        for (let y = 0; y < band; y += 1) {
          const t = blend(y / band);
          const target = (y * width + x) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            data[target + channel] = Math.round(seam[channel] * (1 - t) + data[target + channel] * t);
          }
          const mirror = ((height - 1 - y) * width + x) * 4;
          for (let channel = 0; channel < 4; channel += 1) {
            data[mirror + channel] = Math.round(seam[channel] * (1 - t) + data[mirror + channel] * t);
          }
        }
      }
    }
    context.putImageData(imageData, 0, 0);
  }

  private renderTilePreview(): void {
    const output = this.buildTileOutput();
    this.tileOutput = output;
    const context = this.tilePreviewCtx;
    const canvas = this.tilePreview;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#0b0d10';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!output) {
      context.fillStyle = '#7f8b96';
      context.font = '12px "Microsoft YaHei", sans-serif';
      context.textAlign = 'center';
      context.fillText('载入图片后可用', canvas.width / 2, canvas.height / 2);
      return;
    }
    const scale = Math.min(canvas.width / output.width, canvas.height / output.height);
    const drawWidth = output.width * scale;
    const drawHeight = output.height * scale;
    context.imageSmoothingEnabled = true;
    context.drawImage(output, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
  }

  private applyTileOutput(): void {
    if (!this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    const output = this.buildTileOutput();
    if (!output) return;
    this.tileOutput = output;
    this.setImage(
      output,
      output.width,
      output.height,
      `${this.currentBaseName()}_tile.png`,
      '',
      output.width * output.height * 4,
      { preserveTransform: true, preserveHistory: false }
    );
    this.setPanelMode('tools');
    this.callbacks.toast('已应用无缝平铺贴图', 'success');
  }

  private async exportTileOutput(): Promise<void> {
    const output = this.tileOutput ?? this.buildTileOutput();
    if (!output) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const saved = await window.nyxel.file.savePng(data, `${this.currentBaseName()}_tile.png`);
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private resetTileControls(): void {
    this.tileRepeatX.value = '1';
    this.tileRepeatY.value = '1';
    this.tileOffsetX.value = '0';
    this.tileOffsetXValue.value = '0';
    this.tileOffsetY.value = '0';
    this.tileOffsetYValue.value = '0';
    this.tileMode.value = 'both';
    this.tileEdgeBlend.checked = true;
    this.tileSharp.checked = false;
    this.tileBlend.value = '20';
    this.tileBlendValue.textContent = '20%';
    this.tileSeed.value = '1';
    this.tileCustomSize.checked = false;
    this.tileWidth.disabled = true;
    this.tileHeight.disabled = true;
    this.tileWidth.value = String(this.imageWidth || 512);
    this.tileHeight.value = String(this.imageHeight || 512);
    this.syncTileDefaults();
    this.renderTilePreview();
  }

  private buildDispersionOutput(): HTMLCanvasElement | null {
    if (!this.bitmap || !this.imageWidth || !this.imageHeight) return null;
    const width = this.imageWidth;
    const height = this.imageHeight;
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const sourceContext = source.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) return null;
    sourceContext.drawImage(this.bitmap as CanvasImageSource, 0, 0);
    const sourceData = sourceContext.getImageData(0, 0, width, height).data;
    const outputData = new Uint8ClampedArray(sourceData);
    const mode = this.dispersionMode.value;
    const channelOffset = mode === 'r' ? 0 : mode === 'g' ? 1 : 2;
    const offsetX = Math.max(-20, Math.min(20, Math.round(Number(this.dispersionOffsetXValue.value) || 0)));
    const offsetY = Math.max(-20, Math.min(20, Math.round(Number(this.dispersionOffsetYValue.value) || 0)));
    const transparentEdge = this.dispersionTransparent.checked;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sampleX = x - offsetX;
        const sampleY = y - offsetY;
        const inside = sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height;
        if (!inside && transparentEdge) {
          const outputIndex = (y * width + x) * 4;
          outputData[outputIndex] = 0;
          outputData[outputIndex + 1] = 0;
          outputData[outputIndex + 2] = 0;
          outputData[outputIndex + 3] = 0;
          continue;
        }
        const clampedX = Math.max(0, Math.min(width - 1, sampleX));
        const clampedY = Math.max(0, Math.min(height - 1, sampleY));
        const sourceIndex = (clampedY * width + clampedX) * 4;
        const outputIndex = (y * width + x) * 4;
        outputData[outputIndex + channelOffset] = sourceData[sourceIndex + channelOffset];
      }
    }
    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d');
    if (!context) return null;
    context.putImageData(new ImageData(outputData, width, height), 0, 0);
    return output;
  }

  private renderDispersionPreview(): void {
    const output = this.buildDispersionOutput();
    this.dispersionOutput = output;
    const context = this.dispersionCtx;
    const canvas = this.dispersionPreview;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (this.dispersionBlack) {
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (!output) {
      context.fillStyle = this.dispersionBlack ? '#aaa' : '#7f8b96';
      context.font = '12px "Microsoft YaHei", sans-serif';
      context.textAlign = 'center';
      context.fillText('载入图片后可用', canvas.width / 2, canvas.height / 2);
      return;
    }
    const scale = Math.min(canvas.width / output.width, canvas.height / output.height);
    const drawWidth = output.width * scale;
    const drawHeight = output.height * scale;
    context.imageSmoothingEnabled = true;
    context.drawImage(output, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
  }

  private applyDispersionOutput(): void {
    if (!this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    const output = this.buildDispersionOutput();
    if (!output) return;
    this.dispersionOutput = output;
    this.setImage(
      output,
      output.width,
      output.height,
      `${this.currentBaseName()}_dispersion.png`,
      '',
      output.width * output.height * 4,
      { preserveTransform: true, preserveHistory: false }
    );
    this.setPanelMode('tools');
    this.callbacks.toast('已应用色散分离', 'success');
  }

  private async exportDispersionOutput(): Promise<void> {
    const output = this.dispersionOutput ?? this.buildDispersionOutput();
    if (!output) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const saved = await window.nyxel.file.savePng(data, `${this.currentBaseName()}_dispersion.png`);
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private resetDispersionControls(): void {
    this.dispersionMode.value = 'b';
    this.dispersionTransparent.checked = true;
    this.dispersionOffsetX.value = '2';
    this.dispersionOffsetXValue.value = '2';
    this.dispersionOffsetY.value = '-2';
    this.dispersionOffsetYValue.value = '-2';
    this.dispersionBlack = false;
    this.element.querySelector('#dispersion-preview-wrap')?.classList.remove('black');
    const button = this.element.querySelector('[data-dispersion-black]') as HTMLButtonElement | null;
    if (button) button.textContent = '黑底';
    this.renderDispersionPreview();
  }

  private hexToRgb(color: string): { red: number; green: number; blue: number } {
    const value = color.replace('#', '');
    return {
      red: parseInt(value.slice(0, 2), 16) || 0,
      green: parseInt(value.slice(2, 4), 16) || 0,
      blue: parseInt(value.slice(4, 6), 16) || 0
    };
  }

  private mixHexColor(from: string, to: string, t: number): string {
    const a = this.hexToRgb(from);
    const b = this.hexToRgb(to);
    const mix = Math.max(0, Math.min(1, t));
    const channel = (start: number, end: number): string =>
      Math.round(start + (end - start) * mix).toString(16).padStart(2, '0');
    return `#${channel(a.red, b.red)}${channel(a.green, b.green)}${channel(a.blue, b.blue)}`;
  }

  private syncGradientInputs(): void {
    this.gradientSelected = Math.max(0, Math.min(this.gradientStops.length - 1, this.gradientSelected));
    this.gradientAlphaSelected = Math.max(0, Math.min(this.gradientAlphaStops.length - 1, this.gradientAlphaSelected));
    const stop = this.gradientStops[this.gradientSelected];
    if (stop) {
      this.gradientColor.value = stop.color;
      this.gradientPosition.value = String(Math.round(stop.position));
    }
    const alphaStop = this.gradientAlphaStops[this.gradientAlphaSelected];
    if (alphaStop) {
      this.gradientAlpha.value = alphaStop.alpha.toFixed(2);
      this.gradientAlphaValue.textContent = alphaStop.alpha.toFixed(2);
    }
  }

  private sampleGradientColor(position: number): string {
    const sorted = this.gradientStops.slice().sort((a, b) => a.position - b.position);
    if (sorted.length === 0) return '#ff7878';
    if (position <= sorted[0].position) return sorted[0].color;
    for (let index = 1; index < sorted.length; index += 1) {
      const next = sorted[index];
      if (position <= next.position) {
        const previous = sorted[index - 1];
        const span = Math.max(0.001, next.position - previous.position);
        return this.mixHexColor(previous.color, next.color, (position - previous.position) / span);
      }
    }
    return sorted[sorted.length - 1].color;
  }

  private sampleGradientAlpha(position: number): number {
    const sorted = this.gradientAlphaStops.slice().sort((a, b) => a.position - b.position);
    if (sorted.length === 0) return 1;
    if (position <= sorted[0].position) return sorted[0].alpha;
    for (let index = 1; index < sorted.length; index += 1) {
      const next = sorted[index];
      if (position <= next.position) {
        const previous = sorted[index - 1];
        const span = Math.max(0.001, next.position - previous.position);
        return previous.alpha + (next.alpha - previous.alpha) * ((position - previous.position) / span);
      }
    }
    return sorted[sorted.length - 1].alpha;
  }

  private renderGradientEditor(): void {
    const sorted = this.gradientStops.slice().sort((a, b) => a.position - b.position);
    const alphaSorted = this.gradientAlphaStops.slice().sort((a, b) => a.position - b.position);
    this.gradientBarFill.style.background = `linear-gradient(90deg, ${sorted
      .map((stop) => `${stop.color} ${stop.position}%`)
      .join(', ')})`;
    this.gradientAlphaBarFill.style.background = `linear-gradient(90deg, ${alphaSorted
      .map((stop) => `rgba(255, 255, 255, ${stop.alpha}) ${stop.position}%`)
      .join(', ')})`;
    this.gradientBarMarkers.innerHTML = '';
    this.gradientStops.forEach((stop, index) => {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = `gradient-marker${index === this.gradientSelected ? ' active' : ''}`;
      marker.dataset.gradientStop = String(index);
      marker.style.left = `${stop.position}%`;
      marker.style.background = stop.color;
      marker.title = `色标 ${index + 1} · ${Math.round(stop.position)}%`;
      this.gradientBarMarkers.append(marker);
    });
    this.gradientAlphaMarkers.innerHTML = '';
    this.gradientAlphaStops.forEach((stop, index) => {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = `gradient-alpha-marker${index === this.gradientAlphaSelected ? ' active' : ''}`;
      marker.dataset.gradientAlphaStop = String(index);
      marker.style.left = `${stop.position}%`;
      marker.style.background = `rgba(255, 255, 255, ${Math.max(0.12, stop.alpha)})`;
      marker.title = `透明度 ${stop.alpha.toFixed(2)} · ${Math.round(stop.position)}%`;
      this.gradientAlphaMarkers.append(marker);
    });

    const canvas = this.gradientPreview;
    const context = this.gradientCtx;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const checker = 10;
    for (let y = 0; y < height; y += checker) {
      for (let x = 0; x < width; x += checker) {
        context.fillStyle = (x / checker + y / checker) % 2 === 0 ? '#242424' : '#191919';
        context.fillRect(x, y, checker, checker);
      }
    }
    const output = this.buildGradientOutput();
    context.imageSmoothingEnabled = true;
    context.drawImage(output, 0, 0, width, height);
    this.syncGradientInputs();
    this.gradientStatus.textContent = `${this.gradientStops.length} 色标 · ${this.gradientAlphaStops.length} 透明度标 · 左键调色 / 右键删除`;
    if (this.penPoints.length > 0) this.renderPenOverlay();
  }

  private openGradientColorPicker(index: number): void {
    const stop = this.gradientStops[index];
    if (!stop) return;
    this.gradientSelected = index;
    this.syncGradientInputs();
    this.renderGradientEditor();
    this.gradientColor.value = stop.color;
    const marker = this.gradientBarMarkers.querySelector<HTMLElement>(`[data-gradient-stop="${index}"]`);
    if (marker) {
      const rect = marker.getBoundingClientRect();
      this.gradientColor.style.left = `${Math.round(rect.left)}px`;
      this.gradientColor.style.top = `${Math.round(rect.bottom)}px`;
    }
    const picker = this.gradientColor as HTMLInputElement & { showPicker?: () => void };
    try {
      if (typeof picker.showPicker === 'function') picker.showPicker();
      else this.gradientColor.click();
    } catch {
      this.gradientColor.click();
    }
  }

  private addGradientStopAt(position: number): void {
    const clamped = Math.max(0, Math.min(100, position));
    const existing = this.gradientStops.findIndex((stop) => Math.abs(stop.position - clamped) < 1.2);
    if (existing >= 0) {
      this.gradientSelected = existing;
      this.syncGradientInputs();
      this.renderGradientEditor();
      return;
    }
    this.gradientStops.push({ position: clamped, color: this.sampleGradientColor(clamped) });
    this.gradientSelected = this.gradientStops.length - 1;
    this.renderGradientEditor();
  }

  private addAlphaStopAt(position: number): void {
    const clamped = Math.max(0, Math.min(100, position));
    const existing = this.gradientAlphaStops.findIndex((stop) => Math.abs(stop.position - clamped) < 1.2);
    if (existing >= 0) {
      this.gradientAlphaSelected = existing;
      this.syncGradientInputs();
      this.renderGradientEditor();
      return;
    }
    this.gradientAlphaStops.push({ position: clamped, alpha: this.sampleGradientAlpha(clamped) });
    this.gradientAlphaSelected = this.gradientAlphaStops.length - 1;
    this.renderGradientEditor();
  }

  private removeGradientStopAt(index: number): void {
    if (index < 0 || index >= this.gradientStops.length) return;
    if (this.gradientStops.length <= 1) {
      this.callbacks.toast('至少保留一个颜色色标', 'info');
      return;
    }
    this.gradientStops.splice(index, 1);
    this.gradientSelected = Math.min(index, this.gradientStops.length - 1);
    this.renderGradientEditor();
  }

  private removeAlphaStopAt(index: number): void {
    if (index < 0 || index >= this.gradientAlphaStops.length) return;
    if (this.gradientAlphaStops.length <= 1) {
      this.callbacks.toast('至少需要保留一个透明度标', 'info');
      return;
    }
    this.gradientAlphaStops.splice(index, 1);
    this.gradientAlphaSelected = Math.min(index, this.gradientAlphaStops.length - 1);
    this.renderGradientEditor();
  }

  private resetGradient(): void {
    this.gradientStops = [
      { position: 0, color: '#ff7878' },
      { position: 100, color: '#ff3b3b' }
    ];
    this.gradientAlphaStops = [
      { position: 0, alpha: 1 },
      { position: 100, alpha: 1 }
    ];
    this.gradientSelected = 1;
    this.gradientAlphaSelected = 1;
    this.renderGradientEditor();
  }

  private buildGradientOutput(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) return canvas;
    const sorted = this.gradientStops.slice().sort((a, b) => a.position - b.position);
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
    for (const stop of sorted) {
      gradient.addColorStop(Math.max(0, Math.min(1, stop.position / 100)), stop.color);
    }
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const alphaSorted = this.gradientAlphaStops.slice().sort((a, b) => a.position - b.position);
    if (alphaSorted.length > 0) {
      const alphaGradient = context.createLinearGradient(0, 0, canvas.width, 0);
      for (const stop of alphaSorted) {
        alphaGradient.addColorStop(
          Math.max(0, Math.min(1, stop.position / 100)),
          `rgba(255, 255, 255, ${Math.max(0, Math.min(1, stop.alpha))})`
        );
      }
      context.globalCompositeOperation = 'destination-in';
      context.fillStyle = alphaGradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'source-over';
    }
    return canvas;
  }

  private applyGradientOutput(): void {
    const output = this.buildGradientOutput();
    this.setImage(
      output,
      output.width,
      output.height,
      `${this.currentBaseName()}_gradient.png`,
      '',
      output.width * output.height * 4,
      { preserveTransform: true, preserveHistory: false, skipNormalDetect: true, preservePath: true }
    );
    this.setPanelMode('tools');
    this.callbacks.toast('已创建渐变贴图', 'success');
  }

  private async exportGradientOutput(): Promise<void> {
    const output = this.buildGradientOutput();
    try {
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const saved = await window.nyxel.file.savePng(data, `${this.currentBaseName()}_gradient.png`);
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private syncPathDefaults(): void {
    if (!this.bitmap) return;
    const width = this.imageWidth || 512;
    const height = this.imageHeight || 512;
    if (!this.pathCustomSize.checked) {
      this.pathSizeW.value = String(width);
      this.pathSizeH.value = String(height);
    }
  }

  private pathTargetSize(): { width: number; height: number } {
    const custom = this.pathCustomSize.checked;
    return {
      width: Math.max(1, Math.min(4096, custom ? Number(this.pathSizeW.value) || 512 : this.imageWidth || 512)),
      height: Math.max(1, Math.min(4096, custom ? Number(this.pathSizeH.value) || 512 : this.imageHeight || 512))
    };
  }

  private samplePenPath(): PenSample[] {
    const points = this.penPoints;
    if (points.length < 2) return [];
    const segments = points.length - 1;
    const steps = Math.max(24, Math.min(96, Math.round(480 / segments)));
    const samples: PenSample[] = [];
    for (let index = 0; index < segments; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const c1x = start.x + start.outX;
      const c1y = start.y + start.outY;
      const c2x = end.x + end.inX;
      const c2y = end.y + end.inY;
      for (let step = 0; step < steps; step += 1) {
        const t = step / steps;
        const mt = 1 - t;
        samples.push({
          x: mt * mt * mt * start.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * end.x,
          y: mt * mt * mt * start.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * end.y,
          t: (index + t) / segments
        });
      }
    }
    const last = points[points.length - 1];
    samples.push({ x: last.x, y: last.y, t: 1 });
    return samples;
  }

  private pathWidthFactor(t: number): number {
    const head = Math.max(0, Math.min(200, Number(this.pathHeadWidth.value) || 0)) / 100;
    const middle = Math.max(0, Math.min(200, Number(this.pathMiddleWidth.value) || 0)) / 100;
    const tail = Math.max(0, Math.min(200, Number(this.pathTailWidth.value) || 0)) / 100;
    if (t < 0.5) return head + (middle - head) * (t / 0.5);
    return middle + (tail - middle) * ((t - 0.5) / 0.5);
  }

  private buildPathOutput(width: number, height: number): HTMLCanvasElement | null {
    const samples = this.samplePenPath();
    if (samples.length < 2) return null;
    const stroke = document.createElement('canvas');
    stroke.width = width;
    stroke.height = height;
    const strokeCtx = stroke.getContext('2d');
    if (!strokeCtx) return null;
    const baseWidth = Math.max(0.5, (Math.max(1, Math.min(100, Number(this.pathWidth.value) || 59)) / 100) * Math.min(width, height) * 0.12);
    for (const sample of samples) {
      const radius = Math.max(0.35, baseWidth * this.pathWidthFactor(sample.t) / 2);
      strokeCtx.fillStyle = this.sampleGradientColor(sample.t * 100);
      strokeCtx.beginPath();
      strokeCtx.arc(sample.x * width, sample.y * height, radius, 0, Math.PI * 2);
      strokeCtx.fill();
    }

    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d');
    if (!context) return null;
    const hardness = Math.max(0, Math.min(100, Number(this.pathHardness.value) || 0)) / 100;
    const opacity = Math.max(0, Math.min(100, Number(this.pathOpacity.value) || 0)) / 100;
    const blur = Math.min(90, (1 - hardness) * baseWidth * 0.8);
    context.globalAlpha = opacity;
    if (blur > 0.4) context.filter = `blur(${blur}px)`;
    context.drawImage(stroke, 0, 0);
    context.filter = 'none';
    context.globalAlpha = 1;
    return output;
  }

  private schedulePathRender(): void {
    window.clearTimeout(this.pathTimer);
    this.pathTimer = window.setTimeout(() => this.renderPathGradient(), 50);
  }

  private renderPathGradient(): void {
    const canvas = this.pathPreview;
    const context = this.pathCtx;
    const previewWidth = canvas.width;
    const previewHeight = canvas.height;
    context.clearRect(0, 0, previewWidth, previewHeight);
    const checker = 10;
    for (let y = 0; y < previewHeight; y += checker) {
      for (let x = 0; x < previewWidth; x += checker) {
        context.fillStyle = (x / checker + y / checker) % 2 === 0 ? '#242424' : '#191919';
        context.fillRect(x, y, checker, checker);
      }
    }

    const target = this.pathTargetSize();
    const previewScale = Math.min(1, 640 / Math.max(target.width, target.height));
    const outputWidth = Math.max(1, Math.round(target.width * previewScale));
    const outputHeight = Math.max(1, Math.round(target.height * previewScale));
    const output = this.buildPathOutput(outputWidth, outputHeight);
    this.pathOutput = output;
    if (output) {
      const scale = Math.min(previewWidth / output.width, previewHeight / output.height);
      const drawWidth = output.width * scale;
      const drawHeight = output.height * scale;
      const offsetX = (previewWidth - drawWidth) / 2;
      const offsetY = (previewHeight - drawHeight) / 2;
      context.imageSmoothingEnabled = true;
      context.drawImage(output, offsetX, offsetY, drawWidth, drawHeight);
      const samples = this.samplePenPath();
      if (samples.length >= 2) {
        const head = samples[0];
        const tail = samples[samples.length - 1];
        const headX = offsetX + head.x * drawWidth;
        const headY = offsetY + head.y * drawHeight;
        const tailX = offsetX + tail.x * drawWidth;
        const tailY = offsetY + tail.y * drawHeight;
        context.font = '600 10px "Segoe UI", sans-serif';
        context.textAlign = 'center';
        context.fillStyle = '#7ee2a8';
        context.fillText('头', headX, headY - 10);
        context.fillStyle = '#7db7ff';
        context.fillText('尾', tailX, tailY - 10);
      }
    } else {
      context.fillStyle = 'rgba(255, 255, 255, 0.45)';
      context.font = '11px "Segoe UI", sans-serif';
      context.textAlign = 'center';
      context.fillText('用钢笔在左侧绘制路径后在此预览', previewWidth / 2, previewHeight / 2);
    }

    const status = this.penEditing
      ? `钢笔：左键加点 / 拖动曲线 / 右键删点 · ${this.penPoints.length} 锚点`
      : this.penPoints.length < 2
        ? '先用钢笔在左侧绘制路径'
        : `路径 ${this.penPoints.length} 个锚点 · 头 → 尾`;
    this.pathStatus.textContent = status;
    this.syncPenOverlayVisibility();
  }

  private applyPathGradient(): void {
    if (this.penPoints.length < 2) {
      this.callbacks.toast('请先用钢笔在左侧绘制路径', 'info');
      return;
    }
    const target = this.pathTargetSize();
    const output = this.buildPathOutput(target.width, target.height);
    if (!output) {
      this.callbacks.toast('路径生成失败，请重新绘制', 'error');
      return;
    }
    this.pathOutput = output;
    if (this.penEditing) this.setPenEditing(false);
    this.setImage(
      output,
      output.width,
      output.height,
      `${this.currentBaseName()}_path_gradient.png`,
      '',
      output.width * output.height * 4,
      { preserveTransform: true, preserveHistory: false, preservePath: true, skipNormalDetect: true }
    );
    this.setPanelMode('tools');
    this.callbacks.toast('已应用路径渐变', 'success');
  }

  private async exportPathGradient(): Promise<void> {
    if (this.penPoints.length < 2) {
      this.callbacks.toast('请先用钢笔在左侧绘制路径', 'info');
      return;
    }
    const target = this.pathTargetSize();
    const output = this.buildPathOutput(target.width, target.height);
    if (!output) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      const data = new Uint8Array(await blob.arrayBuffer());
      const saved = await window.nyxel.file.savePng(data, `${this.currentBaseName()}_path_gradient.png`);
      if (saved) this.callbacks.toast(`已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private clearPenPath(notify: boolean): void {
    this.penPoints = [];
    this.penEditing = false;
    this.penDrag = null;
    this.penPanning = false;
    this.pathOutput = null;
    this.element.querySelector('[data-path-pen]')?.classList.remove('active');
    this.syncPenOverlayVisibility();
    this.renderPenOverlay();
    this.renderPathGradient();
    if (notify) this.callbacks.toast('已清除路径', 'info');
  }

  private resetPathGradient(): void {
    this.pathWidth.value = '59';
    this.pathWidthValue.value = '59';
    this.pathHardness.value = '70';
    this.pathHardnessValue.value = '70';
    this.pathHeadWidth.value = '100';
    this.pathHeadWidthValue.value = '100';
    this.pathMiddleWidth.value = '100';
    this.pathMiddleWidthValue.value = '100';
    this.pathTailWidth.value = '100';
    this.pathTailWidthValue.value = '100';
    this.pathOpacity.value = '100';
    this.pathOpacityValue.value = '100';
    this.pathCustomSize.checked = false;
    this.pathEqual.checked = true;
    this.pathSizeW.disabled = true;
    this.pathSizeH.disabled = true;
    this.syncPathDefaults();
    this.renderPathGradient();
  }

  private setPenEditing(active: boolean): void {
    if (active && !this.bitmap) {
      this.callbacks.toast('请先打开一张贴图', 'info');
      return;
    }
    if (active) {
      this.penVisible = true;
      this.pathShow.checked = true;
    }
    this.penEditing = active;
    this.penDrag = null;
    this.penPanning = false;
    this.element.querySelector('[data-path-pen]')?.classList.toggle('active', active);
    this.body.classList.toggle('pen-editing', active && this.panelMode === 'tools');
    this.syncPenOverlayVisibility();
    this.renderPathGradient();
    this.renderPenOverlay();
  }

  private pickPenPath(): void {
    if (this.penPoints.length < 2) {
      this.callbacks.toast('请先用钢笔在左侧绘制路径', 'info');
      return;
    }
    this.setPenEditing(false);
    this.renderPathGradient();
    this.callbacks.toast(`已拾取路径 · ${this.penPoints.length} 个锚点`, 'success');
  }

  private syncPenOverlayVisibility(): void {
    const pathSection = this.toolsPanelBody.querySelector('[data-ai-section="path"]');
    const pathOpen = pathSection !== null && !pathSection.classList.contains('collapsed');
    const visible = Boolean(
      this.bitmap &&
      this.mesh &&
      this.panelMode === 'tools' &&
      pathOpen &&
      (this.penEditing || (this.penVisible && this.penPoints.length >= 2))
    );
    this.penOverlay.classList.toggle('hidden', !visible);
    this.penOverlay.classList.toggle('active', visible && this.penEditing);
    this.body.classList.toggle('pen-editing', visible && this.penEditing);
    if (visible) {
      this.syncPenOverlayRect();
      this.renderPenOverlay();
    }
  }

  private syncPenOverlayRect(): void {
    if (!this.mesh || !this.canvas) return;
    const canvasRect = this.canvas.getBoundingClientRect();
    const bodyRect = this.body.getBoundingClientRect();
    const width = Math.max(1, Math.round(canvasRect.width));
    const height = Math.max(1, Math.round(canvasRect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.penOverlay.style.left = `${canvasRect.left - bodyRect.left}px`;
    this.penOverlay.style.top = `${canvasRect.top - bodyRect.top}px`;
    this.penOverlay.style.width = `${width}px`;
    this.penOverlay.style.height = `${height}px`;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.penOverlay.width !== pixelWidth) this.penOverlay.width = pixelWidth;
    if (this.penOverlay.height !== pixelHeight) this.penOverlay.height = pixelHeight;
  }

  private penPointToScreen(x: number, y: number): { x: number; y: number } {
    const rect = this.penOverlay.getBoundingClientRect();
    if (!this.mesh || !this.imageWidth || !this.imageHeight) return { x: 0, y: 0 };
    const aspect = this.imageWidth / Math.max(1, this.imageHeight);
    let u = x;
    let v = 1 - y;
    if (this.flipH) u = 1 - u;
    if (this.flipV) v = 1 - v;
    const local = new THREE.Vector3((u - 0.5) * aspect, v - 0.5, 0);
    const world = local.applyMatrix4(this.mesh.matrixWorld);
    const projected = world.project(this.camera);
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height
    };
  }

  private penEventToImage(event: PointerEvent): { x: number; y: number } | null {
    if (!this.mesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      return null;
    }
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv) return null;
    let u = hit.uv.x;
    let v = hit.uv.y;
    if (this.flipH) u = 1 - u;
    if (this.flipV) v = 1 - v;
    return {
      x: Math.max(0, Math.min(1, u)),
      y: Math.max(0, Math.min(1, 1 - v))
    };
  }

  private penHitTest(event: PointerEvent | MouseEvent): { kind: 'anchor' | 'in' | 'out'; index: number } | null {
    const rect = this.penOverlay.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const close = (x: number, y: number, radius: number): boolean => Math.hypot(x - mouseX, y - mouseY) <= radius;
    for (let index = this.penPoints.length - 1; index >= 0; index -= 1) {
      const point = this.penPoints[index];
      if (point.inX || point.inY) {
        const handle = this.penPointToScreen(point.x + point.inX, point.y + point.inY);
        if (close(handle.x, handle.y, 7)) return { kind: 'in', index };
      }
      if (point.outX || point.outY) {
        const handle = this.penPointToScreen(point.x + point.outX, point.y + point.outY);
        if (close(handle.x, handle.y, 7)) return { kind: 'out', index };
      }
      const anchor = this.penPointToScreen(point.x, point.y);
      if (close(anchor.x, anchor.y, 8)) return { kind: 'anchor', index };
    }
    return null;
  }

  private penPointerDown(event: PointerEvent): void {
    if (!this.penEditing) return;
    if (event.button === 1) {
      event.preventDefault();
      this.penPanning = true;
      this.penPanX = event.clientX;
      this.penPanY = event.clientY;
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    const hit = this.penHitTest(event);
    if (hit) {
      this.penDrag = { kind: hit.kind, index: hit.index, moved: false };
      this.renderPenOverlay();
      return;
    }
    const point = this.penEventToImage(event);
    if (!point) return;
    this.penPoints.push({ x: point.x, y: point.y, inX: 0, inY: 0, outX: 0, outY: 0 });
    this.penDrag = { kind: 'new', index: this.penPoints.length - 1, moved: false };
    this.renderPenOverlay();
    this.schedulePathRender();
  }

  private penPointerMove(event: PointerEvent): void {
    if (this.penPanning) {
      const dx = event.clientX - this.penPanX;
      const dy = event.clientY - this.penPanY;
      this.penPanX = event.clientX;
      this.penPanY = event.clientY;
      const worldWidth = (this.camera.right - this.camera.left) / this.camera.zoom;
      const worldHeight = (this.camera.top - this.camera.bottom) / this.camera.zoom;
      this.panX -= (dx / Math.max(1, this.canvas.clientWidth)) * worldWidth;
      this.panY += (dy / Math.max(1, this.canvas.clientHeight)) * worldHeight;
      this.updateCamera();
      return;
    }
    if (!this.penEditing || !this.penDrag) return;
    const point = this.penEventToImage(event);
    if (!point) return;
    const drag = this.penDrag;
    const target = this.penPoints[drag.index];
    if (!target) return;
    if (drag.kind === 'new') {
      const dx = point.x - target.x;
      const dy = point.y - target.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.003) return;
      target.outX = dx;
      target.outY = dy;
      target.inX = -dx;
      target.inY = -dy;
    } else if (drag.kind === 'anchor') {
      target.x = point.x;
      target.y = point.y;
    } else {
      const dx = point.x - target.x;
      const dy = point.y - target.y;
      if (drag.kind === 'out') {
        target.outX = dx;
        target.outY = dy;
        if (!event.altKey) {
          target.inX = -dx;
          target.inY = -dy;
        }
      } else {
        target.inX = dx;
        target.inY = dy;
        if (!event.altKey) {
          target.outX = -dx;
          target.outY = -dy;
        }
      }
    }
    drag.moved = true;
    this.renderPenOverlay();
    this.schedulePathRender();
  }

  private penPointerUp(): void {
    if (this.penPanning) this.penPanning = false;
    if (!this.penEditing || !this.penDrag) return;
    const drag = this.penDrag;
    this.penDrag = null;
    if (drag.kind === 'new' && !drag.moved) {
      const point = this.penPoints[drag.index];
      if (point) {
        point.inX = 0;
        point.inY = 0;
        point.outX = 0;
        point.outY = 0;
      }
    }
    this.renderPenOverlay();
    this.renderPathGradient();
  }

  private penContextMenu(event: MouseEvent): void {
    if (!this.penEditing) return;
    event.preventDefault();
    const hit = this.penHitTest(event);
    if (!hit || hit.kind !== 'anchor') return;
    this.penPoints.splice(hit.index, 1);
    this.penDrag = null;
    this.renderPenOverlay();
    this.renderPathGradient();
  }

  private renderPenScreenEffect(
    samples: Array<{ t: number; screen: { x: number; y: number } }>,
    rect: DOMRect
  ): void {
    if (!this.imageWidth || !this.imageHeight) return;
    const effectWidth = Math.max(1, Math.round(rect.width));
    const effectHeight = Math.max(1, Math.round(rect.height));
    if (this.penEffectCanvas.width !== effectWidth) this.penEffectCanvas.width = effectWidth;
    if (this.penEffectCanvas.height !== effectHeight) this.penEffectCanvas.height = effectHeight;
    const context = this.penEffectCtx;
    context.clearRect(0, 0, effectWidth, effectHeight);
    const center = this.penPointToScreen(0.5, 0.5);
    const xStep = this.penPointToScreen(0.5 + 1 / Math.max(1, this.imageWidth), 0.5);
    const yStep = this.penPointToScreen(0.5, 0.5 + 1 / Math.max(1, this.imageHeight));
    const screenScale = Math.max(
      0.01,
      (Math.hypot(xStep.x - center.x, xStep.y - center.y) +
        Math.hypot(yStep.x - center.x, yStep.y - center.y)) / 2
    );
    const baseWidth = Math.max(
      0.5,
      (Math.max(1, Math.min(100, Number(this.pathWidth.value) || 59)) / 100) *
        Math.min(this.imageWidth, this.imageHeight) *
        0.12
    );
    const step = Math.max(1, Math.floor(samples.length / 240));
    for (let index = 0; index < samples.length; index += step) {
      const sample = samples[index];
      const radius = Math.max(0.35, baseWidth * this.pathWidthFactor(sample.t) / 2 * screenScale);
      context.fillStyle = this.sampleGradientColor(sample.t * 100);
      context.beginPath();
      context.arc(sample.screen.x, sample.screen.y, radius, 0, Math.PI * 2);
      context.fill();
    }
    const hardness = Math.max(0, Math.min(100, Number(this.pathHardness.value) || 0)) / 100;
    const opacity = Math.max(0, Math.min(100, Number(this.pathOpacity.value) || 0)) / 100;
    const blur = Math.min(80, (1 - hardness) * baseWidth * 0.8 * screenScale);
    this.penCtx.save();
    this.penCtx.globalAlpha = opacity;
    if (blur > 0.4) this.penCtx.filter = `blur(${blur}px)`;
    this.penCtx.drawImage(this.penEffectCanvas, 0, 0, rect.width, rect.height);
    this.penCtx.filter = 'none';
    this.penCtx.restore();
  }

  private renderPenOverlay(): void {
    if (!this.penOverlay || !this.mesh || !this.bitmap) return;
    if (this.penOverlay.classList.contains('hidden')) return;
    this.syncPenOverlayRect();
    const rect = this.penOverlay.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = this.penOverlay.width / Math.max(1, rect.width);
    this.penCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.penCtx.clearRect(0, 0, rect.width, rect.height);
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();

    const samples = this.samplePenPath();
    if (samples.length >= 2) {
      const screenSamples = samples.map((sample) => ({
        t: sample.t,
        screen: this.penPointToScreen(sample.x, sample.y)
      }));
      this.renderPenScreenEffect(screenSamples, rect);
      if (this.penEditing) {
        this.penCtx.beginPath();
        screenSamples.forEach((sample, index) => {
          if (index === 0) this.penCtx.moveTo(sample.screen.x, sample.screen.y);
          else this.penCtx.lineTo(sample.screen.x, sample.screen.y);
        });
        this.penCtx.lineJoin = 'round';
        this.penCtx.lineCap = 'round';
        this.penCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        this.penCtx.lineWidth = 4;
        this.penCtx.stroke();
        this.penCtx.strokeStyle = '#f5b13d';
        this.penCtx.lineWidth = 1.6;
        this.penCtx.stroke();
      }
    }

    if (!this.penEditing) return;
    this.penPoints.forEach((point, index) => {
      const anchor = this.penPointToScreen(point.x, point.y);
      if (point.inX || point.inY) {
        const handle = this.penPointToScreen(point.x + point.inX, point.y + point.inY);
        this.penCtx.beginPath();
        this.penCtx.moveTo(anchor.x, anchor.y);
        this.penCtx.lineTo(handle.x, handle.y);
        this.penCtx.strokeStyle = 'rgba(245, 177, 61, 0.55)';
        this.penCtx.lineWidth = 1;
        this.penCtx.stroke();
        this.penCtx.beginPath();
        this.penCtx.arc(handle.x, handle.y, 3, 0, Math.PI * 2);
        this.penCtx.fillStyle = '#f5b13d';
        this.penCtx.fill();
      }
      if (point.outX || point.outY) {
        const handle = this.penPointToScreen(point.x + point.outX, point.y + point.outY);
        this.penCtx.beginPath();
        this.penCtx.moveTo(anchor.x, anchor.y);
        this.penCtx.lineTo(handle.x, handle.y);
        this.penCtx.strokeStyle = 'rgba(245, 177, 61, 0.55)';
        this.penCtx.lineWidth = 1;
        this.penCtx.stroke();
        this.penCtx.beginPath();
        this.penCtx.arc(handle.x, handle.y, 3, 0, Math.PI * 2);
        this.penCtx.fillStyle = '#f5b13d';
        this.penCtx.fill();
      }
      const isFirst = index === 0;
      const isLast = index === this.penPoints.length - 1;
      this.penCtx.beginPath();
      this.penCtx.rect(anchor.x - 4, anchor.y - 4, 8, 8);
      this.penCtx.fillStyle = isFirst ? '#7ee2a8' : isLast ? '#7db7ff' : '#ffffff';
      this.penCtx.fill();
      this.penCtx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      this.penCtx.lineWidth = 1;
      this.penCtx.stroke();
      if (isFirst || isLast) {
        this.penCtx.font = '600 10px "Segoe UI", sans-serif';
        this.penCtx.textAlign = 'center';
        this.penCtx.fillStyle = isFirst ? '#7ee2a8' : '#7db7ff';
        this.penCtx.fillText(isFirst ? '头' : '尾', anchor.x, anchor.y - 9);
      }
    });
  }

  private clampSequenceGrid(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 7;
    return Math.max(1, Math.min(32, Math.round(parsed)));
  }

  private aiSequenceSource(): { bitmap: ImageBitmap | HTMLCanvasElement; width: number; height: number } | null {
    if (this.aiSeqSource.value === 'child' && this.composeSource) {
      return {
        bitmap: this.composeSource.bitmap,
        width: this.composeSource.bitmap.width,
        height: this.composeSource.bitmap.height
      };
    }
    if (!this.bitmap) return null;
    return { bitmap: this.bitmap, width: this.imageWidth, height: this.imageHeight };
  }

  private aiSequenceFrameCount(): number {
    return this.clampSequenceGrid(this.aiSeqCols.value) * this.clampSequenceGrid(this.aiSeqRows.value);
  }

  private aiSequenceFrames(): number[] {
    return [...this.aiSeqSelected].sort((a, b) => a - b);
  }

  private resetAiSequenceSelection(): void {
    this.stopAiSequence();
    this.aiSeqFrameIndex = 0;
    this.aiSeqSelected.clear();
    for (let index = 0; index < this.aiSequenceFrameCount(); index += 1) this.aiSeqSelected.add(index);
  }

  private selectAllAiSequenceFrames(): void {
    this.stopAiSequence();
    this.aiSeqFrameIndex = 0;
    this.aiSeqSelected.clear();
    for (let index = 0; index < this.aiSequenceFrameCount(); index += 1) this.aiSeqSelected.add(index);
  }

  private selectAiSequenceRow(): void {
    this.stopAiSequence();
    const cols = this.clampSequenceGrid(this.aiSeqCols.value);
    const rows = this.clampSequenceGrid(this.aiSeqRows.value);
    const row = Math.min(rows - 1, this.aiSeqLastCell >= 0 ? Math.floor(this.aiSeqLastCell / cols) : 0);
    this.aiSeqSelected.clear();
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (index < cols * rows) this.aiSeqSelected.add(index);
    }
    this.aiSeqFrameIndex = 0;
  }

  private selectAiSequenceCell(event: PointerEvent): void {
    const source = this.aiSequenceSource();
    if (!source) return;
    const rect = this.aiSeqGrid.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * this.aiSeqGrid.width;
    const y = ((event.clientY - rect.top) / rect.height) * this.aiSeqGrid.height;
    const layout = this.aiSeqLayout;
    const col = Math.floor((x - layout.x) / Math.max(1, layout.cellWidth));
    const row = Math.floor((y - layout.y) / Math.max(1, layout.cellHeight));
    const cols = this.clampSequenceGrid(this.aiSeqCols.value);
    const rows = this.clampSequenceGrid(this.aiSeqRows.value);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return;
    const index = row * cols + col;
    this.stopAiSequence();
    if (this.aiSeqSelected.has(index)) this.aiSeqSelected.delete(index);
    else this.aiSeqSelected.add(index);
    this.aiSeqLastCell = index;
    this.aiSeqFrameIndex = 0;
    this.renderAiSequenceGrid();
  }

  private renderAiSequenceGrid(): void {
    const context = this.aiSeqGridCtx;
    const canvas = this.aiSeqGrid;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#0b0d10';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const source = this.aiSequenceSource();
    if (!source) {
      context.fillStyle = '#7ba4cc';
      context.font = '12px "Microsoft YaHei", sans-serif';
      context.textAlign = 'center';
      context.fillText('载入图片后可用', canvas.width / 2, canvas.height / 2);
      this.aiSeqCount.textContent = '0 / 0';
      this.aiSeqStatus.textContent = '载入图片后可用';
      return;
    }
    const cols = this.clampSequenceGrid(this.aiSeqCols.value);
    const rows = this.clampSequenceGrid(this.aiSeqRows.value);
    const margin = 8;
    const scale = Math.min((canvas.width - margin * 2) / source.width, (canvas.height - margin * 2) / source.height);
    const width = Math.max(1, source.width * scale);
    const height = Math.max(1, source.height * scale);
    const x = (canvas.width - width) / 2;
    const y = (canvas.height - height) / 2;
    const cellWidth = width / cols;
    const cellHeight = height / rows;
    this.aiSeqLayout = { x, y, width, height, cellWidth, cellHeight };
    context.imageSmoothingEnabled = true;
    context.drawImage(source.bitmap as CanvasImageSource, x, y, width, height);

    const frames = this.aiSequenceFrames();
    const currentFrame = frames[Math.min(this.aiSeqFrameIndex, Math.max(0, frames.length - 1))];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        const cellX = x + col * cellWidth;
        const cellY = y + row * cellHeight;
        if (this.aiSeqSelected.has(index)) {
          context.fillStyle = index === currentFrame ? 'rgba(90, 169, 255, 0.1)' : 'rgba(90, 169, 255, 0.035)';
          context.fillRect(cellX, cellY, cellWidth, cellHeight);
        }
        context.strokeStyle = index === currentFrame ? '#8fc8ff' : 'rgba(90, 169, 255, 0.3)';
        context.lineWidth = index === currentFrame ? 2 : 1;
        context.strokeRect(cellX, cellY, cellWidth, cellHeight);
        if (cols * rows <= 64) {
          context.fillStyle = index === currentFrame ? '#e1f1ff' : 'rgba(180, 214, 245, 0.7)';
          context.font = '8px sans-serif';
          context.textAlign = 'left';
          context.fillText(String(index + 1), cellX + 3, cellY + 10);
        }
      }
    }
    this.aiSeqCount.textContent = `${this.aiSeqSelected.size} / ${cols * rows}`;
    this.renderAiSequencePreview();
  }

  private renderAiSequencePreview(): void {
    const context = this.aiSeqPreviewCtx;
    const canvas = this.aiSeqPreview;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#0b0d10';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const source = this.aiSequenceSource();
    const frames = this.aiSequenceFrames();
    if (!source || !frames.length) {
      this.aiSeqStatus.textContent = source ? '至少选择一帧' : '载入图片后可用';
      return;
    }
    const displayIndex = Math.min(this.aiSeqFrameIndex, frames.length - 1);
    const index = frames[displayIndex];
    const cols = this.clampSequenceGrid(this.aiSeqCols.value);
    const rows = this.clampSequenceGrid(this.aiSeqRows.value);
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x0 = Math.round((col / cols) * source.width);
    const x1 = Math.round(((col + 1) / cols) * source.width);
    const y0 = Math.round((row / rows) * source.height);
    const y1 = Math.round(((row + 1) / rows) * source.height);
    const width = Math.max(1, x1 - x0);
    const height = Math.max(1, y1 - y0);
    const scale = Math.min(canvas.width / width, canvas.height / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    context.imageSmoothingEnabled = true;
    context.drawImage(
      source.bitmap as CanvasImageSource,
      x0,
      y0,
      width,
      height,
      (canvas.width - drawWidth) / 2,
      (canvas.height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
    this.aiSeqStatus.textContent = `帧 ${displayIndex + 1} / ${frames.length} · 单元格 ${index + 1}`;
  }

  private toggleAiSequencePlay(): void {
    if (this.aiSeqPlaying) {
      this.stopAiSequence();
      return;
    }
    const frames = this.aiSequenceFrames();
    if (!frames.length) {
      this.callbacks.toast('请先在网格中选择至少一帧', 'info');
      return;
    }
    this.aiSeqPlaying = true;
    this.aiSeqPlayButton.textContent = '暂停';
    this.aiSeqFrameIndex = Math.min(this.aiSeqFrameIndex, frames.length - 1);
    this.aiSeqLastTime = performance.now();
    const loop = (now: number): void => {
      if (!this.aiSeqPlaying) return;
      const currentFrames = this.aiSequenceFrames();
      if (!currentFrames.length) {
        this.stopAiSequence();
        return;
      }
      const fps = Math.max(1, Math.min(60, Number(this.aiSeqFps.value) || 12));
      if (now - this.aiSeqLastTime >= 1000 / fps) {
        this.aiSeqLastTime = now;
        this.aiSeqFrameIndex += 1;
        if (this.aiSeqFrameIndex >= currentFrames.length) {
          if (this.aiSeqLoop.checked) this.aiSeqFrameIndex = 0;
          else {
            this.aiSeqFrameIndex = currentFrames.length - 1;
            this.renderAiSequencePreview();
            this.renderAiSequenceGrid();
            this.stopAiSequence();
            return;
          }
        }
        this.renderAiSequencePreview();
        this.renderAiSequenceGrid();
      }
      this.aiSeqRaf = requestAnimationFrame(loop);
    };
    this.aiSeqRaf = requestAnimationFrame(loop);
  }

  private stopAiSequence(): void {
    this.aiSeqPlaying = false;
    cancelAnimationFrame(this.aiSeqRaf);
    this.aiSeqRaf = 0;
    this.aiSeqPlayButton.textContent = '播放';
  }

  private applyAiSequenceFrame(): void {
    const source = this.aiSequenceSource();
    const frames = this.aiSequenceFrames();
    if (!source || !frames.length) {
      this.callbacks.toast('请先在网格中选择至少一帧', 'info');
      return;
    }
    const index = frames[Math.min(this.aiSeqFrameIndex, frames.length - 1)];
    const cols = this.clampSequenceGrid(this.aiSeqCols.value);
    const rows = this.clampSequenceGrid(this.aiSeqRows.value);
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x0 = Math.round((col / cols) * source.width);
    const x1 = Math.round(((col + 1) / cols) * source.width);
    const y0 = Math.round((row / rows) * source.height);
    const y1 = Math.round(((row + 1) / rows) * source.height);
    const width = Math.max(1, x1 - x0);
    const height = Math.max(1, y1 - y0);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(source.bitmap as CanvasImageSource, x0, y0, width, height, 0, 0, width, height);
    this.setImage(
      canvas,
      width,
      height,
      `${this.currentBaseName()}_${index + 1}.png`,
      '',
      width * height * 4,
      { preserveTransform: true, preserveHistory: false }
    );
    this.aiSeqCols.value = '1';
    this.aiSeqRows.value = '1';
    this.setAiMode(true);
    this.callbacks.toast(`已应用序列帧 ${index + 1}`, 'success');
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
    this.syncAiModelOptions();
    this.updateAiButtons();
    await this.refreshAiStatus();
  }

  private closeAiPanel(): void {
    this.aiOverlay.classList.add('hidden');
  }

  private async refreshAiStatus(): Promise<void> {
    const status = await window.nyxel.ai.status(this.aiEngine, this.currentAiModel());
    this.aiAvailable = status.available;
    const label = this.aiEngineLabel();
    const size = this.aiEngine === 'upscayl' ? '约 33 MB' : '约 45 MB';
    this.aiRuntime.classList.toggle('ready', status.available);
    this.aiPluginWarning.classList.toggle('hidden', status.available);
    this.aiRuntime.textContent = status.available
      ? `${label} 运行时已就绪 · ${status.dir}`
      : status.downloading
        ? `正在下载 ${label} 运行时…`
        : `尚未下载 ${label} 运行时（${size}）`;
    if (this.aiPanelStatus) {
      this.aiPanelStatus.textContent = status.available
        ? `${label} 运行时已就绪`
        : status.downloading
          ? `正在下载 ${label} 运行时…`
          : `需要下载 ${label} 运行时（${size}）`;
      this.aiPanelStatus.classList.toggle('ready', status.available);
    }
    const labelElement = this.element.querySelector('#ai-engine-label') as HTMLElement | null;
    if (labelElement) labelElement.textContent = `AI 超分（${label}）`;
    this.aiEngineSelect.value = this.aiEngine;
    this.aiModelSelect.value = this.currentAiModel();
    this.updateAiButtons();
  }

  private updateAiButtons(): void {
    this.element.querySelectorAll<HTMLButtonElement>('[data-ai-scale]').forEach((button) => {
      button.disabled = !this.aiAvailable || this.aiBusy;
    });
    this.element.querySelectorAll<HTMLButtonElement>('[data-ai-panel-scale]').forEach((button) => {
      button.disabled = this.aiBusy;
    });
    this.element.querySelectorAll<HTMLButtonElement>('[data-ai-preset]').forEach((button) => {
      button.disabled = this.aiBusy;
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
    this.aiModelRow.style.display = 'flex';
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
    const model = this.currentAiModel();
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

  private async applyAiPreset(preset: 'vfx' | 'texture'): Promise<void> {
    if (this.aiBusy) return;
    if (preset === 'vfx') {
      this.aiEngine = 'realesrgan';
      this.aiRealesrganModel = 'realesrgan-x4plus-anime';
    } else {
      this.aiEngine = 'upscayl';
      this.aiUpscaylModel = 'ultrasharp-4x';
    }
    this.aiEngineSelect.value = this.aiEngine;
    this.syncAiModelOptions();
    this.aiAvailable = false;
    this.updateAiButtons();
    await this.refreshAiStatus();
    if (!this.aiAvailable) {
      this.callbacks.toast(`请先下载 ${this.aiEngineLabel()} 运行时`, 'info');
      return;
    }
    await this.aiScale(4);
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

      const model = this.currentAiModel();
      const result = await window.nyxel.ai.upscale(data, scale, this.aiEngine, model);
      if (!result.ok || !result.data || !result.width || !result.height) {
        if (result.error !== '已取消') {
          this.callbacks.toast(`AI 超分失败：${result.error ?? '未知错误'}`, 'error');
        }
        return;
      }
      const output = new Blob([new Uint8Array(result.data)], { type: 'image/png' });
      const bitmap = await createImageBitmap(output);
      const modelSuffix = this.aiEngine === 'upscayl'
        ? model.replace(/-4x$/, '')
        : model.replace(/^realesrgan-/, '').replace(/-4x$/, '');
      this.showCompare(
        this.bitmap,
        this.imageWidth,
        this.imageHeight,
        bitmap,
        result.width,
        result.height,
        `${this.currentBaseName()}_${modelSuffix}_${scale}x.png`,
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
    if (this.aiMode) this.renderAiSequenceGrid();
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
    const viewAspect = Math.max(0.001, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
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
    this.renderPenOverlay();
  }

  private updateCamera(): void {
    this.camera.zoom = this.zoom;
    this.camera.position.set(this.panX, this.panY, 1);
    this.camera.updateProjectionMatrix();
    this.renderPenOverlay();
  }

  private resize(): void {
    // The docked compose panel changes the canvas width through padding, while
    // the body size stays the same. Size the renderer from the canvas itself so
    // the preview keeps its aspect ratio instead of being squeezed sideways.
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (this.mesh) this.fit();
    this.renderer.render(this.scene, this.camera);
    this.syncPenOverlayRect();
    this.renderPenOverlay();
    this.updateCompareLayout();
  }

  private applyTransform(): void {
    if (!this.mesh) return;
    this.mesh.rotation.z = THREE.MathUtils.degToRad(this.rotation);
    this.mesh.scale.set(this.flipH ? -1 : 1, this.flipV ? -1 : 1, 1);
    this.renderPenOverlay();
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

  private showTextureMenu(x: number, y: number): void {
    const items: Array<[string, () => void]> = [
      ['适配窗口', () => this.fit()],
      ['旋转 -90°', () => this.rotate(-90)],
      ['旋转 +90°', () => this.rotate(90)],
      ['水平翻转', () => this.flip('h')],
      ['垂直翻转', () => this.flip('v')]
    ];
    this.textureMenu.innerHTML = '';
    for (const [label, action] of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        this.hideTextureMenu();
        action();
      });
      this.textureMenu.append(button);
    }
    this.textureMenu.classList.remove('hidden');
    requestAnimationFrame(() => {
      const rect = this.textureMenu.getBoundingClientRect();
      this.textureMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
      this.textureMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    });
  }

  private hideTextureMenu(): void {
    this.textureMenu.classList.add('hidden');
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

  private setLevelsEnabled(value: boolean): void {
    this.levelsEnabled = value;
    const button = this.element.querySelector('#mono-toggle') as HTMLButtonElement | null;
    if (button) button.classList.toggle('active', value);
    this.levelsInline.classList.toggle('hidden', !value);
    this.updateLevelUniforms();
    this.callbacks.status.set(this.fileName, this.metaText());
  }

  private setCurvesEnabled(value: boolean): void {
    this.curvesEnabled = value;
    this.curveToggle.classList.toggle('active', value);
    this.curvePanel.classList.toggle('hidden', !value);
    if (value) this.buildCurveLut();
    if (this.material) this.material.uniforms.uCurves.value = value ? 1 : 0;
    this.callbacks.status.set(this.fileName, this.metaText());
  }

  private bindCurveEditor(): void {
    const canvas = this.curveCanvas;
    const pointFromEvent = (event: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
      const py = ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height;
      return {
        px,
        py,
        x: Math.max(0, Math.min(1, px / canvas.width)),
        y: Math.max(0, Math.min(1, 1 - py / canvas.height))
      };
    };
    const hitPoint = (px: number, py: number) => this.curvePoints.findIndex((point) => (
      Math.hypot(point.x * canvas.width - px, (1 - point.y) * canvas.height - py) <= 10
    ));
    canvas.addEventListener('pointerdown', (event) => {
      const point = pointFromEvent(event);
      const index = hitPoint(point.px, point.py);
      if (index < 0) return;
      event.preventDefault();
      this.curveDragIndex = index;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this.curveDragIndex < 0) return;
      const point = pointFromEvent(event);
      const index = this.curveDragIndex;
      const current = this.curvePoints[index];
      if (!current) return;
      if (index === 0) current.x = 0;
      else if (index === this.curvePoints.length - 1) current.x = 1;
      else {
        const min = this.curvePoints[index - 1].x + 0.008;
        const max = this.curvePoints[index + 1].x - 0.008;
        current.x = Math.max(min, Math.min(max, point.x));
      }
      current.y = point.y;
      this.buildCurveLut();
    });
    const endDrag = () => { this.curveDragIndex = -1; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', (event) => {
      const point = pointFromEvent(event);
      const index = hitPoint(point.px, point.py);
      if (index >= 0) {
        if (index === 0 || index === this.curvePoints.length - 1) return;
        this.curvePoints.splice(index, 1);
        this.buildCurveLut();
        return;
      }
      if (point.x <= 0.01 || point.x >= 0.99) return;
      this.curvePoints.push({ x: point.x, y: point.y });
      this.curvePoints.sort((left, right) => left.x - right.x);
      this.buildCurveLut();
    });
  }

  private resetCurve(): void {
    this.curvePoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    this.buildCurveLut();
  }

  private buildCurveLut(): void {
    const points = this.curvePoints.slice().sort((left, right) => left.x - right.x);
    if (points.length < 2) {
      points.splice(0, points.length, { x: 0, y: 0 }, { x: 1, y: 1 });
    }
    const count = points.length;
    const slopes: number[] = [];
    for (let index = 0; index < count - 1; index += 1) {
      slopes.push((points[index + 1].y - points[index].y) / Math.max(0.0001, points[index + 1].x - points[index].x));
    }
    const tangents: number[] = new Array(count).fill(0);
    tangents[0] = slopes[0] ?? 0;
    tangents[count - 1] = slopes[count - 2] ?? 0;
    for (let index = 1; index < count - 1; index += 1) {
      tangents[index] = ((slopes[index - 1] ?? 0) + (slopes[index] ?? 0)) / 2;
    }
    for (let index = 0; index < 256; index += 1) {
      const x = index / 255;
      let y: number;
      if (x <= points[0].x) {
        y = points[0].y;
      } else if (x >= points[count - 1].x) {
        y = points[count - 1].y;
      } else {
        let segment = 0;
        while (segment < count - 2 && x > points[segment + 1].x) segment += 1;
        const left = points[segment];
        const right = points[segment + 1];
        const span = Math.max(0.0001, right.x - left.x);
        const t = (x - left.x) / span;
        const t2 = t * t;
        const t3 = t2 * t;
        y = (2 * t3 - 3 * t2 + 1) * left.y
          + (t3 - 2 * t2 + t) * span * tangents[segment]
          + (-2 * t3 + 3 * t2) * right.y
          + (t3 - t2) * span * tangents[segment + 1];
      }
      const value = Math.round(Math.max(0, Math.min(1, y)) * 255);
      const offset = index * 4;
      this.curveData[offset] = value;
      this.curveData[offset + 1] = value;
      this.curveData[offset + 2] = value;
      this.curveData[offset + 3] = 255;
    }
    this.curveTexture.needsUpdate = true;
    if (this.material) {
      this.material.uniforms.uCurves.value = this.curvesEnabled ? 1 : 0;
    }
    this.drawCurveEditor();
  }

  private drawCurveEditor(): void {
    const canvas = this.curveCanvas;
    const context = this.curveCtx;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#151515';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#303030';
    context.lineWidth = 1;
    for (let index = 1; index < 4; index += 1) {
      const x = (index / 4) * width;
      const y = (index / 4) * height;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.setLineDash([4, 4]);
    context.strokeStyle = '#3c3c3c';
    context.beginPath();
    context.moveTo(0, height);
    context.lineTo(width, 0);
    context.stroke();
    context.setLineDash([]);
    context.strokeStyle = '#9fe0b8';
    context.lineWidth = 1.6;
    context.beginPath();
    for (let index = 0; index < 256; index += 1) {
      const x = (index / 255) * width;
      const y = (1 - this.curveData[index * 4] / 255) * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    for (const point of this.curvePoints) {
      const x = point.x * width;
      const y = (1 - point.y) * height;
      context.beginPath();
      context.arc(x, y, 4, 0, Math.PI * 2);
      context.fillStyle = '#0c3626';
      context.fill();
      context.strokeStyle = '#9fe0b8';
      context.lineWidth = 1.5;
      context.stroke();
    }
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
    this.material.uniforms.uLevels.value = this.levelsEnabled ? 1 : 0;
    this.material.uniforms.uBlack.value = this.levelBlack / 255;
    this.material.uniforms.uWhite.value = Math.max(this.levelBlack + 1, this.levelWhite) / 255;
    this.material.uniforms.uGamma.value = Math.max(0.01, this.levelGamma);
  }

  private applyLevelsToCanvas(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const black = this.levelBlack / 255;
    const range = Math.max(1 / 255, (this.levelWhite - this.levelBlack) / 255);
    const inverseGamma = 1 / Math.max(0.01, this.levelGamma);
    const level = (value: number) => Math.round(
      Math.pow(Math.min(1, Math.max(0, (value / 255 - black) / range)), inverseGamma) * 255
    );
    for (let index = 0; index < image.data.length; index += 4) {
      image.data[index] = level(image.data[index]);
      image.data[index + 1] = level(image.data[index + 1]);
      image.data[index + 2] = level(image.data[index + 2]);
    }
    context.putImageData(image, 0, 0);
  }

  private applyCurvesToCanvas(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < image.data.length; index += 4) {
      image.data[index] = this.curveData[image.data[index] * 4];
      image.data[index + 1] = this.curveData[image.data[index + 1] * 4];
      image.data[index + 2] = this.curveData[image.data[index + 2] * 4];
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
    this.stopAiSequence();
  }
}

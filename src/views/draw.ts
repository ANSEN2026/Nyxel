import type { ViewCallbacks } from '../types';
import { mimeFromExt } from '../utils';

const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 1000;
const HISTORY_LIMIT = 30;
const LAYOUT_KEY = 'texturemap.draw.layout.v2';

type DrawTool =
  | 'brush'
  | 'eraser'
  | 'fill'
  | 'gradient'
  | 'quick-select'
  | 'lasso'
  | 'rect'
  | 'round-rect'
  | 'ellipse'
  | 'polygon';
type ToolGroup = 'fill' | 'selection' | 'shape';
const FILL_TOOLS: DrawTool[] = ['fill', 'gradient'];
const SHAPE_TOOLS: DrawTool[] = ['rect', 'round-rect', 'ellipse', 'polygon'];
const SELECTION_TOOLS: DrawTool[] = ['quick-select', 'lasso'];
const TOOL_GROUP_DEFS: Record<ToolGroup, { shortcut: string; options: Array<{ tool: DrawTool; label: string }> }> = {
  fill: {
    shortcut: 'G',
    options: [
      { tool: 'fill', label: '油漆桶' },
      { tool: 'gradient', label: '渐变工具' }
    ]
  },
  selection: {
    shortcut: 'W',
    options: [
      { tool: 'quick-select', label: '快速选区' },
      { tool: 'lasso', label: '套索' }
    ]
  },
  shape: {
    shortcut: 'U',
    options: [
      { tool: 'rect', label: '矩形工具' },
      { tool: 'round-rect', label: '圆角矩形工具' },
      { tool: 'ellipse', label: '椭圆工具' },
      { tool: 'polygon', label: '多边形工具' }
    ]
  }
};
type LayerProp = 'opacity' | 'scale' | 'offsetX' | 'offsetY';
const LAYER_PROPS: LayerProp[] = ['opacity', 'scale', 'offsetX', 'offsetY'];
const BLEND_MODES = [
  { value: 'source-over', label: '正常' },
  { value: 'multiply', label: '正片叠底' },
  { value: 'screen', label: '滤色' },
  { value: 'overlay', label: '叠加' },
  { value: 'darken', label: '变暗' },
  { value: 'lighten', label: '变亮' },
  { value: 'color-dodge', label: '颜色减淡' },
  { value: 'color-burn', label: '颜色加深' },
  { value: 'hard-light', label: '强光' },
  { value: 'soft-light', label: '柔光' },
  { value: 'difference', label: '差值' },
  { value: 'exclusion', label: '排除' },
  { value: 'hue', label: '色相' },
  { value: 'saturation', label: '饱和度' },
  { value: 'color', label: '颜色' },
  { value: 'luminosity', label: '亮度' }
] as const;
type BlendMode = typeof BLEND_MODES[number]['value'];

interface PropertyKeyframe {
  time: number;
  value: number;
}

type LayerKeyframes = Record<LayerProp, PropertyKeyframe[]>;

interface DrawLayer {
  id: string;
  name: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  start: number;
  end: number;
  visible: boolean;
  opacity: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  blendMode: BlendMode;
  keyframes: LayerKeyframes;
  imageCache?: string;
}

interface DrawLayerSnapshot {
  id: string;
  name: string;
  start: number;
  end: number;
  visible: boolean;
  opacity: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  blendMode: BlendMode;
  keyframes: LayerKeyframes;
  image: string;
}

interface DrawHistorySnapshot {
  layers: DrawLayerSnapshot[];
  selectedLayerId: string;
  duration: number;
}

interface DrawProjectFile extends DrawHistorySnapshot {
  version: 1;
  app: 'texture-map';
  savedAt: string;
  canvasWidth: number;
  canvasHeight: number;
  currentTime: number;
}

interface DrawRecentProject {
  path: string;
  name: string;
  time: number;
}

interface TransformState {
  layerId: string;
  original: HTMLCanvasElement;
  bounds: { x: number; y: number; width: number; height: number };
  box: { x: number; y: number; width: number; height: number };
  drag: {
    mode: 'move' | 'nw' | 'ne' | 'sw' | 'se';
    pointerId: number;
    startX: number;
    startY: number;
    box: { x: number; y: number; width: number; height: number };
  } | null;
}

const RECENT_PROJECTS_KEY = 'texturemap.draw.recentProjects';

interface DrawLayout {
  rail: number;
  inspector: number;
  timeline: number;
  layers: number;
}

export class DrawView {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private active = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private colorInput: HTMLInputElement;
  private fgColorInput: HTMLInputElement;
  private bgColorInput: HTMLInputElement;
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
  private spacePanUsed = false;
  private tool: DrawTool = 'brush';
  private color = '#8fc3a2';
  private backgroundColor = '#ffffff';
  private lineWidth = 8;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
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
  private timelineBody: HTMLElement;
  private timelineRuler: HTMLElement;
  private timelineTracks: HTMLElement;
  private timelinePlayhead: HTMLElement;
  private timelineTime: HTMLElement;
  private timelineDuration: HTMLInputElement;
  private playButton: HTMLButtonElement;
  private exportButton: HTMLButtonElement;
  private layerList: HTMLElement;
  private blendInput: HTMLSelectElement;
  private opacityInput: HTMLInputElement;
  private opacityValue: HTMLElement;
  private scaleInput: HTMLInputElement;
  private scaleValue: HTMLElement;
  private offsetXInput: HTMLInputElement;
  private offsetXValue: HTMLElement;
  private offsetYInput: HTMLInputElement;
  private offsetYValue: HTMLElement;
  private timelineScrubbing = false;
  private exporting = false;
  private exportCancelled = false;
  private exportOverlay: HTMLElement;
  private exportProgress: HTMLElement;
  private exportStatus: HTMLElement;
  private drawBody: HTMLElement;
  private timelineElement: HTMLElement;
  private layout: DrawLayout = { rail: 54, inspector: 250, timeline: 178, layers: 170 };
  private layoutDrag: {
    target: keyof DrawLayout;
    startClient: number;
    startSize: number;
    pointerId: number;
    handle: HTMLElement;
  } | null = null;
  private panelDrag: {
    panel: HTMLElement;
    pointerId: number;
    handle: HTMLElement;
  } | null = null;
  private layerDrag: {
    layerId: string;
    row: HTMLElement;
    pointerId: number;
    handle: HTMLElement;
  } | null = null;
  private lassoing = false;
  private lassoPoints: Array<{ x: number; y: number }> = [];
  private shapeDraft: {
    layer: DrawLayer;
    snapshot: ImageData;
    startX: number;
    startY: number;
  } | null = null;
  private selectionMask: HTMLCanvasElement | null = null;
  private selectionOverlay: HTMLCanvasElement | null = null;
  private selectionLayerId = '';
  private hideSelection = false;
  private transformState: TransformState | null = null;
  private toolMenu: HTMLElement;
  private toolMenuTimer = 0;
  private toolMenuHideTimer = 0;
  private toolMenuGroup: ToolGroup | null = null;
  private toolMenuButton: HTMLElement | null = null;
  private historySnapshots: DrawHistorySnapshot[] = [];
  private historyIndex = -1;
  private historyBusy = false;
  private projectPath: string | null = null;
  private projectReady = false;
  private startScreen: HTMLElement;
  private recentList: HTMLElement;

  constructor(callbacks: ViewCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view draw-view';
    this.element.innerHTML = `
      <div class="view-toolbar draw-toolbar">
        <strong class="files-title">绘画</strong>
        <span class="files-sub" id="draw-info">${CANVAS_WIDTH} × ${CANVAS_HEIGHT}</span>
        <span class="spacer"></span>
        <button type="button" data-draw-action="project-new" title="新建绘画项目">新建项目</button>
        <button type="button" data-draw-action="project-open" title="打开 .tmproj 工程（Ctrl+O）">打开工程</button>
        <button type="button" data-draw-action="project-save" title="保存分层工程（Ctrl+S）">保存工程</button>
        <button type="button" data-draw-action="open">打开图片</button>
        <button type="button" class="primary" data-draw-action="save">保存 PNG</button>
      </div>
      <div class="view-body draw-body">
        <div class="draw-rail" aria-label="绘画工具">
          <div class="notebook-rail-label">工具</div>
          <button type="button" class="active" data-draw-tool="brush" title="画笔（P）">✎</button>
          <button type="button" data-draw-tool="eraser" title="橡皮擦（E）">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.8 15.5 7.8-7.8a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8l-5.6 5.6H8.3z"/><path d="m9.4 10.8 5.8 5.8"/><path d="M4 20h16"/></svg>
          </button>
          <button type="button" class="draw-tool-group" data-tool-group="fill" data-draw-tool="fill" title="油漆桶（长按悬停选择，G 切换）">
            <span class="draw-group-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 13.5 7-7 7 7-7 7z"/><path d="m8 10 6 6"/><path d="M18.5 15.4c1.4 1.8 2.1 3 2.1 3.9a2.1 2.1 0 0 1-4.2 0c0-.9.7-2.1 2.1-3.9z"/></svg>
            </span>
            <span class="draw-tool-caret">◢</span>
          </button>
          <button type="button" class="draw-tool-group" data-tool-group="selection" data-draw-tool="quick-select" title="快速选区（长按悬停选择，W 切换）">
            <span class="draw-group-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 9.2-9.2"/><path d="m14.5 3.5.9 2.8 2.8.9-2.8.9-.9 2.8-.9-2.8-2.8-.9 2.8-.9z"/></svg>
            </span>
            <span class="draw-tool-caret">◢</span>
          </button>
          <button type="button" class="draw-tool-group" data-tool-group="shape" data-draw-tool="rect" title="形状工具（长按悬停选择，U 切换）">
            <span class="draw-group-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1"/></svg>
            </span>
            <span class="draw-tool-caret">◢</span>
          </button>
          <div class="draw-rail-colors" title="前景色 / 背景色">
            <input id="draw-fg-color" class="draw-rail-color fg" type="color" value="#8fc3a2" title="前景色（Alt+Delete 填充）">
            <input id="draw-bg-color" class="draw-rail-color bg" type="color" value="#ffffff" title="背景色（Ctrl+Delete 填充）">
            <button type="button" class="draw-swap-colors" data-draw-swap-colors title="交换前景 / 背景色">⇄</button>
          </div>
          <button type="button" data-draw-action="clear" title="清空当前图层">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 3.5h5l.8 3.5H8.7z"/><path d="m6.5 7 1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/></svg>
          </button>
        </div>
        <div class="draw-resizer" data-draw-resizer="rail" title="拖动调整工具栏宽度"></div>
        <div class="draw-workarea">
          <div class="draw-canvas-wrap" id="draw-canvas-wrap">
            <canvas id="draw-canvas" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
            <button class="notebook-view-badge hidden" id="draw-view-badge" type="button" title="适应画布">100%</button>
          </div>
          <div class="draw-timeline-resizer" data-draw-resizer="timeline" title="拖动调整时间轴高度"></div>
          <div class="draw-timeline">
            <div class="draw-timeline-bar">
              <button id="draw-timeline-play" type="button" title="播放 / 暂停（空格）">▶</button>
              <span id="draw-timeline-time">0:00.0 / 0:10.0</span>
              <label>时长 <input id="draw-timeline-duration" type="number" min="1" max="120" step="1" value="10"> 秒</label>
              <span class="spacer"></span>
              <span class="draw-timeline-hint">空格播放 / 暂停 · 拖动时间轴定位 · 拖两端调整时长</span>
              <button id="draw-timeline-export" type="button" class="primary" title="把时间轴合成为视频文件">合成视频</button>
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
            <span>P 画笔 · E 橡皮 · W 选区 · U 形状 · G 填充 · Ctrl+T 变换 · 空格播放 · Alt+取色</span>
            <span class="draw-size">画布 ${CANVAS_WIDTH} × ${CANVAS_HEIGHT}</span>
          </div>
          <div class="draw-export-overlay hidden" id="draw-export-overlay">
            <div class="draw-export-card">
              <strong>正在合成视频</strong>
              <div class="draw-export-track"><span id="draw-export-progress"></span></div>
              <p id="draw-export-status">准备中…</p>
              <button type="button" id="draw-export-cancel">取消</button>
            </div>
          </div>
        </div>
        <div class="draw-resizer" data-draw-resizer="inspector" title="拖动调整属性面板宽度"></div>
        <aside class="draw-side" aria-label="绘画面板">
          <div class="draw-inspector" aria-label="绘画属性">
          <section class="notebook-panel draw-collapsible" data-draw-panel="brush">
            <button type="button" class="draw-panel-head" data-draw-panel-toggle="brush" aria-expanded="true">
              <span class="draw-panel-head-left">
                <span class="draw-panel-grip" data-draw-panel-grip title="拖动排序">≡</span>
                <span class="draw-panel-title">画笔</span>
              </span>
              <span class="draw-panel-caret">▾</span>
            </button>
            <div class="draw-panel-body" data-draw-panel-body="brush">
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
            <div class="notebook-panel-row draw-brush-size">
              <span>大小</span>
              <input id="draw-width" type="range" min="1" max="60" step="1" value="8">
              <strong id="draw-width-value">8</strong>
            </div>
            <div class="draw-quick-fill-row">
              <button type="button" data-draw-fill-layer title="用当前颜色填充整个图层（Alt+Delete）">快速填充整层</button>
              <span>Alt+Delete 前景<br>Ctrl+Delete 背景</span>
            </div>
            </div>
          </section>
          <section class="notebook-panel draw-collapsible" data-draw-panel="props">
            <div class="draw-panel-head draw-panel-head-split">
              <button type="button" class="draw-panel-toggle" data-draw-panel-toggle="props" aria-expanded="true">
                <span class="draw-panel-head-left">
                  <span class="draw-panel-grip" data-draw-panel-grip title="拖动排序">≡</span>
                  <span class="draw-panel-title">属性</span>
                </span>
                <span class="draw-panel-caret">▾</span>
              </button>
              <button type="button" class="draw-prop-reset" data-draw-props-reset title="恢复当前图层的默认透明度、缩放和位置">重置</button>
            </div>
            <div class="draw-panel-body" data-draw-panel-body="props">
            <div class="draw-blend-row">
              <span>混合模式</span>
              <select id="draw-layer-blend" title="图层混合模式">
                ${BLEND_MODES.map((mode) => `<option value="${mode.value}">${mode.label}</option>`).join('')}
              </select>
            </div>
            <div class="draw-prop-row">
              <span>不透明度</span>
              <input id="draw-layer-opacity" type="range" min="0" max="100" step="1" value="100">
              <strong id="draw-layer-opacity-value">100%</strong>
              <button type="button" class="draw-kf-button" data-draw-keyframe="opacity" title="在当前时间添加 / 删除不透明度关键帧">◆</button>
            </div>
            <div class="draw-prop-row">
              <span>缩放</span>
              <input id="draw-layer-scale" type="range" min="10" max="300" step="1" value="100">
              <strong id="draw-layer-scale-value">100%</strong>
              <button type="button" class="draw-kf-button" data-draw-keyframe="scale" title="在当前时间添加 / 删除缩放关键帧">◆</button>
            </div>
            <div class="draw-prop-row">
              <span>水平</span>
              <input id="draw-layer-x" type="range" min="-800" max="800" step="1" value="0">
              <strong id="draw-layer-x-value">0</strong>
              <button type="button" class="draw-kf-button" data-draw-keyframe="offsetX" title="在当前时间添加 / 删除水平位移关键帧">◆</button>
            </div>
            <div class="draw-prop-row">
              <span>垂直</span>
              <input id="draw-layer-y" type="range" min="-500" max="500" step="1" value="0">
              <strong id="draw-layer-y-value">0</strong>
              <button type="button" class="draw-kf-button" data-draw-keyframe="offsetY" title="在当前时间添加 / 删除垂直位移关键帧">◆</button>
            </div>
            <p class="notebook-view-hint">点击 ◆ 在当前时间打关键帧；已有该属性关键帧时，调节会记录到播放头位置</p>
            </div>
          </section>
          <section class="notebook-panel draw-collapsible" data-draw-panel="view">
            <button type="button" class="draw-panel-head" data-draw-panel-toggle="view" aria-expanded="true">
              <span class="draw-panel-head-left">
                <span class="draw-panel-grip" data-draw-panel-grip title="拖动排序">≡</span>
                <span class="draw-panel-title">视图</span>
              </span>
              <span class="draw-panel-caret">▾</span>
            </button>
            <div class="draw-panel-body" data-draw-panel-body="view">
            <div class="notebook-view-row">
              <span>缩放</span>
              <strong id="draw-view-zoom">100%</strong>
              <button type="button" data-draw-view-fit>适应</button>
            </div>
            <div class="notebook-view-row draw-layout-row">
              <span>布局</span>
              <button type="button" data-draw-layout-reset>重置比例</button>
            </div>
            <p class="notebook-view-hint">Alt + 滚轮缩放 · 空格播放（按住拖动可平移） · 拖动面板间隙调整比例</p>
            </div>
          </section>
          </div>
          <div class="draw-layer-resizer" data-draw-resizer="layers" title="拖动调整图层面板高度"></div>
          <section class="notebook-panel draw-layer-panel">
            <div class="draw-layer-width-grip" data-draw-resizer="inspector" title="拖动调整图层面板宽度"></div>
            <div class="draw-layer-head">
              <h4>图层</h4>
              <div class="draw-layer-actions">
                <button type="button" data-draw-layer-add title="新建空白图层">＋</button>
                <button type="button" data-draw-layer-image title="添加图片图层">▣</button>
              </div>
            </div>
            <div class="draw-layer-list" id="draw-layer-list"></div>
          </section>
        </aside>
      </div>
      <div class="draw-tool-menu hidden" id="draw-tool-menu"></div>
      <div class="draw-start-screen" id="draw-start-screen">
        <div class="draw-start-card">
          <div class="draw-start-mark">
            <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="7" width="36" height="34" rx="4"/><path d="m16 35 3.5-9L35 10.5l4 4L23.5 30z"/><path d="m31 14 4 4"/></svg>
          </div>
          <h2>绘画项目</h2>
          <p>新建一个 ${CANVAS_WIDTH} × ${CANVAS_HEIGHT} 的画布，或打开之前的 .tmproj 工程。</p>
          <div class="draw-start-actions">
            <button type="button" class="primary" data-draw-start="new">新建项目</button>
            <button type="button" data-draw-start="open">打开项目</button>
          </div>
          <div class="draw-start-recent">
            <div class="draw-start-recent-title">最近项目</div>
            <div id="draw-recent-list"></div>
          </div>
        </div>
      </div>
    `;

    this.canvas = this.element.querySelector('#draw-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.colorInput = this.element.querySelector('#draw-color') as HTMLInputElement;
    this.fgColorInput = this.element.querySelector('#draw-fg-color') as HTMLInputElement;
    this.bgColorInput = this.element.querySelector('#draw-bg-color') as HTMLInputElement;
    this.widthInput = this.element.querySelector('#draw-width') as HTMLInputElement;
    this.widthValue = this.element.querySelector('#draw-width-value') as HTMLElement;
    this.canvasWrap = this.element.querySelector('#draw-canvas-wrap') as HTMLElement;
    this.viewBadge = this.element.querySelector('#draw-view-badge') as HTMLButtonElement;
    this.viewZoomLabel = this.element.querySelector('#draw-view-zoom') as HTMLElement;
    this.colorPreview = this.element.querySelector('[data-draw-color-preview]') as HTMLElement;
    this.timelineBody = this.element.querySelector('#draw-timeline-body') as HTMLElement;
    this.timelineRuler = this.element.querySelector('#draw-timeline-ruler') as HTMLElement;
    this.timelineTracks = this.element.querySelector('#draw-timeline-tracks') as HTMLElement;
    this.timelinePlayhead = this.element.querySelector('#draw-timeline-playhead') as HTMLElement;
    this.timelineTime = this.element.querySelector('#draw-timeline-time') as HTMLElement;
    this.timelineDuration = this.element.querySelector('#draw-timeline-duration') as HTMLInputElement;
    this.playButton = this.element.querySelector('#draw-timeline-play') as HTMLButtonElement;
    this.exportButton = this.element.querySelector('#draw-timeline-export') as HTMLButtonElement;
    this.layerList = this.element.querySelector('#draw-layer-list') as HTMLElement;
    this.blendInput = this.element.querySelector('#draw-layer-blend') as HTMLSelectElement;
    this.opacityInput = this.element.querySelector('#draw-layer-opacity') as HTMLInputElement;
    this.opacityValue = this.element.querySelector('#draw-layer-opacity-value') as HTMLElement;
    this.scaleInput = this.element.querySelector('#draw-layer-scale') as HTMLInputElement;
    this.scaleValue = this.element.querySelector('#draw-layer-scale-value') as HTMLElement;
    this.offsetXInput = this.element.querySelector('#draw-layer-x') as HTMLInputElement;
    this.offsetXValue = this.element.querySelector('#draw-layer-x-value') as HTMLElement;
    this.offsetYInput = this.element.querySelector('#draw-layer-y') as HTMLInputElement;
    this.offsetYValue = this.element.querySelector('#draw-layer-y-value') as HTMLElement;
    this.exportOverlay = this.element.querySelector('#draw-export-overlay') as HTMLElement;
    this.exportProgress = this.element.querySelector('#draw-export-progress') as HTMLElement;
    this.exportStatus = this.element.querySelector('#draw-export-status') as HTMLElement;
    this.toolMenu = this.element.querySelector('#draw-tool-menu') as HTMLElement;
    this.startScreen = this.element.querySelector('#draw-start-screen') as HTMLElement;
    this.recentList = this.element.querySelector('#draw-recent-list') as HTMLElement;
    this.drawBody = this.element.querySelector('.draw-body') as HTMLElement;
    this.timelineElement = this.element.querySelector('.draw-timeline') as HTMLElement;
    this.restorePanelOrder();
    this.loadLayout();
    this.renderRecentProjects();
    this.initProject();
    this.bindEvents();
    this.syncColorControls();
    this.applyViewZoom();
  }

  activate(): void {
    this.active = true;
    if (!this.projectReady) {
      this.showStartScreen();
      return;
    }
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, this.toolLabel());
  }

  private getRecentProjects(): DrawRecentProject[] {
    try {
      const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw) as DrawRecentProject[];
      if (!Array.isArray(list)) return [];
      return list.filter((item) => item && typeof item.path === 'string').slice(0, 8);
    } catch {
      return [];
    }
  }

  private recordRecentProject(filePath: string): void {
    const name = filePath.split(/[\\/]/).pop()?.replace(/\.tmproj$/i, '') || '未命名工程';
    const list = this.getRecentProjects().filter((item) => item.path !== filePath);
    list.unshift({ path: filePath, name, time: Date.now() });
    try {
      localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list.slice(0, 8)));
    } catch { /* storage unavailable */ }
    this.renderRecentProjects();
  }

  private renderRecentProjects(): void {
    if (!this.recentList) return;
    this.recentList.innerHTML = '';
    const recent = this.getRecentProjects();
    if (!recent.length) {
      const empty = document.createElement('p');
      empty.className = 'draw-start-empty';
      empty.textContent = '还没有最近项目';
      this.recentList.append(empty);
      return;
    }
    for (const item of recent) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'draw-recent-item';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const pathText = document.createElement('small');
      pathText.textContent = item.path;
      button.append(name, pathText);
      button.title = item.path;
      button.addEventListener('click', () => void this.openProject(item.path));
      this.recentList.append(button);
    }
  }

  private showStartScreen(): void {
    this.projectReady = false;
    this.startScreen.classList.remove('hidden');
    this.renderRecentProjects();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '请新建或打开绘画项目');
  }

  private newProject(confirmCurrent = true): void {
    if (confirmCurrent && this.projectReady && !window.confirm('新建项目会清空当前未保存的绘画，继续？')) return;
    this.layers = [];
    this.selectedLayerId = '';
    this.selectionMask = null;
    this.selectionOverlay = null;
    this.selectionLayerId = '';
    this.lassoing = false;
    this.lassoPoints = [];
    this.shapeDraft = null;
    this.drawing = false;
    this.projectPath = null;
    this.projectReady = true;
    this.initProject();
    this.startScreen.classList.add('hidden');
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '新建项目');
    this.callbacks.toast('已新建绘画项目', 'success');
  }

  private toolLabel(tool = this.tool): string {
    switch (tool) {
      case 'eraser': return '橡皮擦';
      case 'fill': return '油漆桶';
      case 'gradient': return '渐变工具';
      case 'quick-select': return '快速选区';
      case 'lasso': return '套索';
      case 'rect': return '矩形工具';
      case 'round-rect': return '圆角矩形';
      case 'ellipse': return '椭圆工具';
      case 'polygon': return '多边形工具';
      default: return '画笔';
    }
  }

  private toolIconMarkup(tool: DrawTool): string {
    switch (tool) {
      case 'fill':
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 13.5 7-7 7 7-7 7z"/><path d="m8 10 6 6"/><path d="M18.5 15.4c1.4 1.8 2.1 3 2.1 3.9a2.1 2.1 0 0 1-4.2 0c0-.9.7-2.1 2.1-3.9z"/></svg>`;
      case 'gradient':
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M4 18 20 6"/><path d="M4 12.5 14 5.5"/></svg>`;
      case 'quick-select':
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 9.2-9.2"/><path d="m14.5 3.5.9 2.8 2.8.9-2.8.9-.9 2.8-.9-2.8-2.8-.9 2.8-.9z"/></svg>`;
      case 'lasso':
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 10.5c1.2 3.6-2.6 7.5-8 7.5-4.8 0-8-2.7-8-5.8 0-3 3.2-5.7 8-5.7 1.2 0 2.3.2 3.3.5"/><path d="M6.8 13.5c.8-1.1 2.6-1.2 3.4-.2.5.7 0 1.5-1.1 1.5-1.2 0-1.5 1.9-.2 3.2"/></svg>`;
      case 'round-rect':
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="4.5"/></svg>`;
      case 'ellipse':
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="8.5" ry="6.5"/></svg>`;
      case 'polygon':
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 20 8.3v7.4l-8 4.8-8-4.8V8.3z"/></svg>`;
      default:
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1"/></svg>`;
    }
  }

  private groupForTool(tool: DrawTool): ToolGroup | null {
    if (FILL_TOOLS.includes(tool)) return 'fill';
    if (SELECTION_TOOLS.includes(tool)) return 'selection';
    if (SHAPE_TOOLS.includes(tool)) return 'shape';
    return null;
  }

  private setTool(tool: DrawTool): void {
    this.tool = tool;
    const group = this.groupForTool(tool);
    if (group) {
      const button = this.element.querySelector<HTMLElement>(`[data-tool-group="${group}"]`);
      if (button) {
        button.dataset.drawTool = tool;
        button.title = `${this.toolLabel(tool)}（长按悬停选择，${TOOL_GROUP_DEFS[group].shortcut} 切换）`;
        const icon = button.querySelector('.draw-group-icon');
        if (icon) icon.innerHTML = this.toolIconMarkup(tool);
      }
    }
    this.element.querySelectorAll<HTMLElement>('[data-draw-tool]').forEach((item) => {
      item.classList.toggle('active', item.dataset.drawTool === tool);
    });
    this.canvas.style.cursor = tool === 'eraser' ? 'cell' : tool === 'fill' || tool === 'gradient' ? 'copy' : 'crosshair';
    this.callbacks.status.set(undefined, undefined, this.toolLabel());
  }

  private cycleToolGroup(group: ToolGroup): void {
    const options = TOOL_GROUP_DEFS[group].options.map((item) => item.tool);
    if (options.includes(this.tool)) {
      const index = options.indexOf(this.tool);
      this.setTool(options[(index + 1) % options.length]);
    } else {
      this.setTool(options[0]);
    }
  }

  private showToolMenu(group: ToolGroup, button: HTMLElement): void {
    this.toolMenuGroup = group;
    this.toolMenuButton = button;
    const def = TOOL_GROUP_DEFS[group];
    this.toolMenu.innerHTML = def.options.map((option) => `
      <button type="button" data-tool-option="${option.tool}" class="${option.tool === this.tool ? 'active' : ''}">
        ${this.toolIconMarkup(option.tool)}
        <span>${option.label}</span><em>${def.shortcut}</em>
      </button>
    `).join('');
    this.toolMenu.querySelectorAll<HTMLButtonElement>('[data-tool-option]').forEach((option) => {
      option.addEventListener('click', () => {
        this.setTool(option.dataset.toolOption as DrawTool);
        this.hideToolMenu();
      });
    });
    this.toolMenu.classList.remove('hidden');
    const buttonRect = button.getBoundingClientRect();
    const menuRect = this.toolMenu.getBoundingClientRect();
    const left = Math.min(window.innerWidth - menuRect.width - 8, buttonRect.right + 8);
    const top = Math.max(8, Math.min(window.innerHeight - menuRect.height - 8, buttonRect.top - 4));
    this.toolMenu.style.left = `${Math.max(8, left)}px`;
    this.toolMenu.style.top = `${top}px`;
  }

  private hideToolMenu(): void {
    window.clearTimeout(this.toolMenuTimer);
    window.clearTimeout(this.toolMenuHideTimer);
    this.toolMenu.classList.add('hidden');
    this.toolMenuGroup = null;
    this.toolMenuButton = null;
  }

  private scheduleToolMenuHide(): void {
    window.clearTimeout(this.toolMenuHideTimer);
    this.toolMenuHideTimer = window.setTimeout(() => this.toolMenu.classList.add('hidden'), 180);
  }

  deactivate(): void {
    this.active = false;
    this.drawing = false;
    this.spaceHeld = false;
    this.viewPanning = false;
    this.stopPlayback();
    this.canvasWrap.classList.remove('is-pan-ready', 'is-panning');
  }

  private loadLayout(): void {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<DrawLayout>;
        this.layout = {
          rail: Math.max(50, Math.min(110, Number(saved.rail) || 54)),
          inspector: Math.max(215, Math.min(420, Number(saved.inspector) || 250)),
          timeline: Math.max(120, Math.min(360, Number(saved.timeline) || 178)),
          layers: Math.max(84, Math.min(380, Number(saved.layers) || 170))
        };
      }
    } catch { /* use defaults */ }
    this.applyLayout();
  }

  private applyLayout(): void {
    this.drawBody.style.setProperty('--draw-rail-width', `${this.layout.rail}px`);
    this.drawBody.style.setProperty('--draw-inspector-width', `${this.layout.inspector}px`);
    this.drawBody.style.setProperty('--draw-layers-height', `${this.layout.layers}px`);
    this.timelineElement.style.setProperty('--draw-timeline-height', `${this.layout.timeline}px`);
  }

  private saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
    } catch { /* storage unavailable */ }
  }

  private restorePanelOrder(): void {
    try {
      const raw = localStorage.getItem('texturemap.draw.panelOrder');
      if (!raw) return;
      const order = JSON.parse(raw) as string[];
      const inspector = this.element.querySelector('.draw-inspector');
      if (!inspector || !Array.isArray(order)) return;
      for (const key of order) {
        const panel = inspector.querySelector<HTMLElement>(`[data-draw-panel="${key}"]`);
        if (panel) inspector.append(panel);
      }
    } catch { /* keep DOM order */ }
  }

  private savePanelOrder(): void {
    try {
      const inspector = this.element.querySelector('.draw-inspector');
      if (!inspector) return;
      const order = [...inspector.querySelectorAll<HTMLElement>('[data-draw-panel]')]
        .map((panel) => panel.dataset.drawPanel)
        .filter(Boolean);
      localStorage.setItem('texturemap.draw.panelOrder', JSON.stringify(order));
    } catch { /* storage unavailable */ }
  }

  private startPanelDrag(event: PointerEvent, handle: HTMLElement): void {
    if (event.button !== 0) return;
    const panel = handle.closest<HTMLElement>('[data-draw-panel]');
    if (!panel) return;
    event.preventDefault();
    event.stopPropagation();
    this.panelDrag = { panel, pointerId: event.pointerId, handle };
    panel.classList.add('is-panel-dragging');
    this.drawBody.classList.add('is-panel-reordering');
    try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
  }

  private movePanelDrag(event: PointerEvent): void {
    if (!this.panelDrag || event.pointerId !== this.panelDrag.pointerId) return;
    event.preventDefault();
    const inspector = this.element.querySelector('.draw-inspector');
    if (!inspector) return;
    const dragging = this.panelDrag.panel;
    const panels = [...inspector.querySelectorAll<HTMLElement>('[data-draw-panel]')];
    let placed = false;
    for (const panel of panels) {
      if (panel === dragging) continue;
      const rect = panel.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        inspector.insertBefore(dragging, panel);
        placed = true;
        break;
      }
    }
    if (!placed) inspector.append(dragging);
  }

  private endPanelDrag(event: PointerEvent): void {
    if (!this.panelDrag || event.pointerId !== this.panelDrag.pointerId) return;
    const { panel, handle } = this.panelDrag;
    this.panelDrag = null;
    panel.classList.remove('is-panel-dragging');
    this.drawBody.classList.remove('is-panel-reordering');
    try { handle.releasePointerCapture(event.pointerId); } catch { /* released */ }
    this.savePanelOrder();
  }

  private startLayoutDrag(event: PointerEvent, target: keyof DrawLayout): void {
    if (this.exporting || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    this.layoutDrag = {
      target,
      startClient: target === 'timeline' || target === 'layers' ? event.clientY : event.clientX,
      startSize: this.layout[target],
      pointerId: event.pointerId,
      handle
    };
    this.drawBody.classList.add('is-resizing-layout');
    this.timelineElement.classList.add('is-resizing-layout');
    try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
  }

  private moveLayoutDrag(event: PointerEvent): void {
    if (!this.layoutDrag || event.pointerId !== this.layoutDrag.pointerId) return;
    event.preventDefault();
    const target = this.layoutDrag.target;
    const delta = target === 'timeline' || target === 'layers'
      ? this.layoutDrag.startClient - event.clientY
      : target === 'rail'
        ? event.clientX - this.layoutDrag.startClient
        : this.layoutDrag.startClient - event.clientX;
    const next = this.layoutDrag.startSize + delta;
    if (target === 'rail') {
      this.layout.rail = Math.max(50, Math.min(110, next));
    } else if (target === 'inspector') {
      this.layout.inspector = Math.max(215, Math.min(420, next));
    } else if (target === 'layers') {
      this.layout.layers = Math.max(84, Math.min(380, next));
    } else {
      this.layout.timeline = Math.max(120, Math.min(360, next));
    }
    this.applyLayout();
  }

  private endLayoutDrag(event: PointerEvent): void {
    if (!this.layoutDrag || event.pointerId !== this.layoutDrag.pointerId) return;
    const { handle } = this.layoutDrag;
    this.layoutDrag = null;
    this.drawBody.classList.remove('is-resizing-layout');
    this.timelineElement.classList.remove('is-resizing-layout');
    try { handle.releasePointerCapture(event.pointerId); } catch { /* released */ }
    this.saveLayout();
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
    this.resetHistory();
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
      opacity: 1,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      blendMode: 'source-over',
      keyframes: { opacity: [], scale: [], offsetX: [], offsetY: [] }
    };
    this.layerCounter += 1;
    return layer;
  }

  private activeLayer(): DrawLayer | null {
    return this.layers.find((layer) => layer.id === this.selectedLayerId) ?? null;
  }

  private cloneKeyframes(keyframes: LayerKeyframes): LayerKeyframes {
    return {
      opacity: keyframes.opacity.map((item) => ({ ...item })),
      scale: keyframes.scale.map((item) => ({ ...item })),
      offsetX: keyframes.offsetX.map((item) => ({ ...item })),
      offsetY: keyframes.offsetY.map((item) => ({ ...item }))
    };
  }

  private captureSnapshot(): DrawHistorySnapshot {
    return {
      selectedLayerId: this.selectedLayerId,
      duration: this.duration,
      layers: this.layers.map((layer) => {
        const image = layer.imageCache ?? layer.canvas.toDataURL('image/png');
        layer.imageCache = image;
        return {
          id: layer.id,
          name: layer.name,
          start: layer.start,
          end: layer.end,
          visible: layer.visible,
          opacity: layer.opacity,
          scale: layer.scale,
          offsetX: layer.offsetX,
          offsetY: layer.offsetY,
          blendMode: layer.blendMode,
          keyframes: this.cloneKeyframes(layer.keyframes),
          image
        };
      })
    };
  }

  private commitHistory(): void {
    if (this.historyBusy) return;
    const snapshot = this.captureSnapshot();
    this.historySnapshots = this.historySnapshots.slice(0, this.historyIndex + 1);
    this.historySnapshots.push(snapshot);
    if (this.historySnapshots.length > HISTORY_LIMIT) this.historySnapshots.shift();
    this.historyIndex = this.historySnapshots.length - 1;
  }

  private resetHistory(): void {
    this.historySnapshots = [];
    this.historyIndex = -1;
    this.commitHistory();
  }

  private updateLayerThumbnail(layer: DrawLayer): void {
    const thumb = this.layerList.querySelector<HTMLCanvasElement>(`.draw-layer-thumb[data-layer-id="${layer.id}"]`);
    const ctx = thumb?.getContext('2d');
    if (!thumb || !ctx) return;
    ctx.clearRect(0, 0, thumb.width, thumb.height);
    ctx.drawImage(layer.canvas, 0, 0, thumb.width, thumb.height);
  }

  private pushLayerHistory(layer: DrawLayer): void {
    layer.imageCache = undefined;
    this.updateLayerThumbnail(layer);
    this.commitHistory();
  }

  private loadSnapshotImage(url: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      if (!url) { resolve(null); return; }
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
  }

  private async restoreSnapshot(snapshot: DrawHistorySnapshot): Promise<void> {
    if (this.historyBusy) return;
    this.historyBusy = true;
    this.stopPlayback();
    try {
      const images = await Promise.all(snapshot.layers.map((layer) => this.loadSnapshotImage(layer.image)));
      this.layers = snapshot.layers.map((item, index) => {
        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
        const image = images[index];
        if (image) ctx.drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        return {
          id: item.id,
          name: item.name,
          canvas,
          ctx,
          start: item.start,
          end: item.end,
          visible: item.visible,
          opacity: item.opacity,
          scale: item.scale,
          offsetX: item.offsetX,
          offsetY: item.offsetY,
          blendMode: item.blendMode,
          keyframes: this.cloneKeyframes(item.keyframes),
          imageCache: item.image
        };
      });
      this.selectedLayerId = this.layers.some((layer) => layer.id === snapshot.selectedLayerId)
        ? snapshot.selectedLayerId
        : this.layers[0]?.id ?? '';
      this.duration = snapshot.duration;
      this.currentTime = Math.min(this.currentTime, this.duration);
      this.timelineDuration.value = String(this.duration);
      this.selectionMask = null;
      this.selectionOverlay = null;
      this.selectionLayerId = '';
      this.lassoing = false;
      this.lassoPoints = [];
      this.shapeDraft = null;
      this.drawing = false;
      this.renderLayerList();
      this.renderTimeline();
      this.renderComposite();
      this.updateTimeUI();
    } finally {
      this.historyBusy = false;
    }
  }

  private async undo(): Promise<void> {
    if (this.historyBusy || this.historyIndex <= 0) return;
    this.historyIndex -= 1;
    await this.restoreSnapshot(this.historySnapshots[this.historyIndex]);
  }

  private async redo(): Promise<void> {
    if (this.historyBusy || this.historyIndex >= this.historySnapshots.length - 1) return;
    this.historyIndex += 1;
    await this.restoreSnapshot(this.historySnapshots[this.historyIndex]);
  }

  private getLayerProp(layer: DrawLayer, prop: LayerProp, time = this.currentTime): number {
    const list = layer.keyframes[prop];
    if (!list.length) return layer[prop];
    if (time <= list[0].time) return list[0].value;
    const last = list[list.length - 1];
    if (time >= last.time) return last.value;
    for (let index = 0; index < list.length - 1; index += 1) {
      const current = list[index];
      const next = list[index + 1];
      if (time >= current.time && time <= next.time) {
        const span = Math.max(0.0001, next.time - current.time);
        const ratio = (time - current.time) / span;
        return current.value + (next.value - current.value) * ratio;
      }
    }
    return last.value;
  }

  private layerStateAt(layer: DrawLayer, time = this.currentTime): { opacity: number; scale: number; offsetX: number; offsetY: number } {
    return {
      opacity: this.getLayerProp(layer, 'opacity', time),
      scale: this.getLayerProp(layer, 'scale', time),
      offsetX: this.getLayerProp(layer, 'offsetX', time),
      offsetY: this.getLayerProp(layer, 'offsetY', time)
    };
  }

  private keyframeAt(layer: DrawLayer, prop: LayerProp, time: number): number {
    return layer.keyframes[prop].findIndex((item) => Math.abs(item.time - time) < 0.04);
  }

  private setLayerProp(layer: DrawLayer, prop: LayerProp, value: number): void {
    const list = layer.keyframes[prop];
    if (!list.length) {
      layer[prop] = value;
      return;
    }
    const index = this.keyframeAt(layer, prop, this.currentTime);
    if (index >= 0) {
      list[index].value = value;
    } else {
      list.push({ time: this.currentTime, value });
      list.sort((a, b) => a.time - b.time);
    }
  }

  private changeLayerProp(prop: LayerProp, value: number): void {
    const layer = this.activeLayer();
    if (!layer) return;
    this.setLayerProp(layer, prop, value);
    this.renderComposite();
    if (layer.keyframes[prop].length) this.renderTimeline();
    this.syncLayerProps();
  }

  private toggleKeyframe(prop: LayerProp): void {
    const layer = this.activeLayer();
    if (!layer) return;
    const list = layer.keyframes[prop];
    const value = this.getLayerProp(layer, prop, this.currentTime);
    const index = this.keyframeAt(layer, prop, this.currentTime);
    if (index >= 0) {
      list.splice(index, 1);
      if (!list.length) layer[prop] = value;
    } else {
      list.push({ time: this.currentTime, value });
      list.sort((a, b) => a.time - b.time);
    }
    this.renderComposite();
    this.renderTimeline();
    this.syncLayerProps();
    this.commitHistory();
  }

  private keyframeCount(layer: DrawLayer): number {
    return LAYER_PROPS.reduce((total, prop) => total + layer.keyframes[prop].length, 0);
  }

  private renderComposite(): void {
    this.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      if (this.currentTime + 0.0001 < layer.start || this.currentTime - 0.0001 > layer.end) continue;
      const state = this.layerStateAt(layer);
      const centerX = CANVAS_WIDTH / 2;
      const centerY = CANVAS_HEIGHT / 2;
      this.ctx.save();
      this.ctx.globalCompositeOperation = layer.blendMode;
      this.ctx.globalAlpha = state.opacity;
      this.ctx.translate(centerX + state.offsetX, centerY + state.offsetY);
      this.ctx.scale(state.scale, state.scale);
      const transform = this.transformState?.layerId === layer.id ? this.transformState : null;
      if (transform) {
        const scaleX = transform.box.width / Math.max(1, transform.bounds.width);
        const scaleY = transform.box.height / Math.max(1, transform.bounds.height);
        const destX = transform.box.x - transform.bounds.x * scaleX;
        const destY = transform.box.y - transform.bounds.y * scaleY;
        this.ctx.drawImage(transform.original, destX - centerX, destY - centerY, CANVAS_WIDTH * scaleX, CANVAS_HEIGHT * scaleY);
      } else {
        this.ctx.drawImage(layer.canvas, -centerX, -centerY);
      }
      this.ctx.restore();
    }
    if (!this.hideSelection && this.selectionOverlay && this.selectionLayerId) {
      const selectedLayer = this.layers.find((layer) => layer.id === this.selectionLayerId);
      if (selectedLayer) {
        const state = this.layerStateAt(selectedLayer);
        const centerX = CANVAS_WIDTH / 2;
        const centerY = CANVAS_HEIGHT / 2;
        this.ctx.save();
        this.ctx.translate(centerX + state.offsetX, centerY + state.offsetY);
        this.ctx.scale(state.scale, state.scale);
        this.ctx.drawImage(this.selectionOverlay, -centerX, -centerY);
        this.ctx.restore();
      }
    }
    if (!this.hideSelection && this.transformState) this.renderTransformOverlay();
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
    if (this.transformState) this.applyTransform();
    const layer = this.layers.find((item) => item.id === layerId);
    if (!layer) return;
    if (this.selectionLayerId && this.selectionLayerId !== layer.id) this.clearSelection();
    this.selectedLayerId = layer.id;
    if (this.currentTime < layer.start || this.currentTime > layer.end) {
      this.currentTime = layer.start;
    }
    this.renderLayerList();
    this.renderTimeline();
    this.updateTimeUI();
    this.renderComposite();
  }

  private addLayer(name = `图层 ${this.layers.length + 1}`, select = true, commit = true): DrawLayer {
    if (this.transformState) this.applyTransform();
    const layer = this.createLayer(name);
    this.layers.push(layer);
    if (select) {
      if (this.selectionLayerId) this.clearSelection();
      this.selectedLayerId = layer.id;
      this.currentTime = Math.max(0, Math.min(this.currentTime, layer.end));
    }
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.updateTimeUI();
    if (commit) this.commitHistory();
    return layer;
  }

  private deleteLayer(layerId: string): void {
    if (this.transformState) this.applyTransform();
    if (this.layers.length <= 1) {
      this.callbacks.toast('至少保留一个图层', 'info');
      return;
    }
    const index = this.layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return;
    if (this.selectionLayerId === layerId) this.clearSelection();
    this.layers.splice(index, 1);
    if (this.selectedLayerId === layerId) {
      this.selectedLayerId = this.layers[Math.max(0, index - 1)]?.id ?? this.layers[0].id;
    }
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.commitHistory();
  }

  private toggleLayerVisibility(layerId: string): void {
    const layer = this.layers.find((item) => item.id === layerId);
    if (!layer) return;
    layer.visible = !layer.visible;
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.commitHistory();
  }

  private duplicateLayer(layerId: string): void {
    if (this.transformState) this.applyTransform();
    const source = this.layers.find((layer) => layer.id === layerId);
    if (!source) return;
    const copy = this.createLayer(`${source.name} 副本`);
    copy.ctx.drawImage(source.canvas, 0, 0);
    copy.start = source.start;
    copy.end = source.end;
    copy.visible = source.visible;
    copy.opacity = source.opacity;
    copy.scale = source.scale;
    copy.offsetX = source.offsetX;
    copy.offsetY = source.offsetY;
    copy.blendMode = source.blendMode;
    copy.keyframes = this.cloneKeyframes(source.keyframes);
    const index = this.layers.findIndex((layer) => layer.id === source.id);
    this.layers.splice(index + 1, 0, copy);
    this.selectedLayerId = copy.id;
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.commitHistory();
    this.callbacks.toast(`已复制「${source.name}」`, 'success');
  }

  private startLayerDrag(event: PointerEvent, handle: HTMLElement): void {
    if (event.button !== 0) return;
    const row = handle.closest<HTMLElement>('.draw-layer-row');
    const layerId = row?.dataset.layerId;
    if (!row || !layerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.layerDrag = { layerId, row, pointerId: event.pointerId, handle };
    row.classList.add('is-layer-dragging');
    this.layerList.classList.add('is-reordering-layers');
    try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
  }

  private moveLayerDrag(event: PointerEvent): void {
    if (!this.layerDrag || event.pointerId !== this.layerDrag.pointerId) return;
    event.preventDefault();
    const dragging = this.layerDrag.row;
    const rows = [...this.layerList.querySelectorAll<HTMLElement>('.draw-layer-row')];
    let placed = false;
    for (const row of rows) {
      if (row === dragging) continue;
      const rect = row.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        this.layerList.insertBefore(dragging, row);
        placed = true;
        break;
      }
    }
    if (!placed) this.layerList.append(dragging);
  }

  private endLayerDrag(event: PointerEvent): void {
    if (!this.layerDrag || event.pointerId !== this.layerDrag.pointerId) return;
    const { layerId, row, handle } = this.layerDrag;
    this.layerDrag = null;
    row.classList.remove('is-layer-dragging');
    this.layerList.classList.remove('is-reordering-layers');
    try { handle.releasePointerCapture(event.pointerId); } catch { /* released */ }
    const visualOrder = [...this.layerList.querySelectorAll<HTMLElement>('.draw-layer-row')]
      .map((item) => item.dataset.layerId)
      .filter((id): id is string => !!id);
    const orderedLayers = visualOrder
      .map((id) => this.layers.find((layer) => layer.id === id))
      .filter((layer): layer is DrawLayer => !!layer)
      .reverse();
    if (orderedLayers.length === this.layers.length) this.layers = orderedLayers;
    this.selectedLayerId = layerId;
    this.renderLayerList();
    this.renderTimeline();
    this.renderComposite();
    this.commitHistory();
  }

  private renderLayerList(): void {
    this.layerList.innerHTML = '';
    const ordered = [...this.layers].reverse();
    for (const layer of ordered) {
      const row = document.createElement('div');
      row.className = 'draw-layer-row';
      row.classList.toggle('active', layer.id === this.selectedLayerId);
      row.dataset.layerId = layer.id;

      const grip = document.createElement('span');
      grip.className = 'draw-layer-grip';
      grip.dataset.layerGrip = layer.id;
      grip.textContent = '≡';
      grip.title = '拖动调整图层顺序';

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'draw-layer-eye';
      eye.dataset.layerEye = layer.id;
      eye.textContent = layer.visible ? '◉' : '○';
      eye.title = layer.visible ? '隐藏图层' : '显示图层';

      const thumb = document.createElement('canvas');
      thumb.className = 'draw-layer-thumb';
      thumb.dataset.layerId = layer.id;
      thumb.width = 48;
      thumb.height = 30;
      thumb.title = '图层缩略图';
      const thumbCtx = thumb.getContext('2d');
      if (thumbCtx) thumbCtx.drawImage(layer.canvas, 0, 0, 48, 30);

      const name = document.createElement('div');
      name.className = 'draw-layer-name';
      name.title = '双击重命名';
      const strong = document.createElement('strong');
      strong.textContent = layer.name;
      const small = document.createElement('small');
      const frames = this.keyframeCount(layer);
      const blend = BLEND_MODES.find((mode) => mode.value === layer.blendMode);
      const blendText = blend && blend.value !== 'source-over' ? ` · ${blend.label}` : '';
      small.textContent = `${layer.start.toFixed(1)}–${layer.end.toFixed(1)} 秒${frames ? ` · ◆ ${frames}` : ''}${blendText}`;
      name.append(strong, small);

      const duplicate = document.createElement('button');
      duplicate.type = 'button';
      duplicate.className = 'draw-layer-duplicate';
      duplicate.dataset.layerDuplicate = layer.id;
      duplicate.textContent = '⧉';
      duplicate.title = '复制图层';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'draw-layer-remove';
      remove.dataset.layerRemove = layer.id;
      remove.textContent = '×';
      remove.title = '删除图层';

      row.append(grip, eye, thumb, name, duplicate, remove);
      row.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('button, [data-layer-grip]')) return;
        this.selectLayer(layer.id);
      });
      grip.addEventListener('pointerdown', (event) => this.startLayerDrag(event, grip));
      grip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      eye.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleLayerVisibility(layer.id);
      });
      duplicate.addEventListener('click', (event) => {
        event.stopPropagation();
        this.duplicateLayer(layer.id);
      });
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        this.deleteLayer(layer.id);
      });
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        const next = window.prompt('图层名称', layer.name)?.trim();
        if (!next || next === layer.name) return;
        layer.name = next;
        this.renderLayerList();
        this.renderTimeline();
        this.commitHistory();
      });
      this.layerList.append(row);
    }
    this.syncLayerProps();
  }

  private syncLayerProps(): void {
    const layer = this.activeLayer();
    const disabled = !layer;
    this.blendInput.disabled = disabled;
    this.opacityInput.disabled = disabled;
    this.scaleInput.disabled = disabled;
    this.offsetXInput.disabled = disabled;
    this.offsetYInput.disabled = disabled;
    this.element.querySelectorAll<HTMLButtonElement>('[data-draw-keyframe]').forEach((button) => {
      const prop = button.dataset.drawKeyframe as LayerProp;
      const active = !!layer && this.keyframeAt(layer, prop, this.currentTime) >= 0;
      button.disabled = disabled;
      button.classList.toggle('active', active);
      button.title = active
        ? '删除当前时间的关键帧'
        : '在当前时间添加关键帧';
    });
    if (!layer) {
      this.blendInput.value = 'source-over';
      this.opacityInput.value = '100';
      this.opacityValue.textContent = '100%';
      this.scaleInput.value = '100';
      this.scaleValue.textContent = '100%';
      this.offsetXInput.value = '0';
      this.offsetXValue.textContent = '0';
      this.offsetYInput.value = '0';
      this.offsetYValue.textContent = '0';
      return;
    }
    this.blendInput.value = layer.blendMode;
    const state = this.layerStateAt(layer);
    const opacity = Math.round(state.opacity * 100);
    const scale = Math.round(state.scale * 100);
    this.opacityInput.value = String(opacity);
    this.opacityValue.textContent = `${opacity}%`;
    this.scaleInput.value = String(scale);
    this.scaleValue.textContent = `${scale}%`;
    this.offsetXInput.value = String(Math.round(state.offsetX));
    this.offsetXValue.textContent = String(Math.round(state.offsetX));
    this.offsetYInput.value = String(Math.round(state.offsetY));
    this.offsetYValue.textContent = String(Math.round(state.offsetY));
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
      const frameTimes = new Set<number>();
      for (const prop of LAYER_PROPS) {
        for (const keyframe of layer.keyframes[prop]) {
          if (keyframe.time + 0.001 < layer.start || keyframe.time - 0.001 > layer.end) continue;
          frameTimes.add(Math.round(keyframe.time * 100) / 100);
        }
      }
      for (const time of [...frameTimes].sort((a, b) => a - b)) {
        const marker = document.createElement('span');
        marker.className = 'draw-timeline-keyframe';
        marker.style.left = `${((time - layer.start) / Math.max(0.001, layer.end - layer.start)) * 100}%`;
        marker.title = `${time.toFixed(1)} 秒关键帧`;
        clip.append(marker);
      }
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
    this.syncLayerProps();
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
    if (this.playing || this.exporting) return;
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

  private timeAtTimelineX(clientX: number): number {
    const rect = this.timelineTracks.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.max(0, Math.min(this.duration, ratio * this.duration));
  }

  private startTimelineScrub(event: PointerEvent): void {
    if (this.exporting || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.draw-timeline-clip')) return;
    event.preventDefault();
    this.stopPlayback();
    this.timelineScrubbing = true;
    this.timelineBody.classList.add('is-scrubbing');
    try { this.timelineBody.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    this.setCurrentTime(this.timeAtTimelineX(event.clientX));
  }

  private moveTimelineScrub(event: PointerEvent): void {
    if (!this.timelineScrubbing) return;
    event.preventDefault();
    this.setCurrentTime(this.timeAtTimelineX(event.clientX));
  }

  private endTimelineScrub(event: PointerEvent): void {
    if (!this.timelineScrubbing) return;
    this.timelineScrubbing = false;
    this.timelineBody.classList.remove('is-scrubbing');
    try { this.timelineBody.releasePointerCapture(event.pointerId); } catch { /* released */ }
  }

  private beginTimelineDrag(event: PointerEvent): void {
    if (this.exporting) return;
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
    this.commitHistory();
  }

  private syncColorControls(): void {
    this.colorInput.value = this.color;
    this.fgColorInput.value = this.color;
    this.bgColorInput.value = this.backgroundColor;
    this.colorPreview.style.background = this.color;
  }

  private isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) {
      return ['text', 'number', 'search', 'email', 'password', 'url', 'tel'].includes(target.type);
    }
    return false;
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
    this.spacePanUsed = true;
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
      button.addEventListener('click', () => this.setTool(button.dataset.drawTool as DrawTool));
    });

    this.element.querySelectorAll<HTMLElement>('[data-tool-group]').forEach((button) => {
      const group = button.dataset.toolGroup as ToolGroup;
      button.addEventListener('pointerenter', () => {
        window.clearTimeout(this.toolMenuHideTimer);
        window.clearTimeout(this.toolMenuTimer);
        this.toolMenuTimer = window.setTimeout(() => this.showToolMenu(group, button), 450);
      });
      button.addEventListener('pointerleave', () => {
        window.clearTimeout(this.toolMenuTimer);
        this.scheduleToolMenuHide();
      });
      button.addEventListener('click', () => {
        window.clearTimeout(this.toolMenuTimer);
        this.hideToolMenu();
      });
    });
    this.toolMenu.addEventListener('pointerenter', () => window.clearTimeout(this.toolMenuHideTimer));
    this.toolMenu.addEventListener('pointerleave', () => this.scheduleToolMenuHide());
    window.addEventListener('pointerdown', (event) => {
      if (this.toolMenu.classList.contains('hidden')) return;
      const target = event.target as Node;
      const targetElement = event.target instanceof Element ? event.target : null;
      if (this.toolMenu.contains(target) || targetElement?.closest('[data-tool-group]')) return;
      this.hideToolMenu();
    });

    this.element.querySelectorAll<HTMLButtonElement>('[data-draw-panel-toggle]').forEach((button) => {
      const key = button.dataset.drawPanelToggle as string;
      const panel = button.closest<HTMLElement>('.draw-collapsible');
      if (!panel) return;
      const apply = (collapsed: boolean): void => {
        panel.classList.toggle('collapsed', collapsed);
        button.setAttribute('aria-expanded', String(!collapsed));
      };
      try {
        apply(localStorage.getItem(`texturemap.draw.panel.${key}`) === '1');
      } catch {
        apply(false);
      }
      button.addEventListener('click', () => {
        const collapsed = !panel.classList.contains('collapsed');
        apply(collapsed);
        try {
          localStorage.setItem(`texturemap.draw.panel.${key}`, collapsed ? '1' : '0');
        } catch { /* storage unavailable */ }
      });
    });

    this.element.querySelectorAll<HTMLElement>('[data-draw-panel-grip]').forEach((grip) => {
      grip.addEventListener('pointerdown', (event) => this.startPanelDrag(event, grip));
      grip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    window.addEventListener('pointermove', (event) => this.movePanelDrag(event));
    window.addEventListener('pointerup', (event) => this.endPanelDrag(event));
    window.addEventListener('pointercancel', (event) => this.endPanelDrag(event));
    window.addEventListener('pointermove', (event) => this.moveLayerDrag(event));
    window.addEventListener('pointerup', (event) => this.endLayerDrag(event));
    window.addEventListener('pointercancel', (event) => this.endLayerDrag(event));

    const applyColor = (color: string): void => {
      this.color = color;
      this.syncColorControls();
    };
    this.colorInput.addEventListener('input', () => applyColor(this.colorInput.value));
    this.fgColorInput.addEventListener('input', () => applyColor(this.fgColorInput.value));
    this.bgColorInput.addEventListener('input', () => {
      this.backgroundColor = this.bgColorInput.value;
    });
    this.element.querySelector('[data-draw-swap-colors]')?.addEventListener('click', () => {
      const previous = this.color;
      this.color = this.backgroundColor;
      this.backgroundColor = previous;
      this.syncColorControls();
    });
    this.element.querySelectorAll<HTMLElement>('[data-draw-swatch]').forEach((button) => {
      button.addEventListener('click', () => applyColor(button.dataset.drawSwatch ?? '#8fc3a2'));
    });

    this.widthInput.addEventListener('input', () => {
      this.lineWidth = Number(this.widthInput.value) || 8;
      this.widthValue.textContent = String(this.lineWidth);
    });
    this.element.querySelector('[data-draw-fill-layer]')?.addEventListener('click', () => {
      this.fillLayer(this.color, '当前颜色');
    });

    this.blendInput.addEventListener('change', () => {
      const layer = this.activeLayer();
      if (!layer) return;
      layer.blendMode = this.blendInput.value as BlendMode;
      this.renderComposite();
      this.renderLayerList();
      this.commitHistory();
    });
    this.opacityInput.addEventListener('input', () => {
      this.changeLayerProp('opacity', Math.max(0, Math.min(1, (Number(this.opacityInput.value) || 0) / 100)));
    });
    this.scaleInput.addEventListener('input', () => {
      this.changeLayerProp('scale', Math.max(0.1, Math.min(3, (Number(this.scaleInput.value) || 100) / 100)));
    });
    this.offsetXInput.addEventListener('input', () => {
      this.changeLayerProp('offsetX', Number(this.offsetXInput.value) || 0);
    });
    this.offsetYInput.addEventListener('input', () => {
      this.changeLayerProp('offsetY', Number(this.offsetYInput.value) || 0);
    });
    [this.opacityInput, this.scaleInput, this.offsetXInput, this.offsetYInput].forEach((input) => {
      input.addEventListener('change', () => this.commitHistory());
    });
    this.element.querySelectorAll<HTMLButtonElement>('[data-draw-keyframe]').forEach((button) => {
      button.addEventListener('click', () => this.toggleKeyframe(button.dataset.drawKeyframe as LayerProp));
    });
    this.element.querySelector('[data-draw-props-reset]')?.addEventListener('click', () => {
      const layer = this.activeLayer();
      if (!layer) return;
      layer.opacity = 1;
      layer.scale = 1;
      layer.offsetX = 0;
      layer.offsetY = 0;
      layer.keyframes = { opacity: [], scale: [], offsetX: [], offsetY: [] };
      this.renderTimeline();
      this.renderLayerList();
      this.renderComposite();
      this.commitHistory();
      this.callbacks.toast('已重置图层属性并清除关键帧', 'success');
    });

    this.element.querySelector('[data-draw-action="clear"]')?.addEventListener('click', () => this.clear());
    this.element.querySelector('[data-draw-action="open"]')?.addEventListener('click', () => void this.openImage());
    this.element.querySelector('[data-draw-action="save"]')?.addEventListener('click', () => void this.savePng());
    this.element.querySelector('[data-draw-action="project-new"]')?.addEventListener('click', () => this.newProject(true));
    this.element.querySelector('[data-draw-action="project-open"]')?.addEventListener('click', () => void this.openProject());
    this.element.querySelector('[data-draw-action="project-save"]')?.addEventListener('click', () => void this.saveProject());
    this.element.querySelector('[data-draw-start="new"]')?.addEventListener('click', () => this.newProject(false));
    this.element.querySelector('[data-draw-start="open"]')?.addEventListener('click', () => void this.openProject());
    this.element.querySelector('[data-draw-layer-add]')?.addEventListener('click', () => {
      this.addLayer();
      this.callbacks.toast('已新建空白图层', 'success');
    });
    this.element.querySelector('[data-draw-layer-image]')?.addEventListener('click', () => void this.openImage());
    this.playButton.addEventListener('click', () => this.togglePlayback());
    this.exportButton.addEventListener('click', () => void this.exportVideo());
    this.element.querySelector('#draw-export-cancel')?.addEventListener('click', () => {
      if (!this.exporting) return;
      this.exportCancelled = true;
      this.exportStatus.textContent = '正在取消…';
    });
    this.element.querySelectorAll<HTMLElement>('[data-draw-resizer]').forEach((handle) => {
      handle.addEventListener('pointerdown', (event) => {
        this.startLayoutDrag(event, handle.dataset.drawResizer as keyof DrawLayout);
      });
    });
    window.addEventListener('pointermove', (event) => this.moveLayoutDrag(event));
    window.addEventListener('pointerup', (event) => this.endLayoutDrag(event));
    window.addEventListener('pointercancel', (event) => this.endLayoutDrag(event));
    this.element.querySelector('[data-draw-layout-reset]')?.addEventListener('click', () => {
      this.layout = { rail: 54, inspector: 250, timeline: 178, layers: 170 };
      this.applyLayout();
      this.saveLayout();
      this.callbacks.toast('已重置面板布局比例', 'success');
    });
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
      this.commitHistory();
    });
    this.timelineBody.addEventListener('pointerdown', (event) => this.startTimelineScrub(event));
    this.timelineBody.addEventListener('pointermove', (event) => this.moveTimelineScrub(event));
    this.timelineBody.addEventListener('pointerup', (event) => this.endTimelineScrub(event));
    this.timelineBody.addEventListener('pointercancel', (event) => this.endTimelineScrub(event));
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
      if (event.code !== 'Space' || !this.active || !this.projectReady || event.repeat) return;
      const target = event.target as HTMLElement;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      this.spaceHeld = true;
      this.spacePanUsed = false;
      event.preventDefault();
      this.canvasWrap.classList.add('is-pan-ready');
    }, true);
    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space') return;
      const shouldToggle = this.spaceHeld && !this.spacePanUsed && this.active && !this.exporting && !this.isTextEntryTarget(event.target);
      this.spaceHeld = false;
      this.spacePanUsed = false;
      this.canvasWrap.classList.remove('is-pan-ready', 'is-panning');
      if (shouldToggle) {
        event.preventDefault();
        this.togglePlayback();
      }
    }, true);
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
      this.spacePanUsed = false;
      this.viewPanning = false;
      this.canvasWrap.classList.remove('is-pan-ready', 'is-panning');
      if (this.layoutDrag) {
        this.layoutDrag = null;
        this.drawBody.classList.remove('is-resizing-layout');
        this.timelineElement.classList.remove('is-resizing-layout');
        this.saveLayout();
      }
    });

    this.canvas.addEventListener('pointerdown', (event) => this.startStroke(event));
    this.canvas.addEventListener('pointermove', (event) => this.moveStroke(event));
    this.canvas.addEventListener('pointerup', (event) => this.endStroke(event));
    this.canvas.addEventListener('pointercancel', (event) => this.endStroke(event));
    this.canvas.addEventListener('pointerleave', (event) => {
      if ((this.drawing || this.lassoing || this.shapeDraft) && event.buttons === 0) this.endStroke(event);
    });

    window.addEventListener('keydown', (event) => {
      if (!this.active || !this.projectReady || this.exporting) return;
      if (this.isTextEntryTarget(event.target)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        this.setTool('brush');
      } else if (key === 'e') {
        event.preventDefault();
        this.setTool('eraser');
      } else if (key === 'w') {
        event.preventDefault();
        this.cycleToolGroup('selection');
      } else if (key === 'u') {
        event.preventDefault();
        this.cycleToolGroup('shape');
      } else if (key === 'g') {
        event.preventDefault();
        this.cycleToolGroup('fill');
      } else if (event.key === 'Escape') {
        if (this.transformState) this.cancelTransform();
        else this.clearSelection();
      }
    });
    window.addEventListener('keydown', (event) => {
      if (!this.active || !this.projectReady || this.exporting) return;
      if (this.isTextEntryTarget(event.target)) return;
      if (this.transformState && event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.applyTransform();
      }
    });
    window.addEventListener('keydown', (event) => {
      if (!this.active || !this.projectReady || this.exporting) return;
      if (this.isTextEntryTarget(event.target)) return;
      if ((event.altKey || event.ctrlKey) && !event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace' || event.code === 'Delete' || event.code === 'Backspace')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.ctrlKey) this.fillLayer(this.backgroundColor, '背景色');
        else this.fillLayer(this.color, '前景色');
      }
    });
    window.addEventListener('keydown', (event) => {
      if (!this.active || !this.projectReady || !event.ctrlKey || event.altKey) return;
      if (this.isTextEntryTarget(event.target)) return;
      if (this.transformState && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        return;
      }
      if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.enterTransform();
      } else if (event.key === '0') {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.resetViewZoom();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.saveProject();
      } else if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.openProject();
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

  private isShapeTool(tool = this.tool): boolean {
    return SHAPE_TOOLS.includes(tool);
  }

  private clearSelection(): void {
    if (!this.selectionMask && !this.selectionOverlay && !this.lassoing) return;
    this.selectionMask = null;
    this.selectionOverlay = null;
    this.selectionLayerId = '';
    this.lassoPoints = [];
    this.lassoing = false;
    this.renderComposite();
    this.callbacks.status.set(undefined, undefined, '已取消选区');
  }

  private buildSelectionOverlay(mask: HTMLCanvasElement): HTMLCanvasElement {
    const overlay = document.createElement('canvas');
    overlay.width = CANVAS_WIDTH;
    overlay.height = CANVAS_HEIGHT;
    const maskCtx = mask.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const overlayCtx = overlay.getContext('2d') as CanvasRenderingContext2D;
    const source = maskCtx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const result = overlayCtx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
    const data = source.data;
    const output = result.data;
    const selected = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= CANVAS_WIDTH || y >= CANVAS_HEIGHT) return false;
      return data[(y * CANVAS_WIDTH + x) * 4 + 3] > 0;
    };
    for (let y = 0; y < CANVAS_HEIGHT; y += 1) {
      for (let x = 0; x < CANVAS_WIDTH; x += 1) {
        const index = (y * CANVAS_WIDTH + x) * 4;
        if (data[index + 3] === 0) continue;
        const edge = !selected(x - 1, y) || !selected(x + 1, y) || !selected(x, y - 1) || !selected(x, y + 1);
        output[index] = 166;
        output[index + 1] = 208;
        output[index + 2] = 181;
        output[index + 3] = edge ? 235 : 45;
      }
    }
    overlayCtx.putImageData(result, 0, 0);
    return overlay;
  }

  private startLasso(layer: DrawLayer, point: { x: number; y: number }): void {
    this.lassoing = true;
    this.lassoPoints = [point];
    this.selectionMask = null;
    this.selectionLayerId = layer.id;
    this.selectionOverlay = document.createElement('canvas');
    this.selectionOverlay.width = CANVAS_WIDTH;
    this.selectionOverlay.height = CANVAS_HEIGHT;
    const ctx = this.selectionOverlay.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#a6d0b5';
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
    ctx.fill();
    this.renderComposite();
  }

  private moveLasso(point: { x: number; y: number }): void {
    const previous = this.lassoPoints[this.lassoPoints.length - 1];
    if (!previous) return;
    this.lassoPoints.push(point);
    const ctx = this.selectionOverlay?.getContext('2d');
    if (ctx) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(10, 10, 10, 0.75)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      ctx.strokeStyle = '#a6d0b5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    this.renderComposite();
  }

  private finishLasso(): void {
    this.lassoing = false;
    const points = this.lassoPoints;
    this.lassoPoints = [];
    if (points.length < 3) {
      this.clearSelection();
      return;
    }
    const mask = document.createElement('canvas');
    mask.width = CANVAS_WIDTH;
    mask.height = CANVAS_HEIGHT;
    const maskCtx = mask.getContext('2d') as CanvasRenderingContext2D;
    maskCtx.fillStyle = '#ffffff';
    maskCtx.beginPath();
    maskCtx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      maskCtx.lineTo(points[index].x, points[index].y);
    }
    maskCtx.closePath();
    maskCtx.fill();
    this.selectionMask = mask;
    this.selectionOverlay = this.buildSelectionOverlay(mask);
    this.renderComposite();
    this.callbacks.status.set(undefined, undefined, '套索选区');
  }

  private quickSelectAt(layer: DrawLayer, x: number, y: number): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= CANVAS_WIDTH || py >= CANVAS_HEIGHT) return;
    const image = layer.ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const source = image.data;
    const start = (py * CANVAS_WIDTH + px) * 4;
    const target = [source[start], source[start + 1], source[start + 2], source[start + 3]];
    const tolerance = 42;
    const mask = document.createElement('canvas');
    mask.width = CANVAS_WIDTH;
    mask.height = CANVAS_HEIGHT;
    const maskCtx = mask.getContext('2d') as CanvasRenderingContext2D;
    const output = maskCtx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
    const pixels = output.data;
    const total = CANVAS_WIDTH * CANVAS_HEIGHT;
    const visited = new Uint8Array(total);
    const stack: number[] = [py * CANVAS_WIDTH + px];
    visited[py * CANVAS_WIDTH + px] = 1;
    let count = 0;
    while (stack.length) {
      const position = stack.pop() as number;
      const index = position * 4;
      if (
        Math.abs(source[index] - target[0]) > tolerance
        || Math.abs(source[index + 1] - target[1]) > tolerance
        || Math.abs(source[index + 2] - target[2]) > tolerance
        || Math.abs(source[index + 3] - target[3]) > tolerance
      ) continue;
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
      pixels[index + 3] = 255;
      count += 1;
      const column = position % CANVAS_WIDTH;
      const left = position - 1;
      const right = position + 1;
      const up = position - CANVAS_WIDTH;
      const down = position + CANVAS_WIDTH;
      if (column > 0 && !visited[left]) { visited[left] = 1; stack.push(left); }
      if (column < CANVAS_WIDTH - 1 && !visited[right]) { visited[right] = 1; stack.push(right); }
      if (up >= 0 && !visited[up]) { visited[up] = 1; stack.push(up); }
      if (down < total && !visited[down]) { visited[down] = 1; stack.push(down); }
    }
    if (!count) {
      this.callbacks.toast('没有可选择的区域', 'info');
      return;
    }
    maskCtx.putImageData(output, 0, 0);
    this.selectionMask = mask;
    this.selectionOverlay = this.buildSelectionOverlay(mask);
    this.selectionLayerId = layer.id;
    this.renderComposite();
    this.callbacks.status.set(undefined, undefined, `快速选区 · ${count} 像素`);
  }

  private startShape(layer: DrawLayer, point: { x: number; y: number }): void {
    this.shapeDraft = {
      layer,
      snapshot: layer.ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT),
      startX: point.x,
      startY: point.y
    };
    this.drawShapePreview(point.x, point.y);
  }

  private drawShapePreview(x: number, y: number): void {
    const draft = this.shapeDraft;
    if (!draft) return;
    draft.layer.ctx.putImageData(draft.snapshot, 0, 0);
    const left = Math.min(draft.startX, x);
    const top = Math.min(draft.startY, y);
    const width = Math.abs(x - draft.startX);
    const height = Math.abs(y - draft.startY);
    const ctx = draft.layer.ctx;
    if (this.tool === 'gradient') {
      if (Math.hypot(x - draft.startX, y - draft.startY) < 1) {
        this.renderComposite();
        return;
      }
      ctx.save();
      const gradient = ctx.createLinearGradient(draft.startX, draft.startY, x, y);
      gradient.addColorStop(0, this.color);
      gradient.addColorStop(1, this.backgroundColor);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.restore();
      this.renderComposite();
      return;
    }
    if (width < 1 || height < 1) {
      this.renderComposite();
      return;
    }
    ctx.save();
    ctx.fillStyle = this.color;
    ctx.strokeStyle = this.color;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (this.tool === 'round-rect') {
      ctx.roundRect(left, top, width, height, Math.min(32, width * 0.2, height * 0.2));
    } else if (this.tool === 'ellipse') {
      ctx.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    } else if (this.tool === 'polygon') {
      const sides = 6;
      const centerX = left + width / 2;
      const centerY = top + height / 2;
      for (let index = 0; index < sides; index += 1) {
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / sides;
        const px = centerX + Math.cos(angle) * (width / 2);
        const py = centerY + Math.sin(angle) * (height / 2);
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.rect(left, top, width, height);
    }
    ctx.fill();
    ctx.restore();
    this.renderComposite();
  }

  private finishShape(): void {
    if (!this.shapeDraft) return;
    const layer = this.shapeDraft.layer;
    this.shapeDraft = null;
    this.pushLayerHistory(layer);
    this.renderComposite();
    this.callbacks.status.set(undefined, undefined, `${this.toolLabel()} · 已绘制`);
  }

  private pickColor(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(CANVAS_WIDTH - 1, Math.floor((event.clientX - rect.left) * (CANVAS_WIDTH / Math.max(1, rect.width)))));
    const y = Math.max(0, Math.min(CANVAS_HEIGHT - 1, Math.floor((event.clientY - rect.top) * (CANVAS_HEIGHT / Math.max(1, rect.height)))));
    this.hideSelection = true;
    this.renderComposite();
    const data = this.ctx.getImageData(x, y, 1, 1).data;
    this.hideSelection = false;
    this.renderComposite();
    const hex = `#${[data[0], data[1], data[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    this.color = hex;
    this.syncColorControls();
    this.callbacks.status.set(undefined, undefined, `取色 ${hex.toUpperCase()}`);
  }

  private computeContentBounds(layer: DrawLayer): { x: number; y: number; width: number; height: number } | null {
    const data = layer.ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    let minX = CANVAS_WIDTH;
    let minY = CANVAS_HEIGHT;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < CANVAS_HEIGHT; y += 1) {
      for (let x = 0; x < CANVAS_WIDTH; x += 1) {
        if (data[(y * CANVAS_WIDTH + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  private enterTransform(): void {
    if (!this.active || !this.projectReady || this.exporting || this.transformState) return;
    if (this.drawing || this.shapeDraft || this.lassoing) return;
    const layer = this.activeLayer();
    if (!layer) return;
    const bounds = this.computeContentBounds(layer);
    if (!bounds) {
      this.callbacks.toast('当前图层没有可变换的内容', 'info');
      return;
    }
    this.stopPlayback();
    const original = document.createElement('canvas');
    original.width = CANVAS_WIDTH;
    original.height = CANVAS_HEIGHT;
    (original.getContext('2d') as CanvasRenderingContext2D).drawImage(layer.canvas, 0, 0);
    this.transformState = {
      layerId: layer.id,
      original,
      bounds,
      box: { ...bounds },
      drag: null
    };
    this.canvas.style.cursor = 'move';
    this.renderComposite();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '自由变换：拖动移动 · 拖角缩放 · Enter 应用 · Esc 取消');
  }

  private transformBusy(): boolean {
    if (!this.transformState) return false;
    this.callbacks.toast('请先按 Enter 应用自由变换，或按 Esc 取消', 'info');
    return true;
  }

  private cancelTransform(): void {
    if (!this.transformState) return;
    this.transformState = null;
    this.canvas.style.cursor = this.tool === 'eraser' ? 'cell' : this.tool === 'fill' || this.tool === 'gradient' ? 'copy' : 'crosshair';
    this.renderComposite();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '已取消自由变换');
  }

  private applyTransform(): void {
    const transform = this.transformState;
    if (!transform) return;
    const layer = this.layers.find((item) => item.id === transform.layerId);
    if (!layer) {
      this.cancelTransform();
      return;
    }
    const scaleX = transform.box.width / Math.max(1, transform.bounds.width);
    const scaleY = transform.box.height / Math.max(1, transform.bounds.height);
    const destX = transform.box.x - transform.bounds.x * scaleX;
    const destY = transform.box.y - transform.bounds.y * scaleY;
    const temp = document.createElement('canvas');
    temp.width = CANVAS_WIDTH;
    temp.height = CANVAS_HEIGHT;
    const tempCtx = temp.getContext('2d') as CanvasRenderingContext2D;
    tempCtx.drawImage(transform.original, destX, destY, CANVAS_WIDTH * scaleX, CANVAS_HEIGHT * scaleY);
    layer.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    layer.ctx.drawImage(temp, 0, 0);
    this.transformState = null;
    this.canvas.style.cursor = this.tool === 'eraser' ? 'cell' : this.tool === 'fill' || this.tool === 'gradient' ? 'copy' : 'crosshair';
    this.pushLayerHistory(layer);
    this.renderComposite();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '自由变换已应用');
  }

  private transformHandleAt(point: { x: number; y: number }): 'move' | 'nw' | 'ne' | 'sw' | 'se' | null {
    const transform = this.transformState;
    if (!transform) return null;
    const tolerance = 16;
    const { x, y, width, height } = transform.box;
    const corners: Array<{ mode: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }> = [
      { mode: 'nw', x, y },
      { mode: 'ne', x: x + width, y },
      { mode: 'sw', x, y: y + height },
      { mode: 'se', x: x + width, y: y + height }
    ];
    for (const corner of corners) {
      if (Math.abs(point.x - corner.x) <= tolerance && Math.abs(point.y - corner.y) <= tolerance) return corner.mode;
    }
    if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) return 'move';
    return null;
  }

  private startTransformDrag(event: PointerEvent): void {
    if (!this.transformState || event.button !== 0) return;
    const point = this.pointerPosition(event);
    const mode = this.transformHandleAt(point);
    if (!mode) return;
    event.preventDefault();
    this.transformState.drag = {
      mode,
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      box: { ...this.transformState.box }
    };
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
  }

  private moveTransformDrag(event: PointerEvent): void {
    const transform = this.transformState;
    const drag = transform?.drag;
    if (!transform || !drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = this.pointerPosition(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (drag.mode === 'move') {
      transform.box = { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy };
    } else {
      let x1 = drag.box.x;
      let y1 = drag.box.y;
      let x2 = drag.box.x + drag.box.width;
      let y2 = drag.box.y + drag.box.height;
      if (drag.mode === 'nw' || drag.mode === 'sw') x1 += dx;
      else x2 += dx;
      if (drag.mode === 'nw' || drag.mode === 'ne') y1 += dy;
      else y2 += dy;
      const minimum = 12;
      if (x2 - x1 < minimum) {
        if (drag.mode === 'nw' || drag.mode === 'sw') x1 = x2 - minimum;
        else x2 = x1 + minimum;
      }
      if (y2 - y1 < minimum) {
        if (drag.mode === 'nw' || drag.mode === 'ne') y1 = y2 - minimum;
        else y2 = y1 + minimum;
      }
      transform.box = {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
      };
    }
    this.renderComposite();
  }

  private endTransformDrag(event: PointerEvent): void {
    if (!this.transformState?.drag || this.transformState.drag.pointerId !== event.pointerId) return;
    this.transformState.drag = null;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* released */ }
  }

  private renderTransformOverlay(): void {
    const transform = this.transformState;
    if (!transform) return;
    const layer = this.layers.find((item) => item.id === transform.layerId);
    if (!layer) return;
    const state = this.layerStateAt(layer);
    const centerX = CANVAS_WIDTH / 2;
    const centerY = CANVAS_HEIGHT / 2;
    const scale = Math.max(0.05, state.scale);
    this.ctx.save();
    this.ctx.translate(centerX + state.offsetX, centerY + state.offsetY);
    this.ctx.scale(state.scale, state.scale);
    const boxX = transform.box.x - centerX;
    const boxY = transform.box.y - centerY;
    this.ctx.setLineDash([9 / scale, 6 / scale]);
    this.ctx.lineWidth = 4 / scale;
    this.ctx.strokeStyle = 'rgba(8, 8, 8, 0.7)';
    this.ctx.strokeRect(boxX, boxY, transform.box.width, transform.box.height);
    this.ctx.lineWidth = 2 / scale;
    this.ctx.strokeStyle = '#a6d0b5';
    this.ctx.strokeRect(boxX, boxY, transform.box.width, transform.box.height);
    this.ctx.setLineDash([]);
    const handleSize = 11 / scale;
    const corners = [
      [boxX, boxY],
      [boxX + transform.box.width, boxY],
      [boxX, boxY + transform.box.height],
      [boxX + transform.box.width, boxY + transform.box.height]
    ];
    for (const [x, y] of corners) {
      this.ctx.fillStyle = '#a6d0b5';
      this.ctx.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
      this.ctx.lineWidth = 2 / scale;
      this.ctx.strokeStyle = '#0b1a12';
      this.ctx.strokeRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
    }
    this.ctx.restore();
  }

  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const canvasX = (event.clientX - rect.left) * (CANVAS_WIDTH / Math.max(1, rect.width));
    const canvasY = (event.clientY - rect.top) * (CANVAS_HEIGHT / Math.max(1, rect.height));
    const layer = this.activeLayer();
    if (!layer) return { x: canvasX, y: canvasY };
    const state = this.layerStateAt(layer);
    const centerX = CANVAS_WIDTH / 2;
    const centerY = CANVAS_HEIGHT / 2;
    return {
      x: (canvasX - centerX - state.offsetX) / Math.max(0.01, state.scale) + centerX,
      y: (canvasY - centerY - state.offsetY) / Math.max(0.01, state.scale) + centerY
    };
  }

  private startStroke(event: PointerEvent): void {
    if (!this.active || !this.projectReady || this.exporting || event.button !== 0) return;
    if (this.transformState) {
      this.startTransformDrag(event);
      return;
    }
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
    if (event.altKey) {
      this.pickColor(event);
      return;
    }
    const point = this.pointerPosition(event);
    if (this.tool === 'fill') {
      this.fillAt(layer, point.x, point.y);
      return;
    }
    if (this.tool === 'quick-select') {
      this.quickSelectAt(layer, point.x, point.y);
      return;
    }
    if (this.tool === 'lasso') {
      try { this.canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
      this.startLasso(layer, point);
      return;
    }
    if (this.isShapeTool() || this.tool === 'gradient') {
      try { this.canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
      this.startShape(layer, point);
      return;
    }
    const brushWidth = this.lineWidth / Math.max(0.01, this.layerStateAt(layer).scale);
    this.drawing = true;
    this.lastX = point.x;
    this.lastY = point.y;
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
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
    layer.ctx.lineWidth = brushWidth;
    layer.ctx.beginPath();
    layer.ctx.arc(point.x, point.y, brushWidth / 2, 0, Math.PI * 2);
    layer.ctx.fill();
    layer.ctx.restore();
    this.queueComposite();
  }

  private moveStroke(event: PointerEvent): void {
    if (this.transformState?.drag) {
      this.moveTransformDrag(event);
      return;
    }
    if (this.transformState) {
      const hit = this.transformHandleAt(this.pointerPosition(event));
      this.canvas.style.cursor = hit === 'move' ? 'move'
        : hit === 'nw' || hit === 'se' ? 'nwse-resize'
          : hit === 'ne' || hit === 'sw' ? 'nesw-resize'
            : 'default';
      return;
    }
    if (!this.lassoing && !this.shapeDraft && !this.drawing) return;
    const layer = this.activeLayer();
    if (!layer) return;
    event.preventDefault();
    const point = this.pointerPosition(event);
    if (this.lassoing) {
      this.moveLasso(point);
      return;
    }
    if (this.shapeDraft) {
      this.drawShapePreview(point.x, point.y);
      return;
    }
    const brushWidth = this.lineWidth / Math.max(0.01, this.layerStateAt(layer).scale);
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
    layer.ctx.lineWidth = brushWidth;
    layer.ctx.beginPath();
    layer.ctx.moveTo(this.lastX, this.lastY);
    layer.ctx.lineTo(point.x, point.y);
    layer.ctx.stroke();
    layer.ctx.restore();
    this.lastX = point.x;
    this.lastY = point.y;
    this.queueComposite();
  }

  private hexToRgb(hex: string): [number, number, number] {
    const value = hex.replace('#', '').trim();
    if (value.length !== 6) return [143, 195, 162];
    return [
      parseInt(value.slice(0, 2), 16) || 0,
      parseInt(value.slice(2, 4), 16) || 0,
      parseInt(value.slice(4, 6), 16) || 0
    ];
  }

  private fillAt(layer: DrawLayer, x: number, y: number): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= CANVAS_WIDTH || py >= CANVAS_HEIGHT) return;
    const image = layer.ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const data = image.data;
    const startIndex = (py * CANVAS_WIDTH + px) * 4;
    const target = [data[startIndex], data[startIndex + 1], data[startIndex + 2], data[startIndex + 3]];
    const [red, green, blue] = this.hexToRgb(this.color);
    const tolerance = 40;
    const matches = (index: number): boolean => (
      Math.abs(data[index] - target[0]) <= tolerance
      && Math.abs(data[index + 1] - target[1]) <= tolerance
      && Math.abs(data[index + 2] - target[2]) <= tolerance
      && Math.abs(data[index + 3] - target[3]) <= tolerance
    );
    if (target[0] === red && target[1] === green && target[2] === blue && target[3] === 255) {
      this.callbacks.toast('该区域已经是当前颜色', 'info');
      return;
    }
    const selectionData = this.selectionMask && this.selectionLayerId === layer.id
      ? (this.selectionMask.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D)
        .getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data
      : null;
    const total = CANVAS_WIDTH * CANVAS_HEIGHT;
    const visited = new Uint8Array(total);
    const stack: number[] = [py * CANVAS_WIDTH + px];
    visited[py * CANVAS_WIDTH + px] = 1;
    while (stack.length) {
      const position = stack.pop() as number;
      const index = position * 4;
      if (selectionData && selectionData[index + 3] === 0) continue;
      if (!matches(index)) continue;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
      const left = position - 1;
      const right = position + 1;
      const up = position - CANVAS_WIDTH;
      const down = position + CANVAS_WIDTH;
      const column = position % CANVAS_WIDTH;
      if (column > 0 && !visited[left]) { visited[left] = 1; stack.push(left); }
      if (column < CANVAS_WIDTH - 1 && !visited[right]) { visited[right] = 1; stack.push(right); }
      if (up >= 0 && !visited[up]) { visited[up] = 1; stack.push(up); }
      if (down < total && !visited[down]) { visited[down] = 1; stack.push(down); }
    }
    layer.ctx.putImageData(image, 0, 0);
    this.pushLayerHistory(layer);
    this.renderComposite();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '已填充');
  }

  private fillLayer(color: string, label = '前景色'): void {
    if (this.exporting || this.transformBusy()) return;
    const layer = this.activeLayer();
    if (!layer) return;
    if (this.selectionMask && this.selectionLayerId === layer.id) {
      const temp = document.createElement('canvas');
      temp.width = CANVAS_WIDTH;
      temp.height = CANVAS_HEIGHT;
      const tempCtx = temp.getContext('2d') as CanvasRenderingContext2D;
      tempCtx.fillStyle = color;
      tempCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      tempCtx.globalCompositeOperation = 'destination-in';
      tempCtx.drawImage(this.selectionMask, 0, 0);
      layer.ctx.drawImage(temp, 0, 0);
    } else {
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.globalAlpha = 1;
      layer.ctx.fillStyle = color;
      layer.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      layer.ctx.restore();
    }
    this.pushLayerHistory(layer);
    this.renderComposite();
    this.callbacks.toast(`已用${label}填充「${layer.name}」`, 'success');
  }

  private endStroke(event: PointerEvent): void {
    if (this.transformState?.drag) {
      this.endTransformDrag(event);
      return;
    }
    if (this.lassoing) {
      try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      this.finishLasso();
      return;
    }
    if (this.shapeDraft) {
      try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      this.finishShape();
      return;
    }
    if (!this.drawing) return;
    this.drawing = false;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    const layer = this.activeLayer();
    if (layer) {
      this.pushLayerHistory(layer);
    }
    this.renderComposite();
    this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '已绘制');
  }

  private clear(): void {
    if (this.exporting || this.transformBusy()) return;
    const layer = this.activeLayer();
    if (!layer) return;
    if (!window.confirm(`清空「${layer.name}」的内容？`)) return;
    layer.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.pushLayerHistory(layer);
    this.renderComposite();
    this.callbacks.toast('当前图层已清空', 'success');
  }

  private async openImage(): Promise<void> {
    if (this.exporting || this.transformBusy()) return;
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
      const layer = this.addLayer(name, true, false);
      layer.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      layer.ctx.drawImage(image, (CANVAS_WIDTH - width) / 2, (CANVAS_HEIGHT - height) / 2, width, height);
      this.pushLayerHistory(layer);
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

  private pickVideoFormat(): { mime: string; ext: 'mp4' | 'webm' } | null {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates: Array<{ mime: string; ext: 'mp4' | 'webm' }> = [
      { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
      { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
      { mime: 'video/mp4', ext: 'mp4' },
      { mime: 'video/webm;codecs=vp9', ext: 'webm' },
      { mime: 'video/webm;codecs=vp8', ext: 'webm' },
      { mime: 'video/webm', ext: 'webm' }
    ];
    return candidates.find((item) => MediaRecorder.isTypeSupported(item.mime)) ?? null;
  }

  private async exportVideo(): Promise<void> {
    if (this.exporting) return;
    if (this.transformBusy()) return;
    const format = this.pickVideoFormat();
    if (!format) {
      this.callbacks.toast('当前环境不支持视频录制，请更新显卡驱动或系统', 'error');
      return;
    }
    this.stopPlayback();
    const previousTime = this.currentTime;
    this.exporting = true;
    this.exportCancelled = false;
    this.hideSelection = true;
    this.element.classList.add('is-exporting');
    this.exportButton.disabled = true;
    this.exportOverlay.classList.remove('hidden');
    this.exportProgress.style.width = '0%';
    this.exportStatus.textContent = `准备录制 ${format.ext.toUpperCase()}…`;
    this.setCurrentTime(0);

    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    try {
      const canvasStream = this.canvas.captureStream(30);
      stream = canvasStream;
      const chunks: Blob[] = [];
      const options: MediaRecorderOptions = {
        mimeType: format.mime,
        videoBitsPerSecond: 20_000_000
      };
      recorder = new MediaRecorder(canvasStream, options);
      const recorded = new Promise<Blob>((resolve, reject) => {
        recorder!.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        recorder!.onerror = () => reject(new Error('录制器发生错误'));
        recorder!.onstop = () => resolve(new Blob(chunks, { type: format.mime }));
      });
      recorder.start(250);

      const startedAt = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          if (this.exportCancelled) { resolve(); return; }
          const elapsed = (performance.now() - startedAt) / 1000;
          const time = Math.min(this.duration, elapsed);
          this.setCurrentTime(time);
          const percent = Math.min(100, (time / Math.max(0.001, this.duration)) * 100);
          this.exportProgress.style.width = `${percent.toFixed(1)}%`;
          this.exportStatus.textContent = `${format.ext.toUpperCase()} · ${percent.toFixed(0)}% · ${this.formatTimelineTime(time)} / ${this.formatTimelineTime(this.duration)}`;
          if (elapsed >= this.duration) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      if (this.exportCancelled) {
        try { recorder.stop(); } catch { /* already stopped */ }
        try { await recorded; } catch { /* discard */ }
        throw new Error('cancelled');
      }

      this.exportStatus.textContent = '正在封装视频…';
      this.exportProgress.style.width = '100%';
      recorder.stop();
      const blob = await recorded;
      canvasStream.getTracks().forEach((track) => track.stop());
      stream = null;
      if (this.exportCancelled) throw new Error('cancelled');
      if (!blob.size) throw new Error('录制结果为空');
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      this.exportStatus.textContent = '请选择保存位置…';
      const saved = await window.nyxel.file.saveVideo(buffer, `texture_map_${timestamp}.${format.ext}`, format.ext);
      if (saved) this.callbacks.toast(`视频已导出（${format.ext.toUpperCase()}）：${saved}`, 'success');
    } catch (error) {
      if (this.exportCancelled) {
        this.callbacks.toast('已取消视频合成', 'info');
      } else {
        this.callbacks.toast(`视频合成失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    } finally {
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } catch { /* stop best effort */ }
      if (stream) stream.getTracks().forEach((track) => track.stop());
      this.exporting = false;
      this.exportCancelled = false;
      this.element.classList.remove('is-exporting');
      this.exportButton.disabled = false;
      this.exportOverlay.classList.add('hidden');
      this.hideSelection = false;
      this.setCurrentTime(previousTime);
    }
  }

  private async saveProject(): Promise<void> {
    if (this.saving) return;
    if (this.transformBusy()) return;
    this.saving = true;
    const button = this.element.querySelector<HTMLButtonElement>('[data-draw-action="project-save"]');
    if (button) button.disabled = true;
    try {
      const snapshot = this.captureSnapshot();
      const project: DrawProjectFile = {
        version: 1,
        app: 'texture-map',
        savedAt: new Date().toISOString(),
        canvasWidth: CANVAS_WIDTH,
        canvasHeight: CANVAS_HEIGHT,
        currentTime: this.currentTime,
        duration: this.duration,
        selectedLayerId: this.selectedLayerId,
        layers: snapshot.layers
      };
      const bytes = new TextEncoder().encode(JSON.stringify(project));
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const saved = await window.nyxel.file.saveProject(bytes, `texture_map_${timestamp}.tmproj`);
      if (saved) {
        this.projectPath = saved;
        this.recordRecentProject(saved);
        this.callbacks.toast(`工程已保存：${saved}`, 'success');
      }
    } catch (error) {
      this.callbacks.toast(`保存工程失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.saving = false;
      if (button) button.disabled = false;
    }
  }

  private async openProject(filePath?: string): Promise<void> {
    if (this.saving || this.exporting) return;
    try {
      const result = await window.nyxel.file.openProject(filePath);
      if (!result) return;
      const project = JSON.parse(new TextDecoder().decode(new Uint8Array(result.data))) as DrawProjectFile;
      if (project.app !== 'texture-map' || project.version !== 1 || !Array.isArray(project.layers) || !project.layers.length) {
        throw new Error('不是有效的 Texture map 工程文件');
      }
      const snapshot: DrawHistorySnapshot = {
        layers: project.layers.slice(0, 80),
        selectedLayerId: project.selectedLayerId,
        duration: Math.max(1, Math.min(120, Number(project.duration) || 10))
      };
      await this.restoreSnapshot(snapshot);
      this.duration = snapshot.duration;
      this.timelineDuration.value = String(snapshot.duration);
      this.currentTime = Math.max(0, Math.min(snapshot.duration, Number(project.currentTime) || 0));
      this.projectPath = result.path;
      this.resetHistory();
      this.renderTimeline();
      this.renderComposite();
      this.updateTimeUI();
      this.projectReady = true;
      this.startScreen.classList.add('hidden');
      this.recordRecentProject(result.path);
      this.callbacks.status.set('绘画', `${CANVAS_WIDTH} × ${CANVAS_HEIGHT}`, '工程已打开');
      this.callbacks.toast(`工程已打开：${result.path}`, 'success');
    } catch (error) {
      this.callbacks.toast(`打开工程失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async savePng(): Promise<void> {
    if (this.saving) return;
    if (this.transformBusy()) return;
    this.saving = true;
    const button = this.element.querySelector<HTMLButtonElement>('[data-draw-action="save"]');
    if (button) button.disabled = true;
    try {
      this.hideSelection = true;
      this.renderComposite();
      const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, 'image/png'));
      this.hideSelection = false;
      this.renderComposite();
      if (!blob) throw new Error('无法生成 PNG');
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const saved = await window.nyxel.file.savePng(buffer, `texture_map_${timestamp}.png`);
      if (saved) this.callbacks.toast(`已保存：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.hideSelection = false;
      this.renderComposite();
      this.saving = false;
      if (button) button.disabled = false;
    }
  }
}

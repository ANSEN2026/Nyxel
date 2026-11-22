import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { ViewCallbacks } from '../types';
import { basename } from '../utils';

type UpAxis = 'y' | 'z';
type UvBackground = 'checker' | 'solid' | 'texture';
type ViewMode = '3d' | 'uv';
type ModelTransformMode = 'translate' | 'rotate' | 'scale';

const UV_ATTRIBUTES = ['uv', 'uv1', 'uv2', 'uv3'] as const;
const UV_LABELS: Record<string, string> = { uv: 'UV1', uv1: 'UV2', uv2: 'UV3', uv3: 'UV4' };
const UV_LINE_COLOR = 0xe8f0ec;
const UV_OUT_OF_BOUNDS = 0xff5d5d;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface UvTriangle {
  mesh: THREE.Mesh;
  faceIndex: number;
  materialIndex: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  u2: number;
  v2: number;
  oob: boolean;
}

type MaterialChannel = 'rgba' | 'r' | 'g' | 'b' | 'a' | 'l';

type MaterialAlphaChannel = 'r' | 'g' | 'b' | 'a';

interface MaterialSettings {
  channel: MaterialChannel;
  alphaChannel: MaterialAlphaChannel;
  offsetU: number;
  offsetV: number;
  scaleU: number;
  scaleV: number;
  emissive: string;
  emissiveIntensity: number;
  bloomStrength: number;
  brightness: number;
  contrast: number;
  doubleSided: boolean;
  ueBackground: boolean;
}

const MATERIAL_CHANNEL_INDEX: Record<MaterialChannel, number> = {
  rgba: 0,
  r: 1,
  g: 2,
  b: 3,
  a: 4,
  l: 5
};

const MATERIAL_ALPHA_CHANNEL_INDEX: Record<MaterialAlphaChannel, number> = {
  r: 1,
  g: 2,
  b: 3,
  a: 4
};

const MATERIAL_SETTINGS_KEY = 'texturemap.model.material.settings';
const MATERIAL_PRESET_KEY = 'texturemap.model.material.preset';

const MATERIAL_PRESETS: Record<string, MaterialSettings> = {
  default: {
    channel: 'rgba',
    alphaChannel: 'r',
    offsetU: 0,
    offsetV: 0,
    scaleU: 1,
    scaleV: 1,
    emissive: '#8fc3a2',
    emissiveIntensity: 0,
    bloomStrength: 0.18,
    brightness: 1,
    contrast: 1,
    doubleSided: false,
    ueBackground: false
  }
};

interface UvOverlapResponse {
  requestId: number;
  gridSize: number;
  covered: number;
  overlap: number;
  data: Uint8Array;
}

interface ModelEntry {
  id: number;
  name: string;
  filePath: string;
  size: number;
  upAxis: UpAxis;
  root: THREE.Group;
  object: THREE.Object3D;
}

export class ModelView {
  readonly element: HTMLElement;

  private canvas: HTMLCanvasElement;
  private body: HTMLElement;
  private emptyState: HTMLElement;
  private statsBadge: HTMLElement;
  private warningBadge: HTMLElement;
  private fileLabel: HTMLElement;
  private axisDialog: HTMLElement;
  private lightPanel: HTMLElement;
  private materialPanel: HTMLElement;
  private materialBallCanvas: HTMLCanvasElement;
  private materialPresetSelect: HTMLSelectElement;
  private materialOffsetU: HTMLInputElement;
  private materialOffsetUValue: HTMLInputElement;
  private materialOffsetV: HTMLInputElement;
  private materialOffsetVValue: HTMLInputElement;
  private materialScaleU: HTMLInputElement;
  private materialScaleUValue: HTMLInputElement;
  private materialScaleV: HTMLInputElement;
  private materialScaleVValue: HTMLInputElement;
  private materialEmissive: HTMLInputElement;
  private materialEmissiveIntensity: HTMLInputElement;
  private materialEmissiveIntensityValue: HTMLInputElement;
  private materialBloom: HTMLInputElement;
  private materialBloomValue: HTMLInputElement;
  private materialBrightness: HTMLInputElement;
  private materialBrightnessValue: HTMLInputElement;
  private materialContrast: HTMLInputElement;
  private materialContrastValue: HTMLInputElement;
  private materialDoubleSided: HTMLInputElement;
  private materialBackgroundToggle: HTMLInputElement;
  private modelList: HTMLElement;
  private modelPosX: HTMLInputElement;
  private modelPosY: HTMLInputElement;
  private modelPosZ: HTMLInputElement;
  private modelRotX: HTMLInputElement;
  private modelRotY: HTMLInputElement;
  private modelRotZ: HTMLInputElement;
  private modelScaleX: HTMLInputElement;
  private modelScaleY: HTMLInputElement;
  private modelScaleZ: HTMLInputElement;
  private modelGridSnap: HTMLInputElement;
  private officialModelSelect: HTMLSelectElement;
  private referenceMode: HTMLSelectElement;
  private referenceInner: HTMLInputElement;
  private referenceInnerValue: HTMLInputElement;
  private referenceOuter: HTMLInputElement;
  private referenceOuterValue: HTMLInputElement;
  private referenceWaveSize: HTMLInputElement;
  private referenceWaveSizeValue: HTMLInputElement;
  private referenceWaveSpacing: HTMLInputElement;
  private referenceWaveSpacingValue: HTMLInputElement;
  private referenceRingCount: HTMLInputElement;
  private referenceRingCountValue: HTMLInputElement;
  private referenceGroup: THREE.Group | null = null;
  private studioBackgroundTexture: THREE.CanvasTexture | null = null;
  private materialSettings: MaterialSettings = { ...MATERIAL_PRESETS.default };
  private materialPresetKey = 'default';
  private materialBallRenderer: THREE.WebGLRenderer | null = null;
  private materialBallScene: THREE.Scene | null = null;
  private materialBallCamera: THREE.PerspectiveCamera | null = null;
  private materialBallMesh: THREE.Mesh | null = null;
  private materialBallMaterial: THREE.MeshStandardMaterial | null = null;
  private materialBallTexture: THREE.Texture | null = null;
  private materialBallSource: THREE.Texture | null = null;
  private materialBallComposer: EffectComposer | null = null;
  private materialBallBloom: UnrealBloomPass | null = null;
  private generatedMaterialTextures: THREE.Texture[] = [];

  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private transformControls: TransformControls;
  private transformMode: ModelTransformMode = 'translate';
  private gizmoTarget: THREE.Object3D | null = null;
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private grid: THREE.GridHelper;
  private refCube: THREE.Group;

  private model: THREE.Object3D | null = null;
  private modelEntries: ModelEntry[] = [];
  private activeModelId = -1;
  private modelEntrySeq = 0;
  private originalMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private generatedMaterials: THREE.Material[] = [];
  private externalTexture: THREE.Texture | null = null;
  private upAxis: UpAxis = 'y';
  private lightingEnabled = true;
  private wrapRepeat = false;
  private fileName = '';
  private filePath = '';
  private fileSize = 0;
  private active = false;
  private raf = 0;
  private resizeObserver: ResizeObserver;

  private mode: ViewMode = '3d';
  private uvScene = new THREE.Scene();
  private uvCamera: THREE.OrthographicCamera;
  private uvBgPlane: THREE.Mesh;
  private uvBgMaterials: {
    checker: THREE.MeshBasicMaterial;
    solid: THREE.MeshBasicMaterial;
    texture: THREE.MeshBasicMaterial;
  };
  private uvLineGroup = new THREE.Group();
  private uvSelectionGroup = new THREE.Group();
  private modelSelectionGroup = new THREE.Group();
  private uvOverlapMesh: THREE.Mesh;
  private uvBgTileMeshes: THREE.Mesh[] = [];
  private uvOverlapTileMeshes: THREE.Mesh[] = [];
  private uvTileGrid: THREE.LineSegments;
  private uvBaseLines: THREE.LineSegments | null = null;
  private uvTileLines: THREE.LineSegments[] = [];
  private uvTiles = false;
  private uvOverlapTexture: THREE.DataTexture | null = null;
  private uvOverlapStats: { covered: number; overlap: number; gridSize: number } | null = null;
  private uvOverlapBusy = false;
  private overlapWorker: Worker | null = null;
  private overlapRequestId = 0;

  private uvZoom = 1;
  private uvCenter = new THREE.Vector2(0, 0);
  private uvPanning = false;
  private uvZooming = false;
  private uvNavLastX = 0;
  private uvNavLastY = 0;
  private marqueeActive = false;
  private marqueeMode: ViewMode | null = null;
  private marqueeStartX = 0;
  private marqueeStartY = 0;
  private marqueeCurrentX = 0;
  private marqueeCurrentY = 0;
  private marqueeAdditive = false;
  private marqueeSubtractive = false;
  private marquee: HTMLElement;
  private altHeld = false;
  private pointerDownX = -1;
  private pointerDownY = -1;
  private pointerMoved = false;

  private uvChannel = 'uv';
  private uvChannels: string[] = [];
  private uvChannelSelect: HTMLSelectElement;
  private uvBgSelect: HTMLSelectElement;
  private uvHud: HTMLElement;
  private uvHudInfo: HTMLElement;
  private uvHudDetail: HTMLElement;
  private uvHudOverlap: HTMLElement;
  private uvRulers: HTMLElement;
  private uvRulerTop: HTMLElement;
  private uvRulerLeft: HTMLElement;
  private uvTileLabels: HTMLElement;
  private uvRulersToggle: HTMLInputElement;
  private uvRulersVisible = true;
  private uvBgMode: UvBackground = 'checker';
  private uvTriangles: UvTriangle[] = [];
  private uvOobCount = 0;
  private uvMeshCount = 0;
  private uvDataBuilt = false;
  private selectedUv: UvTriangle | null = null;
  private selectedUvTriangles: UvTriangle[] = [];
  private raycaster = new THREE.Raycaster();

  private callbacks: ViewCallbacks;

  constructor(callbacks: ViewCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view model-view';
    this.element.innerHTML = `
      <div class="view-toolbar">
        <div class="segmented" data-group="mode">
          <button data-mode="3d" class="active">3D</button>
          <button data-mode="uv">UV</button>
        </div>
        <button class="primary" data-action="open">打开 FBX</button>
        <button data-action="clear-models">清空模型</button>
        <button data-action="fit" id="model-fit">Fit View</button>
        <span class="toolbar-sep"></span>
        <div class="segmented" data-group="up" data-3d-only>
          <button data-up="y" class="active">Y-up</button>
          <button data-up="z">Z-up</button>
        </div>
        <label class="muted" data-3d-only><input type="checkbox" id="ref-cube"> 参考方块</label>
        <label class="muted" data-3d-only><input type="checkbox" id="lighting" checked> 光照</label>
        <button data-action="light-panel" data-3d-only>光照角度</button>
        <button data-action="texture" data-3d-only>外部贴图</button>
        <label class="muted" data-3d-only><input type="checkbox" id="wrap"> Wrap</label>
        <span class="spacer"></span>
        <span class="uv-controls" data-uv-only>
          <select id="uv-channel" title="UV 通道"></select>
          <select id="uv-bg" title="UV 背景">
            <option value="checker">棋盘格</option>
            <option value="solid">纯色</option>
            <option value="texture">当前贴图</option>
          </select>
          <label class="uv-toggle" title="显示 / 隐藏 UV 标尺">
            <input type="checkbox" id="uv-rulers-toggle" checked>
            <span>标尺</span>
          </label>
          <button data-action="uv-tiles" id="uv-tiles">2×2</button>
          <button data-action="uv-overlap">重叠检测</button>
        </span>
        <span class="muted" id="model-file-label">未加载</span>
      </div>
      <div class="view-body model-body">
        <canvas class="view-canvas" title="左键点击模型选择 · W/E/R 移动/旋转/缩放 · Alt+左键旋转 · Alt+中键平移 · Alt+右键缩放"></canvas>
        <aside class="model-scene-panel" data-3d-only>
          <div class="model-scene-panel-head">
            <div class="model-panel-title">
              <strong>模型</strong>
              <span>SCENE</span>
            </div>
          </div>
          <div class="model-transform-mode" role="group" aria-label="变换工具">
            <button type="button" data-model-transform="translate" class="active" title="W：移动">W<span>移动</span></button>
            <button type="button" data-model-transform="rotate" title="E：旋转">E<span>旋转</span></button>
            <button type="button" data-model-transform="scale" title="R：缩放">R<span>缩放</span></button>
          </div>
          <div class="material-panel-body model-scene-panel-body">
            <section class="material-group model-scene-group">
              <div class="material-group-title">场景模型</div>
              <div class="model-list" id="model-list"></div>
              <div class="model-transform-row">
                <span>位置</span>
                <input id="model-pos-x" type="number" step="0.1" value="0" title="X">
                <input id="model-pos-y" type="number" step="0.1" value="0" title="Y">
                <input id="model-pos-z" type="number" step="0.1" value="0" title="Z">
              </div>
              <div class="model-transform-row">
                <span>旋转</span>
                <input id="model-rot-x" type="number" step="1" value="0" title="X°">
                <input id="model-rot-y" type="number" step="1" value="0" title="Y°">
                <input id="model-rot-z" type="number" step="1" value="0" title="Z°">
              </div>
              <div class="model-transform-row">
                <span>缩放</span>
                <input id="model-scale-x" type="number" step="0.01" value="1" title="X">
                <input id="model-scale-y" type="number" step="0.01" value="1" title="Y">
                <input id="model-scale-z" type="number" step="0.01" value="1" title="Z">
              </div>
              <div class="model-transform-actions">
                <label><input id="model-grid-snap" type="checkbox"> 网格吸附</label>
                <button type="button" data-model-pivot>轴心居中</button>
                <button type="button" data-model-remove>移除</button>
              </div>
              <div class="model-scene-actions">
                <button type="button" data-model-save>保存组合</button>
                <button type="button" data-model-load>载入组合</button>
              </div>
            </section>
            <section class="material-group reference-group">
              <div class="material-group-title">官方参考模型</div>
              <label class="material-control-row">
                <span>模型</span>
                <select id="official-model-select"><option value="">载入中…</option></select>
                <button type="button" data-official-load>载入</button>
              </label>
              <label class="material-control-row">
                <span>模式</span>
                <select id="reference-mode">
                  <option value="ring" selected>圆盘通道</option>
                  <option value="wave">波浪</option>
                </select>
              </label>
              <label class="material-control-row">
                <span>内环</span>
                <input id="reference-inner" type="range" min="0" max="1.4" step="0.01" value="0.55">
                <input id="reference-inner-value" class="material-number" type="number" min="0" max="1.4" step="0.01" value="0.55">
              </label>
              <label class="material-control-row">
                <span>外环</span>
                <input id="reference-outer" type="range" min="0.1" max="2" step="0.01" value="1">
                <input id="reference-outer-value" class="material-number" type="number" min="0.1" max="2" step="0.01" value="1">
              </label>
              <label class="material-control-row">
                <span>波浪大小</span>
                <input id="reference-wave-size" type="range" min="0" max="0.6" step="0.005" value="0.12">
                <input id="reference-wave-size-value" class="material-number" type="number" min="0" max="0.6" step="0.005" value="0.12">
              </label>
              <label class="material-control-row">
                <span>波浪间隔</span>
                <input id="reference-wave-spacing" type="range" min="0.03" max="0.8" step="0.01" value="0.16">
                <input id="reference-wave-spacing-value" class="material-number" type="number" min="0.03" max="0.8" step="0.01" value="0.16">
              </label>
              <label class="material-control-row">
                <span>圈数</span>
                <input id="reference-ring-count" type="range" min="1" max="24" step="1" value="6">
                <input id="reference-ring-count-value" class="material-number" type="number" min="1" max="24" step="1" value="6">
              </label>
              <div class="model-scene-actions">
                <button type="button" data-reference-generate>生成</button>
                <button type="button" data-reference-export>导出 OBJ</button>
              </div>
            </section>
            <div class="model-shortcut-hint">左键点击模型选择 · W 移动 / E 旋转 / R 缩放 · 拖动坐标轴调整</div>
          </div>
        </aside>
        <aside class="material-panel">
          <div class="material-panel-head">
            <div class="material-panel-title">
              <strong>材质预设</strong>
              <span>Material Preview</span>
            </div>
            <button type="button" data-material-reset title="重置材质">重置</button>
          </div>
          <div class="material-ball-wrap">
            <canvas id="material-ball"></canvas>
            <span class="material-ball-label">MATERIAL BALL</span>
          </div>
          <div class="material-panel-body">
            <label class="material-control-row">
              <span>预设</span>
              <select id="material-preset">
                <option value="default">默认材质</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            <section class="material-group">
              <div class="material-group-title">通道</div>
              <div class="segmented material-channel-group">
                <button type="button" data-material-channel="rgba" class="active">RGBA</button>
                <button type="button" data-material-channel="r">R</button>
                <button type="button" data-material-channel="g">G</button>
                <button type="button" data-material-channel="b">B</button>
                <button type="button" data-material-channel="a">A</button>
                <button type="button" data-material-channel="l">L</button>
              </div>
              <div class="material-group-title material-subtitle">透明通道</div>
              <div class="segmented material-alpha-group">
                <button type="button" data-material-alpha="r" class="active">R</button>
                <button type="button" data-material-alpha="g">G</button>
                <button type="button" data-material-alpha="b">B</button>
                <button type="button" data-material-alpha="a">A</button>
              </div>
            </section>
            <section class="material-group">
              <div class="material-group-title">UV 变换</div>
              <label class="material-control-row">
                <span>U 偏移</span>
                <input id="material-offset-u" type="range" min="-10" max="10" step="0.01" value="0">
                <input id="material-offset-u-value" class="material-number" type="number" min="-10" max="10" step="0.01" value="0">
              </label>
              <label class="material-control-row">
                <span>V 偏移</span>
                <input id="material-offset-v" type="range" min="-10" max="10" step="0.01" value="0">
                <input id="material-offset-v-value" class="material-number" type="number" min="-10" max="10" step="0.01" value="0">
              </label>
              <label class="material-control-row">
                <span>U 大小</span>
                <input id="material-scale-u" type="range" min="0.01" max="16" step="0.01" value="1">
                <input id="material-scale-u-value" class="material-number" type="number" min="0.01" max="16" step="0.01" value="1">
              </label>
              <label class="material-control-row">
                <span>V 大小</span>
                <input id="material-scale-v" type="range" min="0.01" max="16" step="0.01" value="1">
                <input id="material-scale-v-value" class="material-number" type="number" min="0.01" max="16" step="0.01" value="1">
              </label>
            </section>
            <section class="material-group">
              <div class="material-group-title">自发光</div>
              <div class="material-control-row material-emissive-row">
                <span>颜色</span>
                <input id="material-emissive" type="color" value="#8fc3a2">
                <input id="material-emissive-intensity" type="range" min="0" max="20" step="0.05" value="0">
                <input id="material-emissive-intensity-value" class="material-number" type="number" min="0" max="20" step="0.05" value="0">
              </div>
              <label class="material-control-row">
                <span>泛光</span>
                <input id="material-bloom" type="range" min="0" max="3" step="0.01" value="0.18">
                <input id="material-bloom-value" class="material-number" type="number" min="0" max="3" step="0.01" value="0.18">
              </label>
            </section>
            <section class="material-group">
              <div class="material-group-title">亮度 / 对比度</div>
              <label class="material-control-row">
                <span>亮度</span>
                <input id="material-brightness" type="range" min="-8" max="8" step="0.01" value="1">
                <input id="material-brightness-value" class="material-number" type="number" min="-8" max="8" step="0.01" value="1">
              </label>
              <label class="material-control-row">
                <span>对比度</span>
                <input id="material-contrast" type="range" min="-8" max="8" step="0.01" value="1">
                <input id="material-contrast-value" class="material-number" type="number" min="-8" max="8" step="0.01" value="1">
              </label>
            </section>
            <section class="material-group">
              <div class="material-group-title">显示</div>
              <label class="material-control-row">
                <span>双面显示</span>
                <input id="material-double-sided" class="toggle" type="checkbox">
              </label>
              <label class="material-control-row">
                <span>UE 材质背景</span>
                <input id="material-ue-bg" class="toggle" type="checkbox">
              </label>
            </section>
            <div class="material-hint">仅影响模型预览材质，不改动原始贴图。</div>
          </div>
        </aside>
        <div class="model-marquee hidden" id="model-marquee"></div>
        <div class="view-empty"><strong>打开或拖入 FBX 文件</strong><span>支持 .fbx · 可切换 Y-up / Z-up</span></div>
        <div class="model-stats hidden"></div>
        <div class="model-warning hidden"></div>
        <div class="uv-hud hidden">
          <div class="uv-hud-title">UV 检视</div>
          <div class="uv-hud-info" id="uv-hud-info">未加载模型</div>
          <div class="uv-hud-detail" id="uv-hud-detail"></div>
          <div class="uv-hud-overlap" id="uv-hud-overlap"></div>
        </div>
        <div class="uv-rulers hidden">
          <div class="uv-ruler-top" id="uv-ruler-top"><span class="uv-axis-label u">U →</span></div>
          <div class="uv-ruler-left" id="uv-ruler-left"><span class="uv-axis-label v">V ↑</span></div>
          <div class="uv-tile-labels hidden" id="uv-tile-labels">
            <span data-tile="0">Q1</span>
            <span data-tile="1">Q2</span>
            <span data-tile="2">Q3</span>
            <span data-tile="3">Q4</span>
          </div>
        </div>
        <div class="axis-dialog hidden">
          <div class="axis-card">
            <h3>选择模型朝向</h3>
            <p>FBX 的 UpAxis 不总是可靠。选错会让模型躺倒，加载后也可以在工具栏随时切换。</p>
            <div class="axis-actions">
              <button class="primary" data-axis="y">Y-up（默认）</button>
              <button data-axis="z">Z-up</button>
            </div>
          </div>
        </div>
        <div class="light-panel hidden">
          <div class="muted" style="margin-bottom:6px">方向光角度</div>
          <label>方位 <span id="light-az-value">45°</span></label>
          <input id="light-az" type="range" min="0" max="360" value="45">
          <label>高度 <span id="light-el-value">45°</span></label>
          <input id="light-el" type="range" min="0" max="90" value="45">
        </div>
      </div>
    `;

    this.canvas = this.element.querySelector('canvas') as HTMLCanvasElement;
    this.body = this.element.querySelector('.model-body') as HTMLElement;
    this.emptyState = this.element.querySelector('.view-empty') as HTMLElement;
    this.statsBadge = this.element.querySelector('.model-stats') as HTMLElement;
    this.warningBadge = this.element.querySelector('.model-warning') as HTMLElement;
    this.fileLabel = this.element.querySelector('#model-file-label') as HTMLElement;
    this.axisDialog = this.element.querySelector('.axis-dialog') as HTMLElement;
    this.lightPanel = this.element.querySelector('.light-panel') as HTMLElement;
    this.materialPanel = this.element.querySelector('.material-panel') as HTMLElement;
    this.materialBallCanvas = this.element.querySelector('#material-ball') as HTMLCanvasElement;
    this.materialPresetSelect = this.element.querySelector('#material-preset') as HTMLSelectElement;
    this.materialOffsetU = this.element.querySelector('#material-offset-u') as HTMLInputElement;
    this.materialOffsetUValue = this.element.querySelector('#material-offset-u-value') as HTMLInputElement;
    this.materialOffsetV = this.element.querySelector('#material-offset-v') as HTMLInputElement;
    this.materialOffsetVValue = this.element.querySelector('#material-offset-v-value') as HTMLInputElement;
    this.materialScaleU = this.element.querySelector('#material-scale-u') as HTMLInputElement;
    this.materialScaleUValue = this.element.querySelector('#material-scale-u-value') as HTMLInputElement;
    this.materialScaleV = this.element.querySelector('#material-scale-v') as HTMLInputElement;
    this.materialScaleVValue = this.element.querySelector('#material-scale-v-value') as HTMLInputElement;
    this.materialEmissive = this.element.querySelector('#material-emissive') as HTMLInputElement;
    this.materialEmissiveIntensity = this.element.querySelector('#material-emissive-intensity') as HTMLInputElement;
    this.materialEmissiveIntensityValue = this.element.querySelector('#material-emissive-intensity-value') as HTMLInputElement;
    this.materialBloom = this.element.querySelector('#material-bloom') as HTMLInputElement;
    this.materialBloomValue = this.element.querySelector('#material-bloom-value') as HTMLInputElement;
    this.materialBrightness = this.element.querySelector('#material-brightness') as HTMLInputElement;
    this.materialBrightnessValue = this.element.querySelector('#material-brightness-value') as HTMLInputElement;
    this.materialContrast = this.element.querySelector('#material-contrast') as HTMLInputElement;
    this.materialContrastValue = this.element.querySelector('#material-contrast-value') as HTMLInputElement;
    this.materialDoubleSided = this.element.querySelector('#material-double-sided') as HTMLInputElement;
    this.materialBackgroundToggle = this.element.querySelector('#material-ue-bg') as HTMLInputElement;
    this.modelList = this.element.querySelector('#model-list') as HTMLElement;
    this.modelPosX = this.element.querySelector('#model-pos-x') as HTMLInputElement;
    this.modelPosY = this.element.querySelector('#model-pos-y') as HTMLInputElement;
    this.modelPosZ = this.element.querySelector('#model-pos-z') as HTMLInputElement;
    this.modelRotX = this.element.querySelector('#model-rot-x') as HTMLInputElement;
    this.modelRotY = this.element.querySelector('#model-rot-y') as HTMLInputElement;
    this.modelRotZ = this.element.querySelector('#model-rot-z') as HTMLInputElement;
    this.modelScaleX = this.element.querySelector('#model-scale-x') as HTMLInputElement;
    this.modelScaleY = this.element.querySelector('#model-scale-y') as HTMLInputElement;
    this.modelScaleZ = this.element.querySelector('#model-scale-z') as HTMLInputElement;
    this.modelGridSnap = this.element.querySelector('#model-grid-snap') as HTMLInputElement;
    this.officialModelSelect = this.element.querySelector('#official-model-select') as HTMLSelectElement;
    this.referenceMode = this.element.querySelector('#reference-mode') as HTMLSelectElement;
    this.referenceInner = this.element.querySelector('#reference-inner') as HTMLInputElement;
    this.referenceInnerValue = this.element.querySelector('#reference-inner-value') as HTMLInputElement;
    this.referenceOuter = this.element.querySelector('#reference-outer') as HTMLInputElement;
    this.referenceOuterValue = this.element.querySelector('#reference-outer-value') as HTMLInputElement;
    this.referenceWaveSize = this.element.querySelector('#reference-wave-size') as HTMLInputElement;
    this.referenceWaveSizeValue = this.element.querySelector('#reference-wave-size-value') as HTMLInputElement;
    this.referenceWaveSpacing = this.element.querySelector('#reference-wave-spacing') as HTMLInputElement;
    this.referenceWaveSpacingValue = this.element.querySelector('#reference-wave-spacing-value') as HTMLInputElement;
    this.referenceRingCount = this.element.querySelector('#reference-ring-count') as HTMLInputElement;
    this.referenceRingCountValue = this.element.querySelector('#reference-ring-count-value') as HTMLInputElement;
    this.uvChannelSelect = this.element.querySelector('#uv-channel') as HTMLSelectElement;
    this.uvBgSelect = this.element.querySelector('#uv-bg') as HTMLSelectElement;
    this.uvHud = this.element.querySelector('.uv-hud') as HTMLElement;
    this.uvHudInfo = this.element.querySelector('#uv-hud-info') as HTMLElement;
    this.uvHudDetail = this.element.querySelector('#uv-hud-detail') as HTMLElement;
    this.uvHudOverlap = this.element.querySelector('#uv-hud-overlap') as HTMLElement;
    this.uvRulers = this.element.querySelector('.uv-rulers') as HTMLElement;
    this.uvRulerTop = this.element.querySelector('#uv-ruler-top') as HTMLElement;
    this.uvRulerLeft = this.element.querySelector('#uv-ruler-left') as HTMLElement;
    this.uvTileLabels = this.element.querySelector('#uv-tile-labels') as HTMLElement;
    this.uvRulersToggle = this.element.querySelector('#uv-rulers-toggle') as HTMLInputElement;
    this.marquee = this.element.querySelector('#model-marquee') as HTMLElement;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0x080a0e);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.8));

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    this.keyLight.position.set(5, 8, 6);
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0x9db4ff, 1.1);
    this.fillLight.position.set(-6, 3, -5);
    this.scene.add(this.fillLight);

    this.grid = new THREE.GridHelper(10, 20, 0x334155, 0x1e293b);
    this.scene.add(this.grid);

    this.refCube = new THREE.Group();
    const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
    const cubeFaces = new THREE.Mesh(
      cubeGeometry,
      new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.06, depthWrite: false })
    );
    const cubeEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cubeGeometry),
      new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.8 })
    );
    this.refCube.add(cubeFaces, cubeEdges);
    this.refCube.visible = false;
    this.scene.add(this.refCube);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000000);
    this.camera.position.set(3, 2, 4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = 1000000;
    this.controls.target.set(0, 0, 0);
    // Maya viewport: Alt+LMB orbit, Alt+MMB pan, Alt+RMB dolly.
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.DOLLY
    };
    this.controls.enabled = false;

    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.setSize(0.85);
    this.transformControls.setMode(this.transformMode);
    this.scene.add(this.transformControls.getHelper());
    this.transformControls.enabled = false;
    this.transformControls.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean((event as unknown as { value?: boolean }).value);
      this.controls.enabled = !dragging && this.mode === '3d' && this.altHeld;
      if (!dragging) {
        this.syncModelTransformControls();
        this.updateStats();
      }
    });
    this.transformControls.addEventListener('objectChange', () => {
      this.syncModelTransformControls();
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.35, 1);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.uvCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.uvCamera.position.z = 5;
    this.uvScene.background = new THREE.Color(0x0b0d10);

    this.uvBgMaterials = {
      checker: new THREE.MeshBasicMaterial({
        map: this.createCheckerTexture(),
        toneMapped: false,
        depthTest: false
      }),
      solid: new THREE.MeshBasicMaterial({ color: 0x1a1f27, toneMapped: false, depthTest: false }),
      texture: new THREE.MeshBasicMaterial({ map: null, toneMapped: false, depthTest: false })
    };
    this.uvBgPlane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.uvBgMaterials.checker);
    this.uvBgPlane.position.z = -0.5;
    this.uvBgPlane.renderOrder = -20;

    const borderGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1, -1, 0),
      new THREE.Vector3(1, -1, 0),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(-1, 1, 0)
    ]);
    const border = new THREE.LineLoop(
      borderGeometry,
      new THREE.LineBasicMaterial({ color: 0x3b4756, toneMapped: false })
    );
    border.position.z = 0.05;

    this.uvOverlapMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.75,
        depthTest: false,
        toneMapped: false
      })
    );
    this.uvOverlapMesh.position.z = 0.12;
    this.uvOverlapMesh.visible = false;
    this.uvOverlapMesh.renderOrder = 1;

    const tileOffsets: Array<[number, number]> = [[2, 0], [0, 2], [2, 2]];
    for (const [x, y] of tileOffsets) {
      const bgClone = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.uvBgMaterials.checker);
      bgClone.position.set(x, y, -0.5);
      bgClone.renderOrder = -20;
      bgClone.visible = false;
      this.uvBgTileMeshes.push(bgClone);

      const overlapClone = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.uvOverlapMesh.material);
      overlapClone.position.set(x, y, 0.12);
      overlapClone.renderOrder = 1;
      overlapClone.visible = false;
      this.uvOverlapTileMeshes.push(overlapClone);

      this.uvScene.add(bgClone, overlapClone);
    }

    const gridPoints: THREE.Vector3[] = [];
    for (let index = -1; index <= 3; index += 1) {
      gridPoints.push(
        new THREE.Vector3(index, -1, 0.03), new THREE.Vector3(index, 3, 0.03),
        new THREE.Vector3(-1, index, 0.03), new THREE.Vector3(3, index, 0.03)
      );
    }
    this.uvTileGrid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPoints),
      new THREE.LineBasicMaterial({
        color: 0x334155,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
        toneMapped: false
      })
    );
    this.uvTileGrid.renderOrder = 0;
    this.uvTileGrid.visible = false;

    const axisOrigin = new THREE.Vector3(-1, -1, 0.07);
    const uAxis = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      axisOrigin,
      2.6,
      0x60a5fa,
      0.24,
      0.13
    );
    const vAxis = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      axisOrigin,
      2.6,
      0xf87171,
      0.24,
      0.13
    );
    for (const axis of [uAxis, vAxis]) {
      axis.renderOrder = 1;
      const lineMaterial = axis.line.material as THREE.LineBasicMaterial;
      const coneMaterial = axis.cone.material as THREE.MeshBasicMaterial;
      lineMaterial.depthTest = false;
      lineMaterial.transparent = true;
      lineMaterial.opacity = 0.92;
      lineMaterial.toneMapped = false;
      coneMaterial.depthTest = false;
      coneMaterial.transparent = true;
      coneMaterial.opacity = 0.92;
      coneMaterial.toneMapped = false;
    }

    this.uvScene.add(
      this.uvBgPlane,
      border,
      this.uvTileGrid,
      uAxis,
      vAxis,
      this.uvOverlapMesh,
      this.uvLineGroup,
      this.uvSelectionGroup
    );
    this.scene.add(this.modelSelectionGroup);

    this.setupMaterialPanel();
    this.bindEvents();
    this.bindReferenceControls();
    void this.loadOfficialModelList();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.body);
    this.resizeObserver.observe(this.canvas);
    this.resize();
    this.fitUv();
  }

  private bindEvents(): void {
    this.element.querySelector('[data-action="open"]')?.addEventListener('click', () => void this.pickOpen());
    this.element.querySelector('[data-action="clear-models"]')?.addEventListener('click', () => {
      this.disposeModel();
      this.emptyState.classList.remove('hidden');
      this.statsBadge.classList.add('hidden');
      this.fileLabel.textContent = '未加载';
      this.callbacks.status.set('模型', '未加载');
    });
    this.element.querySelector('[data-action="fit"]')?.addEventListener('click', () => this.fitCurrent());
    this.bindModelSceneControls();
    this.element.querySelector('[data-action="texture"]')?.addEventListener('click', () => void this.pickTexture());
    this.element.querySelector('[data-action="light-panel"]')?.addEventListener('click', () => {
      this.lightPanel.classList.toggle('hidden');
    });

    this.element.querySelectorAll('[data-up]').forEach((button) => {
      button.addEventListener('click', () => {
        this.setUpAxis(((button as HTMLElement).dataset.up as UpAxis) ?? 'y');
      });
    });

    const refCubeInput = this.element.querySelector('#ref-cube') as HTMLInputElement;
    refCubeInput.addEventListener('change', () => {
      this.refCube.visible = refCubeInput.checked;
    });

    const lightingInput = this.element.querySelector('#lighting') as HTMLInputElement;
    lightingInput.addEventListener('change', () => {
      this.lightingEnabled = lightingInput.checked;
      this.rebuildMaterials();
    });

    const wrapInput = this.element.querySelector('#wrap') as HTMLInputElement;
    wrapInput.addEventListener('change', () => {
      this.wrapRepeat = wrapInput.checked;
      this.applyWrapMode();
    });

    const azimuth = this.element.querySelector('#light-az') as HTMLInputElement;
    const elevation = this.element.querySelector('#light-el') as HTMLInputElement;
    const azValue = this.element.querySelector('#light-az-value') as HTMLElement;
    const elValue = this.element.querySelector('#light-el-value') as HTMLElement;
    const updateLight = () => {
      azValue.textContent = `${azimuth.value}°`;
      elValue.textContent = `${elevation.value}°`;
      const az = THREE.MathUtils.degToRad(Number(azimuth.value));
      const el = THREE.MathUtils.degToRad(Number(elevation.value));
      const radius = 12;
      this.keyLight.position.set(
        radius * Math.cos(el) * Math.cos(az),
        radius * Math.sin(el),
        radius * Math.cos(el) * Math.sin(az)
      );
    };
    azimuth.addEventListener('input', updateLight);
    elevation.addEventListener('input', updateLight);
    updateLight();

    this.element.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        this.setMode(((button as HTMLElement).dataset.mode as ViewMode) ?? '3d');
      });
    });

    this.uvChannelSelect.addEventListener('change', () => {
      this.uvChannel = this.uvChannelSelect.value || this.uvChannels[0] || 'uv';
      this.buildUvGeometry();
      this.clearSelection();
      this.clearOverlap();
      this.fitUv();
    });
    this.uvBgSelect.addEventListener('change', () => {
      this.uvBgMode = (this.uvBgSelect.value as UvBackground) || 'checker';
      this.updateUvBackground();
    });
    this.uvRulersToggle.addEventListener('change', () => {
      this.uvRulersVisible = this.uvRulersToggle.checked;
      this.uvRulers.classList.toggle('hide-scales', !this.uvRulersVisible);
    });
    this.element.querySelector('[data-action="uv-overlap"]')?.addEventListener('click', () => {
      this.detectOverlap();
    });
    this.element.querySelector('[data-action="uv-tiles"]')?.addEventListener('click', () => {
      this.uvTiles = !this.uvTiles;
      this.element.querySelector('[data-action="uv-tiles"]')?.classList.toggle('active', this.uvTiles);
      this.updateUvTiles();
      if (this.selectedUvTriangles.length) this.rebuildSelectionVisuals();
      this.fitUv();
      this.updateUvBackground();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Alt' || !this.active) return;
      event.preventDefault();
      if (this.altHeld) return;
      this.altHeld = true;
      if (this.mode === '3d') this.controls.enabled = true;
      this.transformControls.enabled = false;
      this.updateNavCursor();
    });
    window.addEventListener('keyup', (event) => {
      if (event.key !== 'Alt') return;
      this.altHeld = false;
      this.controls.enabled = false;
      this.syncTransformGizmo();
      this.updateNavCursor();
    });
    window.addEventListener('blur', () => {
      this.altHeld = false;
      this.controls.enabled = false;
      this.endNavigation();
      this.syncTransformGizmo();
      this.updateNavCursor();
    });

    window.addEventListener('keydown', (event) => {
      if (!this.active || this.mode !== '3d' || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const key = event.key.toLowerCase();
      const mode: ModelTransformMode | null = key === 'w'
        ? 'translate'
        : key === 'e'
          ? 'rotate'
          : key === 'r'
            ? 'scale'
            : null;
      if (!mode) return;
      event.preventDefault();
      this.setTransformMode(mode);
    });

    this.canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    this.canvas.addEventListener('wheel', (event) => {
      if (this.mode === 'uv') {
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        const ndcX = ((event.clientX - rect.left) / width) * 2 - 1;
        const ndcY = -((event.clientY - rect.top) / height) * 2 + 1;
        const aspect = width / height;
        const halfW = (this.uvCamera.right - this.uvCamera.left) / 2;
        const halfH = (this.uvCamera.top - this.uvCamera.bottom) / 2;
        const centerX = (this.uvCamera.left + this.uvCamera.right) / 2;
        const centerY = (this.uvCamera.top + this.uvCamera.bottom) / 2;
        const worldX = centerX + ndcX * halfW;
        const worldY = centerY + ndcY * halfH;
        const nextZoom = Math.min(40, Math.max(0.15, this.uvZoom * Math.exp(-event.deltaY * 0.0015)));
        this.uvZoom = nextZoom;
        this.uvCenter.set(worldX - ndcX * (aspect / nextZoom), worldY - ndcY * (1 / nextZoom));
        this.updateUvCamera();
        return;
      }
      if (this.mode === '3d' && !this.altHeld) {
        event.preventDefault();
        const direction = this.camera.position.clone().sub(this.controls.target);
        const distance = Math.max(1e-6, direction.length());
        const nextDistance = THREE.MathUtils.clamp(
          distance * Math.exp(event.deltaY * 0.001),
          this.controls.minDistance,
          this.controls.maxDistance
        );
        this.camera.position.copy(this.controls.target).add(direction.setLength(nextDistance));
        this.controls.update();
      }
    }, { passive: false });

    this.canvas.addEventListener('pointerdown', (event) => {
      if (this.mode === 'uv') {
        if (event.altKey && event.button === 1) {
          event.preventDefault();
          this.uvPanning = true;
          this.uvNavLastX = event.clientX;
          this.uvNavLastY = event.clientY;
          this.capturePointer(event);
          this.updateNavCursor();
          return;
        }
        if (event.altKey && event.button === 2) {
          event.preventDefault();
          this.uvZooming = true;
          this.uvNavLastX = event.clientX;
          this.uvNavLastY = event.clientY;
          this.capturePointer(event);
          this.updateNavCursor();
          return;
        }
        if (event.button !== 0 || event.altKey) return;
        this.beginMarquee(event, 'uv');
        return;
      }
      if (event.button !== 0 || event.altKey) return;
      if (this.transformControls.axis || this.transformControls.dragging) return;
      this.beginMarquee(event, '3d');
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (this.pointerDownX >= 0) {
        if (Math.abs(event.clientX - this.pointerDownX) > 3 || Math.abs(event.clientY - this.pointerDownY) > 3) {
          this.pointerMoved = true;
        }
      }
      if (this.uvPanning) {
        const rect = this.canvas.getBoundingClientRect();
        const halfW = (this.uvCamera.right - this.uvCamera.left) / 2;
        const halfH = (this.uvCamera.top - this.uvCamera.bottom) / 2;
        const dx = event.clientX - this.uvNavLastX;
        const dy = event.clientY - this.uvNavLastY;
        this.uvCenter.x -= (dx / Math.max(1, rect.width)) * halfW * 2;
        this.uvCenter.y += (dy / Math.max(1, rect.height)) * halfH * 2;
        this.uvNavLastX = event.clientX;
        this.uvNavLastY = event.clientY;
        this.updateUvCamera();
        return;
      }
      if (this.uvZooming) {
        const factor = Math.exp((this.uvNavLastY - event.clientY) * 0.008);
        this.uvZoom = Math.min(40, Math.max(0.15, this.uvZoom * factor));
        this.uvNavLastX = event.clientX;
        this.uvNavLastY = event.clientY;
        this.updateUvCamera();
        return;
      }
      if (!this.marqueeMode) return;
      this.marqueeCurrentX = event.clientX;
      this.marqueeCurrentY = event.clientY;
      if (!this.marqueeActive && this.pointerMoved) {
        this.marqueeActive = true;
        this.marquee.classList.remove('hidden');
      }
      if (this.marqueeActive) this.updateMarqueeBox();
    });

    const endPointer = (event: PointerEvent) => {
      const mode = this.marqueeMode;
      const moved = this.pointerMoved;
      const marqueeActive = this.marqueeActive;
      const additive = this.marqueeAdditive;
      const subtractive = this.marqueeSubtractive;
      const startX = this.marqueeStartX;
      const startY = this.marqueeStartY;
      const currentX = this.marqueeCurrentX;
      const currentY = this.marqueeCurrentY;
      this.marqueeMode = null;
      this.marqueeActive = false;
      this.marquee.classList.add('hidden');
      this.uvPanning = false;
      this.uvZooming = false;
      this.pointerDownX = -1;
      this.pointerDownY = -1;
      try {
        if (this.canvas.hasPointerCapture(event.pointerId)) {
          this.canvas.releasePointerCapture(event.pointerId);
        }
      } catch {
        // ignore synthetic pointer events without capture
      }
      this.updateNavCursor();
      if (!mode) return;
      if (this.transformControls.axis || this.transformControls.dragging) return;
      if (marqueeActive) {
        if (mode === 'uv') this.selectUvInMarquee(startX, startY, currentX, currentY, additive, subtractive);
        else this.select3dInMarquee(startX, startY, currentX, currentY, additive, subtractive);
        return;
      }
      if (moved) return;
      if (mode === 'uv') this.pickUv(event.clientX, event.clientY, additive, subtractive);
      else this.pick3d(event.clientX, event.clientY, additive, subtractive);
    };
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', () => {
      this.endNavigation();
      this.pointerDownX = -1;
      this.pointerDownY = -1;
      this.updateNavCursor();
    });
  }

  private capturePointer(event: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointer events in automation have no active pointer
    }
  }

  private beginMarquee(event: PointerEvent, mode: ViewMode): void {
    event.preventDefault();
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
    this.pointerMoved = false;
    this.marqueeMode = mode;
    this.marqueeAdditive = event.shiftKey;
    this.marqueeSubtractive = event.ctrlKey || event.metaKey;
    this.marqueeActive = false;
    this.marqueeStartX = event.clientX;
    this.marqueeStartY = event.clientY;
    this.marqueeCurrentX = event.clientX;
    this.marqueeCurrentY = event.clientY;
    this.marquee.classList.add('hidden');
    this.capturePointer(event);
    this.canvas.style.cursor = 'crosshair';
  }

  private updateMarqueeBox(): void {
    const rect = this.body.getBoundingClientRect();
    const left = Math.min(this.marqueeStartX, this.marqueeCurrentX) - rect.left;
    const top = Math.min(this.marqueeStartY, this.marqueeCurrentY) - rect.top;
    const width = Math.abs(this.marqueeCurrentX - this.marqueeStartX);
    const height = Math.abs(this.marqueeCurrentY - this.marqueeStartY);
    this.marquee.style.left = `${left}px`;
    this.marquee.style.top = `${top}px`;
    this.marquee.style.width = `${width}px`;
    this.marquee.style.height = `${height}px`;
  }

  private endNavigation(): void {
    this.marqueeMode = null;
    this.marqueeActive = false;
    this.marquee.classList.add('hidden');
    this.uvPanning = false;
    this.uvZooming = false;
    this.pointerDownX = -1;
    this.pointerDownY = -1;
  }

  private updateNavCursor(): void {
    if (!this.active) return;
    if (this.mode === 'uv') {
      this.canvas.style.cursor = this.uvPanning
        ? 'grabbing'
        : this.uvZooming
          ? 'ns-resize'
          : 'default';
      return;
    }
    this.canvas.style.cursor = this.altHeld ? 'grab' : 'default';
  }

  private async pickOpen(): Promise<void> {
    const filePath = await window.nyxel.dialog.openModel();
    if (filePath) await this.loadPath(filePath);
  }

  private async pickTexture(): Promise<void> {
    if (!this.model) {
      this.callbacks.toast('请先加载一个 FBX 模型', 'info');
      return;
    }
    const filePath = await window.nyxel.dialog.openImage();
    if (!filePath) return;
    try {
      const buffer = await window.nyxel.file.read(filePath);
      const blob = new Blob([new Uint8Array(buffer)], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      this.setExternalTexture(bitmap, basename(filePath));
    } catch (error) {
      this.callbacks.toast(`贴图加载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async loadPath(filePath: string): Promise<void> {
    try {
      const buffer = await window.nyxel.file.read(filePath);
      const name = basename(filePath);
      await this.loadBuffer(buffer, name, filePath, buffer.byteLength);
    } catch (error) {
      this.showError(`打开 FBX 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadFile(file: File): Promise<void> {
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      await this.loadBuffer(buffer, file.name, '', file.size);
    } catch (error) {
      this.showError(`打开 FBX 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadBuffer(buffer: Uint8Array, name: string, filePath: string, size: number): Promise<void> {
    const axis = this.upAxis;
    this.fileName = name;
    this.filePath = filePath;
    this.fileSize = size;
    this.fileLabel.textContent = name;
    this.callbacks.status.set(name, '解析中…');
    this.showError('');
    this.warningBadge.classList.add('hidden');
    this.emptyState.classList.add('hidden');

    try {
      const version = this.readFbxVersion(buffer);
      if (version !== null && version < 6400) {
        this.showError(`FBX 版本过低：文件声明版本 ${version}，Texture map v0.1 至少需要 6400。`);
        this.callbacks.status.set(name, '版本过低');
        return;
      }

      const missingTextures: string[] = [];
      const manager = new THREE.LoadingManager();
      manager.onError = (url) => missingTextures.push(url);
      const loader = new FBXLoader(manager);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      const basePath = filePath ? `${filePath.replace(/[\\/][^\\/]*$/, '')}/` : '';
      const object = loader.parse(arrayBuffer, basePath);
      this.setModel(object, name, filePath, axis, missingTextures);
    } catch (error) {
      this.showError(`FBX 解析失败：${error instanceof Error ? error.message : String(error)}`);
      this.callbacks.status.set(name, '解析失败');
    }
  }

  private readFbxVersion(buffer: Uint8Array): number | null {
    if (buffer.byteLength < 27) return null;
    const header = new TextDecoder('ascii').decode(buffer.subarray(0, 23));
    if (!header.startsWith('Kaydara FBX Binary')) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return view.getUint32(23, true);
  }

  private askAxis(defaultAxis: UpAxis): Promise<UpAxis> {
    this.axisDialog.classList.remove('hidden');
    return new Promise((resolve) => {
      const finish = (axis: UpAxis) => {
        this.axisDialog.classList.add('hidden');
        this.axisDialog.querySelectorAll('[data-axis]').forEach((button) => {
          button.removeEventListener('click', handler);
        });
        resolve(axis);
      };
      const handler = (event: Event) => {
        const target = event.currentTarget as HTMLElement;
        finish((target.dataset.axis as UpAxis) ?? defaultAxis);
      };
      this.axisDialog.querySelectorAll('[data-axis]').forEach((button) => {
        button.addEventListener('click', handler);
      });
    });
  }

  private setModel(
    object: THREE.Object3D,
    name: string,
    filePath: string,
    axis: UpAxis,
    missingTextures: string[]
  ): void {
    this.upAxis = axis;
    const root = new THREE.Group();
    root.name = name;
    root.add(object);
    this.scene.add(root);
    const entry: ModelEntry = {
      id: ++this.modelEntrySeq,
      name,
      filePath,
      size: this.fileSize,
      upAxis: axis,
      root,
      object
    };
    object.rotation.x = axis === 'z' ? -Math.PI / 2 : 0;

    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.originalMaterials.set(mesh, mesh.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    this.modelEntries.push(entry);
    this.activeModelId = entry.id;
    this.model = object;
    this.fileName = name;
    this.filePath = filePath;
    this.fileSize = entry.size;
    this.uvDataBuilt = false;
    this.refreshUvChannels();
    this.element.querySelectorAll('[data-up]').forEach((button) => {
      button.classList.toggle('active', (button as HTMLElement).dataset.up === axis);
    });
    this.rebuildMaterials();
    this.fit();
    this.renderModelList();
    this.syncModelTransformControls();
    this.syncTransformGizmo();

    if (this.mode === 'uv') {
      this.clearUvData();
      this.ensureUvData();
      this.fitUv();
      this.updateUvBackground();
      this.updateUvHud();
    }

    this.emptyState.classList.add('hidden');
    this.statsBadge.classList.remove('hidden');
    this.fileLabel.textContent = name;
    this.callbacks.status.set(name, this.statsText());
    if (filePath) this.callbacks.pushRecent('model', filePath, name);

    if (missingTextures.length) {
      this.warningBadge.classList.remove('hidden');
      this.warningBadge.textContent = `有 ${missingTextures.length} 张贴图未能加载（外部贴图路径可能已失效）：${missingTextures.slice(0, 4).join('、')}`;
    } else {
      this.warningBadge.classList.add('hidden');
    }
  }

  private setUpAxis(axis: UpAxis, doFit = true): void {
    this.upAxis = axis;
    for (const entry of this.modelEntries) {
      entry.upAxis = axis;
      entry.object.rotation.x = axis === 'z' ? -Math.PI / 2 : 0;
      entry.object.updateMatrixWorld(true);
    }
    this.clearSelection();
    this.element.querySelectorAll('[data-up]').forEach((button) => {
      button.classList.toggle('active', (button as HTMLElement).dataset.up === axis);
    });
    if (doFit) this.fit();
    this.updateStats();
  }

  private renderModelList(): void {
    this.modelList.innerHTML = '';
    if (!this.modelEntries.length) {
      const empty = document.createElement('div');
      empty.className = 'model-list-empty';
      empty.textContent = '还没有模型';
      this.modelList.append(empty);
      return;
    }
    for (const entry of this.modelEntries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-list-item${entry.id === this.activeModelId ? ' active' : ''}`;
      button.textContent = entry.name;
      button.title = entry.filePath || entry.name;
      button.addEventListener('click', () => this.selectModelEntry(entry.id));
      this.modelList.append(button);
    }
  }

  private activeModelEntry(): ModelEntry | null {
    return this.modelEntries.find((entry) => entry.id === this.activeModelId) ?? null;
  }

  private selectModelEntry(id: number): void {
    const entry = this.modelEntries.find((item) => item.id === id);
    if (!entry) return;
    this.activeModelId = entry.id;
    this.model = entry.object;
    this.fileName = entry.name;
    this.filePath = entry.filePath;
    this.fileSize = entry.size;
    this.uvDataBuilt = false;
    this.clearSelection();
    this.refreshUvChannels();
    this.rebuildMaterials();
    this.renderModelList();
    this.syncModelTransformControls();
    this.syncTransformGizmo();
    this.fileLabel.textContent = entry.name;
    this.callbacks.status.set(entry.name, this.statsText());
    this.updateStats();
    if (this.mode === 'uv') {
      this.clearUvData();
      this.ensureUvData();
      this.fitUv();
      this.updateUvBackground();
      this.updateUvHud();
    }
  }

  private setTransformMode(mode: ModelTransformMode): void {
    this.transformMode = mode;
    this.transformControls.setMode(mode);
    this.element.querySelectorAll<HTMLElement>('[data-model-transform]').forEach((button) => {
      button.classList.toggle('active', button.dataset.modelTransform === mode);
    });
  }

  private syncTransformGizmo(): void {
    const entry = this.activeModelEntry();
    const visible = this.mode === '3d' && Boolean(entry);
    this.transformControls.enabled = visible && !this.altHeld;
    if (visible && entry) {
      if (this.gizmoTarget !== entry.root) {
        this.transformControls.attach(entry.root);
        this.gizmoTarget = entry.root;
      }
    } else if (this.gizmoTarget) {
      this.transformControls.detach();
      this.gizmoTarget = null;
    }
  }

  private updateTransformSnap(): void {
    this.transformControls.setTranslationSnap(this.modelGridSnap.checked ? 0.1 : null);
  }

  private syncModelTransformControls(): void {
    const entry = this.activeModelEntry();
    const disabled = !entry;
    const fields = [
      this.modelPosX,
      this.modelPosY,
      this.modelPosZ,
      this.modelRotX,
      this.modelRotY,
      this.modelRotZ,
      this.modelScaleX,
      this.modelScaleY,
      this.modelScaleZ
    ];
    for (const field of fields) field.disabled = disabled;
    if (!entry) {
      this.modelPosX.value = '0';
      this.modelPosY.value = '0';
      this.modelPosZ.value = '0';
      this.modelRotX.value = '0';
      this.modelRotY.value = '0';
      this.modelRotZ.value = '0';
      this.modelScaleX.value = '1';
      this.modelScaleY.value = '1';
      this.modelScaleZ.value = '1';
      return;
    }
    const root = entry.root;
    this.modelPosX.value = root.position.x.toFixed(2);
    this.modelPosY.value = root.position.y.toFixed(2);
    this.modelPosZ.value = root.position.z.toFixed(2);
    this.modelRotX.value = String(Math.round(THREE.MathUtils.radToDeg(root.rotation.x)));
    this.modelRotY.value = String(Math.round(THREE.MathUtils.radToDeg(root.rotation.y)));
    this.modelRotZ.value = String(Math.round(THREE.MathUtils.radToDeg(root.rotation.z)));
    this.modelScaleX.value = root.scale.x.toFixed(2);
    this.modelScaleY.value = root.scale.y.toFixed(2);
    this.modelScaleZ.value = root.scale.z.toFixed(2);
  }

  private bindModelSceneControls(): void {
    const apply = (): void => {
      const entry = this.activeModelEntry();
      if (!entry) return;
      const snap = this.modelGridSnap.checked ? 0.1 : 0;
      const snapValue = (value: number): number => snap > 0 ? Math.round(value / snap) * snap : value;
      const position = new THREE.Vector3(
        snapValue(Number(this.modelPosX.value) || 0),
        snapValue(Number(this.modelPosY.value) || 0),
        snapValue(Number(this.modelPosZ.value) || 0)
      );
      const rotation = new THREE.Euler(
        THREE.MathUtils.degToRad(Number(this.modelRotX.value) || 0),
        THREE.MathUtils.degToRad(Number(this.modelRotY.value) || 0),
        THREE.MathUtils.degToRad(Number(this.modelRotZ.value) || 0)
      );
      const scale = new THREE.Vector3(
        Math.max(0.001, Number(this.modelScaleX.value) || 1),
        Math.max(0.001, Number(this.modelScaleY.value) || 1),
        Math.max(0.001, Number(this.modelScaleZ.value) || 1)
      );
      entry.root.position.copy(position);
      entry.root.rotation.copy(rotation);
      entry.root.scale.copy(scale);
      entry.root.updateMatrixWorld(true);
      this.syncModelTransformControls();
      this.updateStats();
    };
    for (const field of [
      this.modelPosX,
      this.modelPosY,
      this.modelPosZ,
      this.modelRotX,
      this.modelRotY,
      this.modelRotZ,
      this.modelScaleX,
      this.modelScaleY,
      this.modelScaleZ
    ]) {
      field.addEventListener('change', apply);
    }
    this.element.querySelectorAll<HTMLElement>('[data-model-transform]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.modelTransform as ModelTransformMode | undefined;
        if (mode) this.setTransformMode(mode);
      });
    });
    this.modelGridSnap.addEventListener('change', () => this.updateTransformSnap());
    this.element.querySelector('[data-model-pivot]')?.addEventListener('click', () => this.centerModelPivot());
    this.element.querySelector('[data-model-remove]')?.addEventListener('click', () => this.removeActiveModel());
    this.element.querySelector('[data-model-save]')?.addEventListener('click', () => void this.saveModelScene());
    this.element.querySelector('[data-model-load]')?.addEventListener('click', () => void this.loadModelScene());
    this.updateTransformSnap();
  }

  private async loadOfficialModelList(): Promise<void> {
    try {
      const models = await window.nyxel.models.official();
      this.officialModelSelect.innerHTML = '';
      if (!models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '未找到官方模型';
        this.officialModelSelect.append(option);
        return;
      }
      for (const model of models) {
        const option = document.createElement('option');
        option.value = model.path;
        option.textContent = model.name;
        this.officialModelSelect.append(option);
      }
    } catch {
      this.officialModelSelect.innerHTML = '<option value="">官方模型不可用</option>';
    }
  }

  private bindReferenceControls(): void {
    const syncPair = (range: HTMLInputElement, number: HTMLInputElement, onChange?: () => void): void => {
      range.addEventListener('input', () => {
        number.value = range.value;
        onChange?.();
      });
      number.addEventListener('change', () => {
        const value = Math.max(Number(range.min) || 0, Math.min(Number(range.max) || 1, Number(number.value) || 0));
        range.value = String(value);
        number.value = String(value);
        onChange?.();
      });
    };
    const syncWave = (): void => {
      const outer = Math.max(0.1, Number(this.referenceOuter.value) || 1);
      const spacing = Math.max(0.03, Number(this.referenceWaveSpacing.value) || 0.16);
      const count = Math.max(1, Math.min(24, Math.round(outer / spacing)));
      this.referenceRingCount.value = String(count);
      this.referenceRingCountValue.value = String(count);
    };
    syncPair(this.referenceInner, this.referenceInnerValue);
    syncPair(this.referenceOuter, this.referenceOuterValue, syncWave);
    syncPair(this.referenceWaveSize, this.referenceWaveSizeValue);
    syncPair(this.referenceWaveSpacing, this.referenceWaveSpacingValue, syncWave);
    syncPair(this.referenceRingCount, this.referenceRingCountValue, () => {
      const outer = Math.max(0.1, Number(this.referenceOuter.value) || 1);
      const count = Math.max(1, Number(this.referenceRingCount.value) || 1);
      const spacing = Math.max(0.03, outer / count);
      this.referenceWaveSpacing.value = spacing.toFixed(2);
      this.referenceWaveSpacingValue.value = spacing.toFixed(2);
    });
    this.officialModelSelect.addEventListener('change', () => {
      this.element.querySelector('[data-official-load]')?.classList.remove('active');
    });
    this.element.querySelector('[data-official-load]')?.addEventListener('click', () => {
      const target = this.officialModelSelect.value;
      if (!target) {
        this.callbacks.toast('没有可载入的官方模型', 'info');
        return;
      }
      void this.loadPath(target);
    });
    this.referenceMode.addEventListener('change', () => this.updateReferenceMode());
    this.element.querySelector('[data-reference-generate]')?.addEventListener('click', () => this.generateReferenceModel());
    this.element.querySelector('[data-reference-export]')?.addEventListener('click', () => void this.exportReferenceModel());
    this.updateReferenceMode();
  }

  private updateReferenceMode(): void {
    const wave = this.referenceMode.value === 'wave';
    this.referenceWaveSize.disabled = !wave;
    this.referenceWaveSizeValue.disabled = !wave;
    this.referenceWaveSpacing.disabled = !wave;
    this.referenceWaveSpacingValue.disabled = !wave;
    this.referenceRingCount.disabled = !wave;
    this.referenceRingCountValue.disabled = !wave;
  }

  private clearReferenceModel(): void {
    if (!this.referenceGroup) return;
    this.scene.remove(this.referenceGroup);
    this.referenceGroup.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.referenceGroup = null;
  }

  private referenceGeometry(): THREE.BufferGeometry {
    const inner = Math.max(0, Number(this.referenceInner.value) || 0);
    const outer = Math.max(inner + 0.01, Number(this.referenceOuter.value) || 1);
    if (this.referenceMode.value === 'ring') {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
      if (inner > 0.001) {
        const hole = new THREE.Path();
        hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.08,
        bevelEnabled: true,
        bevelSegments: 2,
        bevelSize: 0.012,
        bevelThickness: 0.012,
        steps: 1,
        curveSegments: 160
      });
      geometry.rotateX(-Math.PI / 2);
      geometry.computeVertexNormals();
      return geometry;
    }

    const cycles = Math.max(1, Math.min(24, Math.round(Number(this.referenceRingCount.value) || 6)));
    const amplitude = Math.max(0, Number(this.referenceWaveSize.value) || 0);
    const segments = 192;
    const radialRings = Math.max(24, cycles * 18);
    const positions: number[] = [];
    const indices: number[] = [];
    const heightAt = (radius: number): number => {
      const phase = (radius / Math.max(0.001, outer)) * cycles * Math.PI * 2;
      return Math.sin(phase) * amplitude;
    };
    const hasHole = inner > 0.001;
    if (!hasHole) positions.push(0, heightAt(0), 0);
    for (let ring = 1; ring <= radialRings; ring += 1) {
      const radius = hasHole
        ? inner + ((outer - inner) * (ring - 1)) / Math.max(1, radialRings - 1)
        : (outer * ring) / radialRings;
      const y = heightAt(radius);
      for (let segment = 0; segment < segments; segment += 1) {
        const angle = (segment / segments) * Math.PI * 2;
        positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      }
    }
    if (!hasHole) {
      for (let segment = 0; segment < segments; segment += 1) {
        indices.push(0, 1 + ((segment + 1) % segments), 1 + segment);
      }
    }
    const base = hasHole ? 0 : 1;
    for (let ring = 1; ring < radialRings; ring += 1) {
      const start = base + (ring - 1) * segments;
      const next = base + ring * segments;
      for (let segment = 0; segment < segments; segment += 1) {
        const a = start + segment;
        const b = start + ((segment + 1) % segments);
        const c = next + segment;
        const d = next + ((segment + 1) % segments);
        indices.push(a, b, c, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private generateReferenceModel(): void {
    this.clearReferenceModel();
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      this.referenceGeometry(),
      new THREE.MeshStandardMaterial({
        color: 0x9fc3d8,
        metalness: 0.22,
        roughness: 0.34,
        side: THREE.DoubleSide
      })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    this.referenceGroup = group;
    this.scene.add(group);
    this.emptyState.classList.add('hidden');
    this.fit();
    this.callbacks.toast(`已生成${this.referenceMode.value === 'wave' ? '波浪' : '圆盘通道'}参考模型`, 'success');
  }

  private async exportReferenceModel(): Promise<void> {
    if (!this.referenceGroup) {
      this.callbacks.toast('请先生成参考模型', 'info');
      return;
    }
    try {
      const text = new OBJExporter().parse(this.referenceGroup);
      const saved = await window.nyxel.file.saveText(text, '参考模型.obj');
      if (saved) this.callbacks.toast(`参考模型已导出：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`导出参考模型失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private centerModelPivot(): void {
    const entry = this.activeModelEntry();
    if (!entry) return;
    entry.root.updateMatrixWorld(true);
    entry.object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(entry.object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const worldMatrix = entry.object.matrixWorld.clone();
    entry.root.position.copy(center);
    entry.root.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(entry.root.matrixWorld).invert();
    const local = new THREE.Matrix4().multiplyMatrices(inverse, worldMatrix);
    local.decompose(entry.object.position, entry.object.quaternion, entry.object.scale);
    entry.object.updateMatrixWorld(true);
    entry.root.updateMatrixWorld(true);
    this.syncModelTransformControls();
    this.updateStats();
    this.callbacks.toast('坐标轴心已定位到模型中心', 'success');
  }

  private removeActiveModel(): void {
    const entry = this.activeModelEntry();
    if (!entry) return;
    if (this.gizmoTarget === entry.root) {
      this.transformControls.detach();
      this.gizmoTarget = null;
    }
    this.scene.remove(entry.root);
    entry.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.modelEntries = this.modelEntries.filter((item) => item.id !== entry.id);
    const next = this.modelEntries[this.modelEntries.length - 1];
    if (next) {
      this.selectModelEntry(next.id);
    } else {
      this.model = null;
      this.activeModelId = -1;
      this.fileName = '';
      this.filePath = '';
      this.fileSize = 0;
      this.emptyState.classList.remove('hidden');
      this.statsBadge.classList.add('hidden');
      this.fileLabel.textContent = '未加载';
      this.renderModelList();
      this.syncModelTransformControls();
      this.syncTransformGizmo();
      this.updateMaterialBall(true);
      this.callbacks.status.set('模型', '未加载');
    }
  }

  private async saveModelScene(): Promise<void> {
    if (!this.modelEntries.length) {
      this.callbacks.toast('场景里还没有模型', 'info');
      return;
    }
    this.callbacks.status.set('模型', '正在打包模型组合…');
    const models: Array<{
      name: string;
      path: string;
      data: string;
      position: number[];
      rotation: number[];
      scale: number[];
    }> = [];
    for (const entry of this.modelEntries) {
      const model = {
        name: entry.name,
        path: entry.filePath,
        data: '',
        position: [entry.root.position.x, entry.root.position.y, entry.root.position.z],
        rotation: [
          THREE.MathUtils.radToDeg(entry.root.rotation.x),
          THREE.MathUtils.radToDeg(entry.root.rotation.y),
          THREE.MathUtils.radToDeg(entry.root.rotation.z)
        ],
        scale: [entry.root.scale.x, entry.root.scale.y, entry.root.scale.z]
      };
      if (entry.filePath) {
        try {
          const bytes = await window.nyxel.file.read(entry.filePath);
          model.data = bytesToBase64(bytes);
        } catch {
          // 模型文件不可读时保留路径引用，至少还能在同一台机器上还原。
        }
      }
      models.push(model);
    }
    const payload = {
      format: 'texturemap-model-scene',
      version: 2,
      upAxis: this.upAxis,
      models
    };
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const saved = await window.nyxel.file.saveProject(bytes, '模型组合.tmproj');
      if (saved) this.callbacks.toast(`模型组合已打包保存：${saved}`, 'success');
    } catch (error) {
      this.callbacks.toast(`保存模型组合失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      this.callbacks.status.set(this.fileName, this.statsText());
    }
  }

  private async loadModelScene(): Promise<void> {
    try {
      const result = await window.nyxel.file.openProject();
      if (!result) return;
      const payload = JSON.parse(new TextDecoder().decode(result.data)) as {
        format?: string;
        upAxis?: UpAxis;
        models?: Array<{
          name?: string;
          path?: string;
          data?: string;
          position?: number[];
          rotation?: number[];
          scale?: number[];
        }>;
      };
      if (payload.format !== 'texturemap-model-scene' || !Array.isArray(payload.models)) {
        this.callbacks.toast('不是 Texture map 模型组合文件', 'error');
        return;
      }
      if (!payload.models.length) {
        this.callbacks.toast('模型组合为空', 'info');
        return;
      }
      this.disposeModel();
      this.upAxis = payload.upAxis === 'z' ? 'z' : 'y';
      this.element.querySelectorAll('[data-up]').forEach((button) => {
        button.classList.toggle('active', (button as HTMLElement).dataset.up === this.upAxis);
      });
      const pending = [...payload.models];
      for (const model of pending) {
        if (!model.data && !model.path) continue;
        const before = this.modelEntries.length;
        const name = model.name || basename(model.path || '模型.fbx');
        if (model.data) {
          const bytes = base64ToBytes(model.data);
          await this.loadBuffer(bytes, name, '', bytes.byteLength);
        } else if (model.path) {
          await this.loadPath(model.path);
        }
        if (this.modelEntries.length === before) continue;
        const entry = this.modelEntries.slice(before)[0];
        if (!entry) continue;
        const position = model.position ?? [0, 0, 0];
        const rotation = model.rotation ?? [0, 0, 0];
        const scale = model.scale ?? [1, 1, 1];
        entry.root.position.set(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
        entry.root.rotation.set(
          THREE.MathUtils.degToRad(rotation[0] ?? 0),
          THREE.MathUtils.degToRad(rotation[1] ?? 0),
          THREE.MathUtils.degToRad(rotation[2] ?? 0)
        );
        entry.root.scale.set(
          Math.max(0.001, scale[0] ?? 1),
          Math.max(0.001, scale[1] ?? 1),
          Math.max(0.001, scale[2] ?? 1)
        );
        entry.root.updateMatrixWorld(true);
      }
      this.fit();
      this.renderModelList();
      this.syncModelTransformControls();
      this.callbacks.toast(`已载入模型组合：${this.modelEntries.length} 个模型`, 'success');
    } catch (error) {
      this.callbacks.toast(`载入模型组合失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private rebuildMaterials(): void {
    this.generatedMaterials.forEach((material) => material.dispose());
    this.generatedMaterials = [];
    this.generatedMaterialTextures.forEach((texture) => texture.dispose());
    this.generatedMaterialTextures = [];
    if (!this.modelEntries.length) {
      this.updateMaterialBall();
      return;
    }

    const textureCache = new Map<THREE.Texture, THREE.Texture>();
    const prepareTexture = (source: THREE.Texture | null | undefined): THREE.Texture | null => {
      if (!source) return null;
      let clone = textureCache.get(source);
      if (!clone) {
        clone = source.clone();
        clone.wrapS = THREE.RepeatWrapping;
        clone.wrapT = THREE.RepeatWrapping;
        clone.offset.set(this.materialSettings.offsetU, this.materialSettings.offsetV);
        clone.repeat.set(this.materialSettings.scaleU, this.materialSettings.scaleV);
        clone.needsUpdate = true;
        textureCache.set(source, clone);
        this.generatedMaterialTextures.push(clone);
      }
      return clone;
    };

    for (const entry of this.modelEntries) entry.object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const original = this.originalMaterials.get(mesh);
      if (!original) return;
      const build = (material: THREE.Material): THREE.Material => {
        let next: THREE.Material;
        if (this.lightingEnabled) {
          next = material.clone();
        } else {
          const source = material as THREE.MeshStandardMaterial;
          next = new THREE.MeshBasicMaterial({
            map: source.map ?? null,
            color: source.color ? source.color.clone() : new THREE.Color(0xffffff),
            transparent: source.transparent,
            opacity: source.opacity,
            side: source.side,
            alphaTest: source.alphaTest
          });
        }
        const sourceMap = this.externalTexture ?? (material as THREE.MeshStandardMaterial).map ?? null;
        const map = prepareTexture(sourceMap);
        if (map) {
          (next as THREE.MeshStandardMaterial).map = map;
          if (this.externalTexture && (next as THREE.MeshStandardMaterial).color) {
            (next as THREE.MeshStandardMaterial).color.set(0xffffff);
          }
        }
        this.applyMaterialSettings(next);
        next.needsUpdate = true;
        this.generatedMaterials.push(next);
        return next;
      };
      mesh.material = Array.isArray(original) ? original.map(build) : build(original);
    });
    this.updateMaterialBall();
  }

  private applyMaterialSettings(material: THREE.Material): void {
    const map = (material as THREE.MeshStandardMaterial).map as THREE.Texture | null;
    if (map) {
      map.offset.set(this.materialSettings.offsetU, this.materialSettings.offsetV);
      map.repeat.set(this.materialSettings.scaleU, this.materialSettings.scaleV);
    }
    if (map) {
      material.transparent = true;
      material.depthWrite = false;
    }
    const emissiveMaterial = material as THREE.MeshStandardMaterial;
    if (emissiveMaterial.emissive) {
      emissiveMaterial.emissive.set(this.materialSettings.emissive);
      if (typeof emissiveMaterial.emissiveIntensity === 'number') {
        emissiveMaterial.emissiveIntensity = this.materialSettings.emissiveIntensity;
      }
    }
    material.side = this.materialSettings.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    material.needsUpdate = true;
    this.patchMaterialShader(material);
    this.updateMaterialUniforms(material);
  }

  private patchMaterialShader(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uNyxelChannel = { value: MATERIAL_CHANNEL_INDEX[this.materialSettings.channel] };
      shader.uniforms.uNyxelAlphaChannel = { value: MATERIAL_ALPHA_CHANNEL_INDEX[this.materialSettings.alphaChannel] };
      shader.uniforms.uNyxelBrightness = { value: this.materialSettings.brightness };
      shader.uniforms.uNyxelContrast = { value: this.materialSettings.contrast };
      shader.uniforms.uNyxelEmissive = { value: new THREE.Color(this.materialSettings.emissive) };
      shader.uniforms.uNyxelEmissiveIntensity = { value: this.materialSettings.emissiveIntensity };
      shader.fragmentShader = `
        uniform int uNyxelChannel;
        uniform int uNyxelAlphaChannel;
        uniform float uNyxelBrightness;
        uniform float uNyxelContrast;
        uniform vec3 uNyxelEmissive;
        uniform float uNyxelEmissiveIntensity;
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `
        #ifdef USE_MAP
          vec4 nyxelTexel = texture2D( map, vMapUv );
          vec3 nyxelColor = nyxelTexel.rgb;
          if ( uNyxelChannel == 1 ) nyxelColor = vec3( nyxelTexel.r );
          else if ( uNyxelChannel == 2 ) nyxelColor = vec3( nyxelTexel.g );
          else if ( uNyxelChannel == 3 ) nyxelColor = vec3( nyxelTexel.b );
          else if ( uNyxelChannel == 4 ) nyxelColor = vec3( nyxelTexel.a );
          else if ( uNyxelChannel == 5 ) nyxelColor = vec3( dot( nyxelTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) );
          nyxelColor = ( nyxelColor - 0.5 ) * uNyxelContrast + 0.5;
          float nyxelBrightnessFactor = uNyxelBrightness;
          if ( uNyxelBrightness < 0.0 ) nyxelBrightnessFactor = 1.0 / ( 1.0 - uNyxelBrightness );
          nyxelColor *= nyxelBrightnessFactor;
          diffuseColor.rgb *= clamp( nyxelColor, 0.0, 1.0 );
          float nyxelAlpha = 1.0;
          if ( uNyxelAlphaChannel == 1 ) nyxelAlpha = nyxelTexel.r;
          else if ( uNyxelAlphaChannel == 2 ) nyxelAlpha = nyxelTexel.g;
          else if ( uNyxelAlphaChannel == 3 ) nyxelAlpha = nyxelTexel.b;
          diffuseColor.a *= nyxelTexel.a * nyxelAlpha;
        #endif
        `
      );
      if ((material as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <envmap_fragment>',
          `#include <envmap_fragment>
           outgoingLight += uNyxelEmissive * uNyxelEmissiveIntensity;`
        );
      }
      material.userData.nyxelUniforms = {
        channel: shader.uniforms.uNyxelChannel,
        alphaChannel: shader.uniforms.uNyxelAlphaChannel,
        brightness: shader.uniforms.uNyxelBrightness,
        contrast: shader.uniforms.uNyxelContrast,
        emissive: shader.uniforms.uNyxelEmissive,
        emissiveIntensity: shader.uniforms.uNyxelEmissiveIntensity
      };
    };
    material.customProgramCacheKey = () => 'nyxel-material';
  }

  private updateMaterialUniforms(material: THREE.Material): void {
    const map = (material as THREE.MeshStandardMaterial).map as THREE.Texture | null;
    if (map) {
      map.offset.set(this.materialSettings.offsetU, this.materialSettings.offsetV);
      map.repeat.set(this.materialSettings.scaleU, this.materialSettings.scaleV);
    }
    const emissiveMaterial = material as THREE.MeshStandardMaterial;
    if (emissiveMaterial.emissive) {
      emissiveMaterial.emissive.set(this.materialSettings.emissive);
      if (typeof emissiveMaterial.emissiveIntensity === 'number') {
        emissiveMaterial.emissiveIntensity = this.materialSettings.emissiveIntensity;
      }
    }
    material.side = this.materialSettings.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    material.needsUpdate = true;
    const uniforms = material.userData.nyxelUniforms as
      | Record<string, { value: number | THREE.Color }>
      | undefined;
    if (!uniforms) return;
    uniforms.channel.value = MATERIAL_CHANNEL_INDEX[this.materialSettings.channel];
    uniforms.alphaChannel.value = MATERIAL_ALPHA_CHANNEL_INDEX[this.materialSettings.alphaChannel];
    uniforms.brightness.value = this.materialSettings.brightness;
    uniforms.contrast.value = this.materialSettings.contrast;
    if (uniforms.emissive.value instanceof THREE.Color) {
      uniforms.emissive.value.set(this.materialSettings.emissive);
    }
    uniforms.emissiveIntensity.value = this.materialSettings.emissiveIntensity;
  }

  private setupMaterialPanel(): void {
    this.restoreMaterialSettings();
    this.bindMaterialPanelEvents();
    this.syncMaterialControls();
    this.initMaterialBall();
    this.applyBloomStrength();
    this.updateMaterialBall(true);
  }

  private normalizeMaterialSettings(data: Partial<MaterialSettings>): MaterialSettings {
    const base = MATERIAL_PRESETS.default;
    const number = (value: unknown, fallback: number, min: number, max: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
      return Math.min(max, Math.max(min, value));
    };
    const channel = Object.prototype.hasOwnProperty.call(MATERIAL_CHANNEL_INDEX, data.channel as string)
      ? (data.channel as MaterialChannel)
      : base.channel;
    const alphaChannel = Object.prototype.hasOwnProperty.call(MATERIAL_ALPHA_CHANNEL_INDEX, data.alphaChannel as string)
      ? (data.alphaChannel as MaterialAlphaChannel)
      : base.alphaChannel;
    const legacy = data as Partial<MaterialSettings> & { scale?: number };
    const hasNewScale = typeof data.scaleU === 'number' || typeof data.scaleV === 'number';
    const legacyScale = typeof legacy.scale === 'number' ? legacy.scale : undefined;
    const legacyBrightness = !hasNewScale && legacyScale === undefined;
    return {
      channel,
      alphaChannel,
      offsetU: number(data.offsetU, base.offsetU, -10, 10),
      offsetV: number(data.offsetV, base.offsetV, -10, 10),
      scaleU: number(data.scaleU, legacyScale ?? base.scaleU, 0.01, 16),
      scaleV: number(data.scaleV, legacyScale ?? base.scaleV, 0.01, 16),
      emissive: typeof data.emissive === 'string' && /^#[0-9a-f]{6}$/i.test(data.emissive) ? data.emissive : base.emissive,
      emissiveIntensity: number(data.emissiveIntensity, base.emissiveIntensity, 0, 20),
      bloomStrength: number(data.bloomStrength, base.bloomStrength, 0, 3),
      brightness: legacyBrightness
        ? number(1 + number(data.brightness, 0, -1, 1), base.brightness, -8, 8)
        : number(data.brightness, base.brightness, -8, 8),
      contrast: number(data.contrast, base.contrast, -8, 8),
      doubleSided: data.doubleSided === true,
      ueBackground: data.ueBackground === true
    };
  }

  private readStoredMaterialSettings(): MaterialSettings | null {
    try {
      const raw = localStorage.getItem(MATERIAL_SETTINGS_KEY);
      if (!raw) return null;
      return this.normalizeMaterialSettings(JSON.parse(raw) as Partial<MaterialSettings>);
    } catch {
      return null;
    }
  }

  private saveMaterialSettings(): void {
    try {
      if (this.materialPresetKey === 'custom') {
        localStorage.setItem(MATERIAL_SETTINGS_KEY, JSON.stringify(this.materialSettings));
      }
      localStorage.setItem(MATERIAL_PRESET_KEY, this.materialPresetKey);
    } catch {
      // Storage can be unavailable in restricted environments.
    }
  }

  private restoreMaterialSettings(): void {
    let presetKey = 'default';
    try {
      presetKey = localStorage.getItem(MATERIAL_PRESET_KEY) ?? 'default';
    } catch {
      presetKey = 'default';
    }
    if (presetKey === 'custom') {
      const stored = this.readStoredMaterialSettings();
      if (stored) {
        this.materialSettings = stored;
        this.materialPresetKey = 'custom';
        return;
      }
    }
    this.materialSettings = { ...MATERIAL_PRESETS.default };
    this.materialPresetKey = 'default';
  }

  private markMaterialCustom(): void {
    this.materialPresetKey = 'custom';
    this.saveMaterialSettings();
    this.syncMaterialControls();
    this.refreshMaterialAppearance();
  }

  private bindMaterialPanelEvents(): void {
    this.materialDoubleSided.addEventListener('change', () => {
      this.materialSettings.doubleSided = this.materialDoubleSided.checked;
      this.markMaterialCustom();
    });
    this.materialBackgroundToggle.addEventListener('change', () => {
      this.materialSettings.ueBackground = this.materialBackgroundToggle.checked;
      this.applyMaterialBackground();
      this.markMaterialCustom();
    });
    this.materialPresetSelect.addEventListener('change', () => {
      if (this.materialPresetSelect.value === 'custom') {
        const stored = this.readStoredMaterialSettings();
        this.materialSettings = stored ? { ...stored } : { ...this.materialSettings };
        this.materialPresetKey = 'custom';
      } else {
        this.materialSettings = { ...MATERIAL_PRESETS.default };
        this.materialPresetKey = 'default';
      }
      this.saveMaterialSettings();
      this.syncMaterialControls();
      this.refreshMaterialAppearance();
    });

    this.element.querySelectorAll<HTMLElement>('[data-material-channel]').forEach((button) => {
      button.addEventListener('click', () => {
        this.materialSettings.channel = (button.dataset.materialChannel as MaterialChannel) ?? 'r';
        this.markMaterialCustom();
      });
    });

    this.element.querySelectorAll<HTMLElement>('[data-material-alpha]').forEach((button) => {
      button.addEventListener('click', () => {
        this.materialSettings.alphaChannel = (button.dataset.materialAlpha as MaterialAlphaChannel) ?? 'r';
        this.markMaterialCustom();
      });
    });

    const bindRange = (input: HTMLInputElement, apply: (value: number) => void): void => {
      input.addEventListener('input', () => {
        apply(Number(input.value));
        this.markMaterialCustom();
      });
    };
    bindRange(this.materialOffsetU, (value) => { this.materialSettings.offsetU = value; });
    bindRange(this.materialOffsetV, (value) => { this.materialSettings.offsetV = value; });
    bindRange(this.materialScaleU, (value) => { this.materialSettings.scaleU = value; });
    bindRange(this.materialScaleV, (value) => { this.materialSettings.scaleV = value; });
    bindRange(this.materialEmissiveIntensity, (value) => { this.materialSettings.emissiveIntensity = value; });
    bindRange(this.materialBloom, (value) => { this.materialSettings.bloomStrength = value; });
    bindRange(this.materialBrightness, (value) => { this.materialSettings.brightness = value; });
    bindRange(this.materialContrast, (value) => { this.materialSettings.contrast = value; });

    const bindNumber = (input: HTMLInputElement, min: number, max: number, apply: (value: number) => void): void => {
      input.addEventListener('change', () => {
        const raw = Number(input.value);
        if (!Number.isFinite(raw)) {
          this.syncMaterialControls();
          return;
        }
        const value = Math.min(max, Math.max(min, raw));
        apply(value);
        this.markMaterialCustom();
      });
    };
    bindNumber(this.materialOffsetUValue, -10, 10, (value) => { this.materialSettings.offsetU = value; });
    bindNumber(this.materialOffsetVValue, -10, 10, (value) => { this.materialSettings.offsetV = value; });
    bindNumber(this.materialScaleUValue, 0.01, 16, (value) => { this.materialSettings.scaleU = value; });
    bindNumber(this.materialScaleVValue, 0.01, 16, (value) => { this.materialSettings.scaleV = value; });
    bindNumber(this.materialEmissiveIntensityValue, 0, 20, (value) => { this.materialSettings.emissiveIntensity = value; });
    bindNumber(this.materialBloomValue, 0, 3, (value) => { this.materialSettings.bloomStrength = value; });
    bindNumber(this.materialBrightnessValue, -8, 8, (value) => { this.materialSettings.brightness = value; });
    bindNumber(this.materialContrastValue, -8, 8, (value) => { this.materialSettings.contrast = value; });

    this.materialEmissive.addEventListener('input', () => {
      this.materialSettings.emissive = this.materialEmissive.value;
      this.markMaterialCustom();
    });
    this.element.querySelector('[data-material-reset]')?.addEventListener('click', () => {
      this.materialSettings = { ...MATERIAL_PRESETS.default };
      this.materialPresetKey = 'default';
      this.saveMaterialSettings();
      this.syncMaterialControls();
      this.refreshMaterialAppearance();
    });
  }

  private syncMaterialControls(): void {
    const settings = this.materialSettings;
    this.materialPresetSelect.value = this.materialPresetKey;
    this.materialOffsetU.value = String(settings.offsetU);
    this.materialOffsetV.value = String(settings.offsetV);
    this.materialScaleU.value = String(settings.scaleU);
    this.materialScaleV.value = String(settings.scaleV);
    this.materialOffsetUValue.value = settings.offsetU.toFixed(2);
    this.materialOffsetVValue.value = settings.offsetV.toFixed(2);
    this.materialScaleUValue.value = settings.scaleU.toFixed(2);
    this.materialScaleVValue.value = settings.scaleV.toFixed(2);
    this.materialEmissive.value = settings.emissive;
    this.materialEmissiveIntensity.value = String(settings.emissiveIntensity);
    this.materialEmissiveIntensityValue.value = settings.emissiveIntensity.toFixed(2);
    this.materialBloom.value = String(settings.bloomStrength);
    this.materialBloomValue.value = settings.bloomStrength.toFixed(2);
    this.materialBrightness.value = String(settings.brightness);
    this.materialBrightnessValue.value = settings.brightness.toFixed(2);
    this.materialContrast.value = String(settings.contrast);
    this.materialContrastValue.value = settings.contrast.toFixed(2);
    this.materialDoubleSided.checked = settings.doubleSided;
    this.materialBackgroundToggle.checked = settings.ueBackground;
    this.applyMaterialBackground();
    this.element.querySelectorAll<HTMLElement>('[data-material-channel]').forEach((button) => {
      button.classList.toggle('active', button.dataset.materialChannel === settings.channel);
    });
    this.element.querySelectorAll<HTMLElement>('[data-material-alpha]').forEach((button) => {
      button.classList.toggle('active', button.dataset.materialAlpha === settings.alphaChannel);
    });
  }

  private applyBloomStrength(): void {
    const strength = Math.max(0, this.materialSettings.bloomStrength);
    if (this.bloomPass) this.bloomPass.strength = strength;
    if (this.materialBallBloom) this.materialBallBloom.strength = strength * 0.75;
  }

  private refreshMaterialAppearance(): void {
    this.applyBloomStrength();
    for (const material of this.generatedMaterials) this.updateMaterialUniforms(material);
    this.updateMaterialBall();
  }

  private initMaterialBall(): void {
    if (this.materialBallRenderer) return;
    const renderer = new THREE.WebGLRenderer({ canvas: this.materialBallCanvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d10);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    camera.position.set(0, 0.1, 3.4);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223044, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(2.5, 3.5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7dd3fc, 1.2);
    rim.position.set(-3, 1.5, -2);
    scene.add(rim);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.52,
      metalness: 0.04
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), material);
    scene.add(mesh);
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    this.materialBallBloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.135, 0.35, 1);
    composer.addPass(this.materialBallBloom);
    composer.addPass(new OutputPass());
    this.materialBallRenderer = renderer;
    this.materialBallScene = scene;
    this.materialBallCamera = camera;
    this.materialBallMaterial = material;
    this.materialBallMesh = mesh;
    this.materialBallComposer = composer;
    this.resizeMaterialBall();
    this.applyMaterialBackground();
  }

  private createStudioBackgroundTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext('2d');
    if (context) {
      const vertical = context.createLinearGradient(0, 0, 0, canvas.height);
      vertical.addColorStop(0, '#343941');
      vertical.addColorStop(0.45, '#1c2026');
      vertical.addColorStop(1, '#08090b');
      context.fillStyle = vertical;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const glow = context.createRadialGradient(
        canvas.width * 0.5,
        canvas.height * 0.28,
        0,
        canvas.width * 0.5,
        canvas.height * 0.28,
        canvas.width * 0.72
      );
      glow.addColorStop(0, 'rgba(135, 155, 185, 0.28)');
      glow.addColorStop(0.45, 'rgba(80, 95, 115, 0.1)');
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private applyMaterialBackground(): void {
    if (this.materialSettings.ueBackground) {
      if (!this.studioBackgroundTexture) this.studioBackgroundTexture = this.createStudioBackgroundTexture();
      this.scene.background = this.studioBackgroundTexture;
      if (this.materialBallScene) this.materialBallScene.background = this.studioBackgroundTexture;
    } else {
      this.scene.background = new THREE.Color(0x080a0e);
      if (this.materialBallScene) this.materialBallScene.background = new THREE.Color(0x0b0d10);
    }
    if (this.materialBallComposer) this.materialBallComposer.render();
  }

  private resizeMaterialBall(): void {
    if (!this.materialBallRenderer || !this.materialBallScene || !this.materialBallCamera) return;
    const width = this.materialBallCanvas.clientWidth;
    const height = this.materialBallCanvas.clientHeight;
    if (width < 2 || height < 2) return;
    this.materialBallRenderer.setSize(width, height, false);
    this.materialBallComposer?.setPixelRatio(this.materialBallRenderer.getPixelRatio());
    this.materialBallComposer?.setSize(width, height);
    this.materialBallCamera.aspect = width / height;
    this.materialBallCamera.updateProjectionMatrix();
    if (this.materialBallComposer) this.materialBallComposer.render();
    else this.materialBallRenderer.render(this.materialBallScene, this.materialBallCamera);
  }

  private updateMaterialBall(forceTexture = false): void {
    if (!this.materialBallMaterial) return;
    const source = this.externalTexture ?? this.getModelTexture();
    const hasModelTexture = Boolean(source);
    if (forceTexture || !this.materialBallTexture || source !== this.materialBallSource) {
      this.materialBallTexture?.dispose();
      let texture: THREE.Texture;
      if (source) {
        texture = source.clone();
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
      } else {
        texture = this.createMaterialBallTexture();
      }
      this.materialBallTexture = texture;
      this.materialBallSource = source;
      this.materialBallMaterial.map = texture;
      this.materialBallMaterial.needsUpdate = true;
    }
    this.applyMaterialSettings(this.materialBallMaterial);
    if (!hasModelTexture) {
      this.materialBallMaterial.transparent = false;
      this.materialBallMaterial.depthWrite = true;
    }
    this.resizeMaterialBall();
  }

  private createMaterialBallTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (context) {
      const cell = 64;
      const colors = ['#4f6b8a', '#7a5c8f', '#8a6a4f', '#4f8a6f'];
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          context.fillStyle = colors[(x + y) % colors.length];
          context.fillRect(x * cell, y * cell, cell, cell);
        }
      }
      context.strokeStyle = 'rgba(255,255,255,0.34)';
      context.lineWidth = 2;
      for (let i = 0; i <= 8; i += 1) {
        context.beginPath();
        context.moveTo(i * cell, 0);
        context.lineTo(i * cell, 512);
        context.moveTo(0, i * cell);
        context.lineTo(512, i * cell);
        context.stroke();
      }
      context.fillStyle = 'rgba(255,255,255,0.8)';
      context.font = 'bold 64px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('UV', 256, 256);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  async applyExternalTexturePath(filePath: string): Promise<void> {
    if (!this.model) {
      this.callbacks.toast('请先加载一个 FBX 模型', 'info');
      return;
    }
    try {
      const buffer = await window.nyxel.file.read(filePath);
      const blob = new Blob([new Uint8Array(buffer)], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      this.setExternalTexture(bitmap, basename(filePath));
    } catch (error) {
      this.callbacks.toast(`贴图加载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async applyExternalTextureFile(file: File): Promise<void> {
    if (!this.model) {
      this.callbacks.toast('请先加载一个 FBX 模型', 'info');
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      this.setExternalTexture(bitmap, file.name);
    } catch (error) {
      this.callbacks.toast(`贴图加载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private setExternalTexture(bitmap: ImageBitmap, label: string): void {
    if (this.externalTexture) this.externalTexture.dispose();
    const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.externalTexture = texture;
    this.applyWrapMode();
    this.rebuildMaterials();
    if (this.mode === 'uv' && this.uvBgMode === 'texture') this.updateUvBackground();
    this.callbacks.status.set(this.fileName, `外部贴图：${label} · ${this.statsText()}`);
    this.callbacks.toast(`已应用外部贴图：${label}（仅预览）`, 'success');
  }

  private applyWrapMode(): void {
    if (!this.externalTexture) return;
    this.externalTexture.wrapS = this.wrapRepeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    this.externalTexture.wrapT = this.wrapRepeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    this.externalTexture.needsUpdate = true;
  }

  private countTriangles(object: THREE.Object3D): number {
    let triangles = 0;
    object.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const geometry = (child as THREE.Mesh).geometry;
      if (geometry.index) triangles += geometry.index.count / 3;
      else if (geometry.attributes.position) triangles += geometry.attributes.position.count / 3;
    });
    return Math.round(triangles);
  }

  private boundingBox(object: THREE.Object3D): THREE.Box3 {
    return new THREE.Box3().setFromObject(object);
  }

  private statsText(): string {
    if (!this.model) return '';
    const triangles = this.countTriangles(this.model);
    const box = this.boundingBox(this.model);
    const size = box.getSize(new THREE.Vector3());
    const fmt = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2));
    return `三角面 ${triangles.toLocaleString()} · 包围盒 ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} cm`;
  }

  private updateStats(): void {
    if (!this.model) return;
    let text: string;
    if (this.mode === 'uv') {
      const label = this.uvChannelLabel(this.uvChannel);
      text = this.uvChannels.length
        ? `${label} · ${this.uvTriangles.length.toLocaleString()} 面${this.uvOobCount ? ` · 越界 ${this.uvOobCount}` : ''}`
        : 'UV 不可用';
    } else {
      text = this.statsText();
    }
    this.statsBadge.textContent = text;
    this.callbacks.status.set(this.fileName, text);
  }

  private fitCurrent(): void {
    if (this.mode === 'uv') this.fitUv();
    else this.fit();
  }

  private fitUv(): void {
    const width = Math.max(1, this.body.clientWidth);
    const height = Math.max(1, this.body.clientHeight);
    const span = this.uvTiles ? 2 : 1;
    this.uvZoom = Math.min(1, width / height) / span;
    this.uvCenter.set(this.uvTiles ? 1 : 0, this.uvTiles ? 1 : 0);
    this.updateUvCamera();
  }

  private updateUvCamera(): void {
    const width = Math.max(1, this.body.clientWidth);
    const height = Math.max(1, this.body.clientHeight);
    const aspect = width / height;
    const halfH = 1 / this.uvZoom;
    const halfW = aspect / this.uvZoom;
    this.uvCamera.left = this.uvCenter.x - halfW;
    this.uvCamera.right = this.uvCenter.x + halfW;
    this.uvCamera.top = this.uvCenter.y + halfH;
    this.uvCamera.bottom = this.uvCenter.y - halfH;
    this.uvCamera.updateProjectionMatrix();
    this.updateUvRulers();
  }

  private uvChannelLabel(channel: string): string {
    return UV_LABELS[channel] ?? channel.toUpperCase();
  }

  private fit(): void {
    if (!this.model && !this.referenceGroup) return;
    const box = new THREE.Box3();
    if (this.modelEntries.length) {
      for (const entry of this.modelEntries) box.expandByObject(entry.root);
      if (this.referenceGroup) box.expandByObject(this.referenceGroup);
    } else if (this.referenceGroup) {
      box.setFromObject(this.referenceGroup);
    } else if (this.model) {
      box.setFromObject(this.model);
    }
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = (maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * 1.2;
    this.controls.target.copy(center);
    this.camera.position.set(center.x + distance, center.y + distance * 0.6, center.z + distance);
    this.camera.near = Math.max(distance / 1000, 0.0001);
    this.camera.far = distance * 1000;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = distance * 0.02;
    this.controls.maxDistance = distance * 50;
    this.controls.update();

    this.grid.position.set(center.x, box.min.y, center.z);
    const gridSize = Math.max(10, maxDim * 3);
    this.grid.scale.setScalar(gridSize / 10);
    this.updateStats();
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.updateUvCamera();
    this.resizeMaterialBall();
  }

  private showError(message: string): void {
    const existing = this.body.querySelector('.model-error');
    if (existing) existing.remove();
    if (!message) return;
    const box = document.createElement('div');
    box.className = 'model-error';
    box.textContent = message;
    this.body.append(box);
    this.callbacks.toast(message, 'error');
  }

  private disposeModel(): void {
    this.transformControls.detach();
    this.gizmoTarget = null;
    this.clearReferenceModel();
    this.clearUvData();
    this.generatedMaterialTextures.forEach((texture) => texture.dispose());
    this.generatedMaterialTextures = [];
    this.generatedMaterials.forEach((material) => material.dispose());
    this.generatedMaterials = [];
    const disposedTextures = new Set<THREE.Texture>();
    for (const entry of this.modelEntries) {
      this.scene.remove(entry.root);
      entry.object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (!mesh.material) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const map = (material as THREE.MeshStandardMaterial).map;
          if (map && !disposedTextures.has(map)) {
            disposedTextures.add(map);
            map.dispose();
          }
          material.dispose();
        }
      });
    }
    this.modelEntries = [];
    this.activeModelId = -1;
    this.originalMaterials = new WeakMap();
    if (this.externalTexture) {
      this.externalTexture.dispose();
      this.externalTexture = null;
    }
    this.model = null;
    this.fileName = '';
    this.filePath = '';
    this.fileSize = 0;
    this.materialBallSource = null;
    this.materialBallTexture?.dispose();
    this.materialBallTexture = null;
    this.renderModelList();
    this.syncModelTransformControls();
    this.updateMaterialBall(true);
  }

  private createCheckerTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (context) {
      const cell = 32;
      for (let y = 0; y < canvas.height; y += cell) {
        for (let x = 0; x < canvas.width; x += cell) {
          context.fillStyle = (x / cell + y / cell) % 2 === 0 ? '#2a2a2a' : '#1a1a1a';
          context.fillRect(x, y, cell, cell);
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  private setMode(mode: ViewMode): void {
    if (mode === 'uv' && !this.model) {
      this.callbacks.toast('请先加载一个 FBX 模型', 'info');
      return;
    }
    if (this.mode === mode) return;
    this.mode = mode;
    this.element.classList.toggle('uv-mode', mode === 'uv');
    this.controls.enabled = mode === '3d' && this.altHeld;
    this.syncTransformGizmo();
    this.updateNavCursor();
    this.element.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('active', (button as HTMLElement).dataset.mode === mode);
    });
    const fitButton = this.element.querySelector('#model-fit') as HTMLButtonElement | null;
    if (fitButton) fitButton.textContent = mode === 'uv' ? 'Fit UV' : 'Fit View';
    if (mode === 'uv') {
      this.ensureUvData();
      this.fitUv();
      this.updateUvBackground();
      this.uvHud.classList.remove('hidden');
    } else {
      this.uvHud.classList.add('hidden');
    }
    this.updateStats();
    this.updateUvHud();
    this.updateUvRulers();
    if (mode === '3d') {
      requestAnimationFrame(() => {
        this.resize();
        this.resizeMaterialBall();
      });
    }
  }

  private ensureUvData(): void {
    if (this.uvDataBuilt) return;
    if (!this.uvChannels.length) {
      this.uvDataBuilt = true;
      this.uvTriangles = [];
      this.updateStats();
      this.updateUvHud();
      return;
    }
    this.buildUvGeometry();
  }

  private refreshUvChannels(): void {
    const found = new Set<string>();
    this.model?.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      for (const name of UV_ATTRIBUTES) {
        if (mesh.geometry.getAttribute(name)) found.add(name);
      }
    });
    this.uvChannels = UV_ATTRIBUTES.filter((name) => found.has(name));
    if (!this.uvChannels.includes(this.uvChannel)) {
      this.uvChannel = this.uvChannels[0] ?? 'uv';
    }
    this.uvChannelSelect.innerHTML = this.uvChannels.length
      ? this.uvChannels.map((name) => `<option value="${name}">${this.uvChannelLabel(name)}</option>`).join('')
      : '<option value="">无 UV</option>';
    this.uvChannelSelect.disabled = !this.uvChannels.length;
    this.uvChannelSelect.value = this.uvChannels.length ? this.uvChannel : '';
    this.uvTriangles = [];
    this.uvOobCount = 0;
    this.uvMeshCount = 0;
    this.clearUvLines();
    this.clearOverlap();
    this.updateStats();
    this.updateUvHud();
  }

  private buildUvGeometry(): void {
    this.clearUvLines();
    this.uvTriangles = [];
    this.uvOobCount = 0;
    this.uvMeshCount = 0;
    if (!this.model || !this.uvChannels.includes(this.uvChannel)) {
      this.uvDataBuilt = true;
      this.updateStats();
      this.updateUvHud();
      return;
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const faceColor = new THREE.Color(UV_LINE_COLOR);
    const outOfBounds = new THREE.Color(UV_OUT_OF_BOUNDS);

    this.model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const uvAttr = mesh.geometry.getAttribute(this.uvChannel);
      const posAttr = mesh.geometry.getAttribute('position');
      if (!uvAttr || !posAttr) return;

      this.uvMeshCount += 1;
      const index = mesh.geometry.index;
      const count = index ? index.count : posAttr.count;
      const triangleCount = Math.floor(count / 3);
      const groups = mesh.geometry.groups;
      let groupIndex = 0;

      for (let face = 0; face < triangleCount; face += 1) {
        const start = face * 3;
        while (
          groupIndex < groups.length &&
          start >= groups[groupIndex].start + groups[groupIndex].count
        ) {
          groupIndex += 1;
        }
        let materialIndex = 0;
        if (groupIndex < groups.length && start >= groups[groupIndex].start) {
          materialIndex = groups[groupIndex].materialIndex ?? 0;
        }
        const ia = index ? index.getX(start) : start;
        const ib = index ? index.getX(start + 1) : start + 1;
        const ic = index ? index.getX(start + 2) : start + 2;
        const u0 = uvAttr.getX(ia);
        const v0 = uvAttr.getY(ia);
        const u1 = uvAttr.getX(ib);
        const v1 = uvAttr.getY(ib);
        const u2 = uvAttr.getX(ic);
        const v2 = uvAttr.getY(ic);
        const oob = u0 < -1e-5 || u0 > 1.00001 || v0 < -1e-5 || v0 > 1.00001 ||
          u1 < -1e-5 || u1 > 1.00001 || v1 < -1e-5 || v1 > 1.00001 ||
          u2 < -1e-5 || u2 > 1.00001 || v2 < -1e-5 || v2 > 1.00001;
        const color = oob ? outOfBounds : faceColor;
        if (oob) this.uvOobCount += 1;

        positions.push(
          u0 * 2 - 1, v0 * 2 - 1, 0, u1 * 2 - 1, v1 * 2 - 1, 0,
          u1 * 2 - 1, v1 * 2 - 1, 0, u2 * 2 - 1, v2 * 2 - 1, 0,
          u2 * 2 - 1, v2 * 2 - 1, 0, u0 * 2 - 1, v0 * 2 - 1, 0
        );
        colors.push(
          color.r, color.g, color.b, color.r, color.g, color.b,
          color.r, color.g, color.b, color.r, color.g, color.b,
          color.r, color.g, color.b, color.r, color.g, color.b
        );

        this.uvTriangles.push({
          mesh,
          faceIndex: face,
          materialIndex,
          u0,
          v0,
          u1,
          v1,
          u2,
          v2,
          oob
        });
      }
    });

    if (positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        toneMapped: false
      });
      const lines = new THREE.LineSegments(geometry, material);
      lines.renderOrder = 2;
      lines.frustumCulled = false;
      this.uvBaseLines = lines;
      this.uvLineGroup.add(lines);
    }

    this.updateUvTiles();
    this.uvDataBuilt = true;
    this.updateStats();
    this.updateUvHud();
  }

  private clearUvLines(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const child of [...this.uvLineGroup.children]) {
      const line = child as THREE.LineSegments;
      if (line.geometry) geometries.add(line.geometry);
      const material = line.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((item) => materials.add(item));
      else if (material) materials.add(material);
      this.uvLineGroup.remove(child);
    }
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.uvBaseLines = null;
    this.uvTileLines = [];
  }

  private updateUvTiles(): void {
    const show = this.uvTiles && !!this.uvBaseLines;
    this.uvTileGrid.visible = show;
    for (const mesh of this.uvBgTileMeshes) mesh.visible = show;
    const showOverlap = show && !!this.uvOverlapTexture;
    for (const mesh of this.uvOverlapTileMeshes) mesh.visible = showOverlap;
    this.uvTileLabels.classList.toggle('hidden', !show);

    for (const line of this.uvTileLines) this.uvLineGroup.remove(line);
    this.uvTileLines = [];

    if (show && this.uvBaseLines) {
      const base = this.uvBaseLines;
      for (const [x, y] of [[2, 0], [0, 2], [2, 2]] as Array<[number, number]>) {
        const clone = new THREE.LineSegments(base.geometry, base.material);
        clone.position.set(x, y, 0);
        clone.renderOrder = base.renderOrder;
        clone.frustumCulled = false;
        this.uvLineGroup.add(clone);
        this.uvTileLines.push(clone);
      }
    }

    this.updateUvRulers();
  }

  private updateUvRulers(): void {
    const visible = this.mode === 'uv' && !!this.model;
    this.uvRulers.classList.toggle('hidden', !visible);
    if (!visible) return;

    const width = Math.max(1, this.body.clientWidth);
    const height = Math.max(1, this.body.clientHeight);
    const left = this.uvCamera.left;
    const right = this.uvCamera.right;
    const bottom = this.uvCamera.bottom;
    const top = this.uvCamera.top;
    const uMin = (left + 1) / 2;
    const uMax = (right + 1) / 2;
    const vMin = (bottom + 1) / 2;
    const vMax = (top + 1) / 2;
    const step = this.rulerStep(Math.max(uMax - uMin, vMax - vMin));

    this.uvRulerTop.innerHTML = '<span class="uv-axis-label u">U →</span>';
    this.uvRulerLeft.innerHTML = '<span class="uv-axis-label v">V ↑</span>';

    for (let u = Math.ceil(uMin / step) * step; u <= uMax + 1e-9; u += step) {
      const x = ((u * 2 - 1 - left) / (right - left)) * width;
      if (x < 0 || x > width) continue;
      const tick = document.createElement('div');
      tick.className = 'uv-tick top';
      tick.style.left = `${x}px`;
      const label = document.createElement('span');
      label.textContent = this.formatRulerValue(u, step);
      tick.append(label);
      this.uvRulerTop.append(tick);
    }

    for (let v = Math.ceil(vMin / step) * step; v <= vMax + 1e-9; v += step) {
      const y = (1 - (v * 2 - 1 - bottom) / (top - bottom)) * height;
      if (y < 0 || y > height) continue;
      const tick = document.createElement('div');
      tick.className = 'uv-tick left';
      tick.style.top = `${y}px`;
      const label = document.createElement('span');
      label.textContent = this.formatRulerValue(v, step);
      tick.append(label);
      this.uvRulerLeft.append(tick);
    }

    this.updateUvTileLabels(width, height, left, right, bottom, top);
  }

  private updateUvTileLabels(
    width: number,
    height: number,
    left: number,
    right: number,
    bottom: number,
    top: number
  ): void {
    const labels = this.uvTileLabels.querySelectorAll('span');
    const centers: Array<[number, number]> = [[0, 0], [2, 0], [0, 2], [2, 2]];
    labels.forEach((label, index) => {
      if (!this.uvTiles) {
        (label as HTMLElement).style.display = 'none';
        return;
      }
      const [worldX, worldY] = centers[index];
      const x = ((worldX - left) / (right - left)) * width;
      const y = (1 - (worldY - bottom) / (top - bottom)) * height;
      const element = label as HTMLElement;
      element.style.display = 'block';
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    });
  }

  private rulerStep(span: number): number {
    const steps = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
    for (const step of steps) {
      if (span / step <= 7) return step;
    }
    return 10;
  }

  private formatRulerValue(value: number, step: number): string {
    if (step < 0.1) return value.toFixed(2);
    if (step < 0.5) return value.toFixed(2);
    if (step < 1) return value.toFixed(1);
    return value.toFixed(0);
  }

  private clearUvData(): void {
    this.clearUvLines();
    this.clearOverlap();
    this.clearSelection();
    this.uvTriangles = [];
    this.uvOobCount = 0;
    this.uvMeshCount = 0;
    this.uvChannels = [];
    this.uvChannel = 'uv';
    this.uvDataBuilt = false;
    this.uvChannelSelect.innerHTML = '<option value="">无 UV</option>';
    this.uvChannelSelect.disabled = true;
    this.uvHud.classList.add('hidden');
    this.uvRulers.classList.add('hidden');
    this.uvTileGrid.visible = false;
    for (const mesh of this.uvBgTileMeshes) mesh.visible = false;
    for (const mesh of this.uvOverlapTileMeshes) mesh.visible = false;
    this.uvTileLabels.classList.add('hidden');
  }

  private updateUvBackground(): void {
    if (this.uvBgMode === 'texture') {
      const map = this.getModelTexture();
      if (!map) {
        this.uvBgMode = 'checker';
        this.callbacks.toast('模型没有可用贴图，已切换为棋盘格', 'info');
      } else {
        this.uvBgMaterials.texture.map = map;
        this.uvBgMaterials.texture.needsUpdate = true;
      }
    }
    const mode = this.uvBgMode;
    const material = mode === 'checker'
      ? this.uvBgMaterials.checker
      : mode === 'solid'
        ? this.uvBgMaterials.solid
        : this.uvBgMaterials.texture;
    this.uvBgPlane.material = material;
    for (const mesh of this.uvBgTileMeshes) mesh.material = material;
    this.uvBgSelect.value = mode;
  }

  private getModelTexture(): THREE.Texture | null {
    if (this.externalTexture) return this.externalTexture;
    if (!this.model) return null;
    let found: THREE.Texture | null = null;
    this.model.traverse((child) => {
      if (found) return;
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = this.originalMaterials.get(mesh) ?? mesh.material;
      const materials = Array.isArray(source) ? source : [source];
      for (const material of materials) {
        const map = (material as THREE.MeshStandardMaterial).map;
        if (map) {
          found = map;
          break;
        }
      }
    });
    return found;
  }

  private getTextureSize(): { width: number; height: number } | null {
    const texture = this.getModelTexture();
    if (!texture) return null;
    const image = texture.image as {
      width?: number;
      height?: number;
      naturalWidth?: number;
      naturalHeight?: number;
      videoWidth?: number;
      videoHeight?: number;
    } | undefined;
    const width = image?.width ?? image?.naturalWidth ?? image?.videoWidth;
    const height = image?.height ?? image?.naturalHeight ?? image?.videoHeight;
    return width && height ? { width, height } : null;
  }

  private uvArea(triangle: UvTriangle): number {
    return Math.abs(
      (triangle.u1 - triangle.u0) * (triangle.v2 - triangle.v0) -
      (triangle.u2 - triangle.u0) * (triangle.v1 - triangle.v0)
    ) / 2;
  }

  private texelDensity(triangle: UvTriangle): number | null {
    const geometry = triangle.mesh.geometry;
    const posAttr = geometry.getAttribute('position');
    if (!posAttr) return null;
    const index = geometry.index;
    const start = triangle.faceIndex * 3;
    const ia = index ? index.getX(start) : start;
    const ib = index ? index.getX(start + 1) : start + 1;
    const ic = index ? index.getX(start + 2) : start + 2;
    triangle.mesh.updateWorldMatrix(true, false);
    const p0 = new THREE.Vector3().fromBufferAttribute(posAttr, ia);
    const p1 = new THREE.Vector3().fromBufferAttribute(posAttr, ib);
    const p2 = new THREE.Vector3().fromBufferAttribute(posAttr, ic);
    triangle.mesh.localToWorld(p0);
    triangle.mesh.localToWorld(p1);
    triangle.mesh.localToWorld(p2);
    const worldArea = new THREE.Triangle(p0, p1, p2).getArea();
    if (!(worldArea > 1e-12)) return null;
    const size = this.getTextureSize() ?? { width: 1024, height: 1024 };
    return Math.sqrt((this.uvArea(triangle) * size.width * size.height) / worldArea);
  }

  private updateUvHud(): void {
    const visible = this.mode === 'uv';
    this.uvHud.classList.toggle('hidden', !visible);
    if (!visible) return;

    if (!this.model) {
      this.uvHudInfo.textContent = '未加载模型';
      this.uvHudDetail.textContent = '打开 FBX 后切换到 UV 查看展开';
      this.uvHudOverlap.textContent = '';
      return;
    }
    if (!this.uvChannels.length) {
      this.uvHudInfo.textContent = '模型没有 UV 数据';
      this.uvHudDetail.textContent = '未找到 uv / uv1 / uv2 属性';
      this.uvHudOverlap.textContent = '';
      return;
    }

    if (this.selectedUvTriangles.length > 1) {
      const totalArea = this.selectedUvTriangles.reduce((sum, triangle) => sum + this.uvArea(triangle), 0);
      this.uvHudInfo.textContent = `${this.uvChannelLabel(this.uvChannel)} · 已选 ${this.selectedUvTriangles.length.toLocaleString()} 个面`;
      this.uvHudDetail.textContent = `UV 总面积 ${totalArea.toExponential(2)} · Shift 加选 · Ctrl 减选 · 左键框选`;
    } else if (this.selectedUv) {
      const triangle = this.selectedUv;
      this.uvHudInfo.textContent = `${this.uvChannelLabel(this.uvChannel)} · 材质 ${triangle.materialIndex + 1} · 面 ${(triangle.faceIndex + 1).toLocaleString()}`;
      const parts = [
        `UV 面积 ${this.uvArea(triangle).toExponential(2)}`,
        triangle.oob ? '越界：是' : '越界：否'
      ];
      const density = this.texelDensity(triangle);
      if (density !== null) {
        const size = this.getTextureSize();
        parts.push(`Texel Density ≈ ${density.toFixed(2)} px/cm${size ? '' : '（按 1024 估算）'}`);
      }
      this.uvHudDetail.textContent = parts.join(' · ');
    } else {
      this.uvHudInfo.textContent = `${this.uvChannelLabel(this.uvChannel)} · ${this.uvTriangles.length.toLocaleString()} 面 · ${this.uvMeshCount} 个网格`;
      this.uvHudDetail.textContent = '滚轮缩放 · Alt+中键平移 · Alt+右键缩放 · 左键点击 / 框选';
    }

    if (this.uvOverlapBusy) {
      this.uvHudOverlap.textContent = '重叠检测中…';
    } else if (this.uvOverlapStats) {
      const { covered, overlap, gridSize } = this.uvOverlapStats;
      const ratio = covered ? (overlap / covered) * 100 : 0;
      const coverage = (covered / (gridSize * gridSize)) * 100;
      this.uvHudOverlap.textContent = `重叠 ${ratio.toFixed(2)}% · UV 覆盖 ${coverage.toFixed(1)}%`;
    } else {
      this.uvHudOverlap.textContent = '';
    }
  }

  private ensureOverlapWorker(): Worker {
    if (!this.overlapWorker) {
      this.overlapWorker = new Worker(new URL('../lib/uv-overlap-worker.ts', import.meta.url), {
        type: 'module'
      });
    }
    return this.overlapWorker;
  }

  private detectOverlap(): void {
    if (!this.uvTriangles.length) {
      this.callbacks.toast('当前 UV 通道没有可检测的面', 'info');
      return;
    }
    this.clearOverlap();
    const coords = new Float32Array(this.uvTriangles.length * 6);
    for (let index = 0; index < this.uvTriangles.length; index += 1) {
      const triangle = this.uvTriangles[index];
      const offset = index * 6;
      coords[offset] = triangle.u0;
      coords[offset + 1] = triangle.v0;
      coords[offset + 2] = triangle.u1;
      coords[offset + 3] = triangle.v1;
      coords[offset + 4] = triangle.u2;
      coords[offset + 5] = triangle.v2;
    }

    const requestId = this.overlapRequestId + 1;
    this.overlapRequestId = requestId;
    this.uvOverlapBusy = true;
    this.updateUvHud();

    try {
      const worker = this.ensureOverlapWorker();
      worker.onmessage = (event: MessageEvent<UvOverlapResponse>) => {
        const result = event.data;
        if (result.requestId !== requestId) return;
        this.uvOverlapBusy = false;
        const texture = new THREE.DataTexture(
          result.data,
          result.gridSize,
          result.gridSize,
          THREE.RGBAFormat
        );
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.flipY = false;
        texture.needsUpdate = true;
        this.uvOverlapTexture?.dispose();
        this.uvOverlapTexture = texture;
        const material = this.uvOverlapMesh.material as THREE.MeshBasicMaterial;
        material.map = texture;
        material.needsUpdate = true;
        this.uvOverlapMesh.visible = true;
        if (this.uvTiles) {
          for (const mesh of this.uvOverlapTileMeshes) mesh.visible = true;
        }
        this.uvOverlapStats = {
          covered: result.covered,
          overlap: result.overlap,
          gridSize: result.gridSize
        };
        this.updateUvHud();
      };
      worker.postMessage(
        { requestId, gridSize: 512, triangles: coords },
        [coords.buffer as ArrayBuffer]
      );
    } catch (error) {
      this.uvOverlapBusy = false;
      this.updateUvHud();
      this.callbacks.toast(
        `重叠检测失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private clearOverlap(): void {
    this.overlapRequestId += 1;
    this.uvOverlapBusy = false;
    this.uvOverlapStats = null;
    this.uvOverlapMesh.visible = false;
    for (const mesh of this.uvOverlapTileMeshes) mesh.visible = false;
    const material = this.uvOverlapMesh.material as THREE.MeshBasicMaterial;
    material.map = null;
    material.needsUpdate = true;
    this.uvOverlapTexture?.dispose();
    this.uvOverlapTexture = null;
    this.updateUvHud();
  }

  private pickUv(clientX: number, clientY: number, additive = false, subtractive = false): void {
    if (!this.uvTriangles.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    const halfW = (this.uvCamera.right - this.uvCamera.left) / 2;
    const halfH = (this.uvCamera.top - this.uvCamera.bottom) / 2;
    const centerX = (this.uvCamera.left + this.uvCamera.right) / 2;
    const centerY = (this.uvCamera.top + this.uvCamera.bottom) / 2;
    const rawU = ((centerX + ndcX * halfW) + 1) / 2;
    const rawV = ((centerY + ndcY * halfH) + 1) / 2;
    // In 2x2 tile mode every quadrant shows a copy of the same UV layout.
    // Fold the click back into the base tile so all four copies are pickable.
    const u = this.uvTiles ? ((rawU % 1) + 1) % 1 : rawU;
    const v = this.uvTiles ? ((rawV % 1) + 1) % 1 : rawV;

    let hit: UvTriangle | null = null;
    for (const triangle of this.uvTriangles) {
      const minU = Math.min(triangle.u0, triangle.u1, triangle.u2);
      const maxU = Math.max(triangle.u0, triangle.u1, triangle.u2);
      const minV = Math.min(triangle.v0, triangle.v1, triangle.v2);
      const maxV = Math.max(triangle.v0, triangle.v1, triangle.v2);
      if (u < minU || u > maxU || v < minV || v > maxV) continue;
      const area = (triangle.u1 - triangle.u0) * (triangle.v2 - triangle.v0) -
        (triangle.u2 - triangle.u0) * (triangle.v1 - triangle.v0);
      if (Math.abs(area) < 1e-12) continue;
      const w0 = ((triangle.u1 - u) * (triangle.v2 - v) - (triangle.u2 - u) * (triangle.v1 - v)) / area;
      const w1 = ((triangle.u2 - u) * (triangle.v0 - v) - (triangle.u0 - u) * (triangle.v2 - v)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-7 && w1 >= -1e-7 && w2 >= -1e-7) {
        hit = triangle;
        break;
      }
    }

    if (hit) this.selectUvTriangle(hit, additive, subtractive);
    else if (!additive && !subtractive) this.clearSelection();
  }

  private selectUvInMarquee(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    additive: boolean,
    subtractive: boolean
  ): void {
    if (!this.uvTriangles.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    const top = Math.min(startY, endY);
    const bottom = Math.max(startY, endY);
    const dragRight = endX >= startX;
    const offsets: Array<[number, number]> = this.uvTiles
      ? [[0, 0], [1, 0], [0, 1], [1, 1]]
      : [[0, 0]];
    const toScreen = (u: number, v: number): { x: number; y: number } => {
      const worldX = u * 2 - 1;
      const worldY = v * 2 - 1;
      return {
        x: rect.left + ((worldX - this.uvCamera.left) / (this.uvCamera.right - this.uvCamera.left)) * rect.width,
        y: rect.top + (1 - (worldY - this.uvCamera.bottom) / (this.uvCamera.top - this.uvCamera.bottom)) * rect.height
      };
    };
    const selected: UvTriangle[] = [];
    for (const triangle of this.uvTriangles) {
      for (const [offsetU, offsetV] of offsets) {
        const points = [
          toScreen(triangle.u0 + offsetU, triangle.v0 + offsetV),
          toScreen(triangle.u1 + offsetU, triangle.v1 + offsetV),
          toScreen(triangle.u2 + offsetU, triangle.v2 + offsetV)
        ];
        const minX = Math.min(points[0].x, points[1].x, points[2].x);
        const maxX = Math.max(points[0].x, points[1].x, points[2].x);
        const minY = Math.min(points[0].y, points[1].y, points[2].y);
        const maxY = Math.max(points[0].y, points[1].y, points[2].y);
        const insideAll = points.every((point) => (
          point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
        ));
        const intersects = maxX >= left && minX <= right && maxY >= top && minY <= bottom;
        if ((dragRight && insideAll) || (!dragRight && intersects)) {
          selected.push(triangle);
          break;
        }
      }
    }
    this.selectUvTriangles(selected, additive, subtractive);
  }

  private select3dInMarquee(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    additive: boolean,
    subtractive: boolean
  ): void {
    if (!this.model) return;
    if (!this.uvDataBuilt) this.ensureUvData();
    if (!this.uvTriangles.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    const top = Math.min(startY, endY);
    const bottom = Math.max(startY, endY);
    const dragRight = endX >= startX;
    this.camera.updateMatrixWorld();
    const selected: UvTriangle[] = [];
    for (const triangle of this.uvTriangles) {
      const world = this.triangleWorldPoints(triangle);
      if (!world) continue;
      const points = world.map((point) => {
        const projected = point.clone().project(this.camera);
        return {
          x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
          y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
          z: projected.z
        };
      });
      if (points.some((point) => point.z < -1 || point.z > 1)) continue;
      const minX = Math.min(points[0].x, points[1].x, points[2].x);
      const maxX = Math.max(points[0].x, points[1].x, points[2].x);
      const minY = Math.min(points[0].y, points[1].y, points[2].y);
      const maxY = Math.max(points[0].y, points[1].y, points[2].y);
      const insideAll = points.every((point) => (
        point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
      ));
      const intersects = maxX >= left && minX <= right && maxY >= top && minY <= bottom;
      if ((dragRight && insideAll) || (!dragRight && intersects)) selected.push(triangle);
    }
    this.selectUvTriangles(selected, additive, subtractive);
  }

  private triangleWorldPoints(triangle: UvTriangle): [THREE.Vector3, THREE.Vector3, THREE.Vector3] | null {
    const geometry = triangle.mesh.geometry;
    const posAttr = geometry.getAttribute('position');
    if (!posAttr) return null;
    const index = geometry.index;
    const start = triangle.faceIndex * 3;
    const ia = index ? index.getX(start) : start;
    const ib = index ? index.getX(start + 1) : start + 1;
    const ic = index ? index.getX(start + 2) : start + 2;
    triangle.mesh.updateWorldMatrix(true, false);
    const p0 = new THREE.Vector3().fromBufferAttribute(posAttr, ia);
    const p1 = new THREE.Vector3().fromBufferAttribute(posAttr, ib);
    const p2 = new THREE.Vector3().fromBufferAttribute(posAttr, ic);
    triangle.mesh.localToWorld(p0);
    triangle.mesh.localToWorld(p1);
    triangle.mesh.localToWorld(p2);
    return [p0, p1, p2];
  }

  private pick3d(clientX: number, clientY: number, additive = false, subtractive = false): void {
    if (!this.modelEntries.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.modelEntries.map((entry) => entry.root), true);
    const hit = hits.find((entry) => (entry.object as THREE.Mesh).isMesh && entry.faceIndex !== undefined);
    if (!hit) {
      if (!additive && !subtractive) this.clearSelection();
      return;
    }
    const hitEntry = this.modelEntries.find((entry) => {
      let cursor: THREE.Object3D | null = hit.object;
      while (cursor) {
        if (cursor === entry.root) return true;
        cursor = cursor.parent;
      }
      return false;
    });
    if (hitEntry && hitEntry.id !== this.activeModelId) this.selectModelEntry(hitEntry.id);
    const model = this.model;
    if (!model) return;
    if (!this.uvDataBuilt) this.ensureUvData();
    const mesh = hit.object as THREE.Mesh;
    const faceIndex = hit.faceIndex ?? -1;
    const triangle = this.uvTriangles.find((entry) => entry.mesh === mesh && entry.faceIndex === faceIndex);
    if (!triangle) {
      this.callbacks.toast(`该面没有 ${this.uvChannelLabel(this.uvChannel)} 数据`, 'info');
      return;
    }
    this.selectUvTriangle(triangle, additive, subtractive);
  }

  private selectUvTriangle(triangle: UvTriangle, additive = false, subtractive = false): void {
    if (subtractive) {
      this.selectedUvTriangles = this.selectedUvTriangles.filter((item) => item !== triangle);
      this.selectedUv = this.selectedUvTriangles[this.selectedUvTriangles.length - 1] ?? null;
    } else if (additive) {
      if (!this.selectedUvTriangles.includes(triangle)) this.selectedUvTriangles.push(triangle);
      this.selectedUv = triangle;
    } else {
      this.selectedUvTriangles = [triangle];
      this.selectedUv = triangle;
    }
    this.rebuildSelectionVisuals();
    this.updateUvHud();
  }

  private selectUvTriangles(triangles: UvTriangle[], additive = false, subtractive = false): void {
    if (subtractive) {
      const removed = new Set(triangles);
      this.selectedUvTriangles = this.selectedUvTriangles.filter((triangle) => !removed.has(triangle));
    } else {
      if (!additive) this.selectedUvTriangles = [];
      const merged = new Set(this.selectedUvTriangles);
      for (const triangle of triangles) merged.add(triangle);
      this.selectedUvTriangles = [...merged];
    }
    this.selectedUv = this.selectedUvTriangles[this.selectedUvTriangles.length - 1] ?? null;
    this.rebuildSelectionVisuals();
    this.updateUvHud();
  }

  private rebuildSelectionVisuals(): void {
    this.clearSelectionVisuals();
    if (!this.selectedUvTriangles.length) return;
    const uvOffsets: Array<[number, number]> = this.uvTiles
      ? [[0, 0], [2, 0], [0, 2], [2, 2]]
      : [[0, 0]];
    const uvFill: number[] = [];
    const uvLines: number[] = [];
    for (const triangle of this.selectedUvTriangles) {
      for (const [offsetX, offsetY] of uvOffsets) {
        const ax = triangle.u0 * 2 - 1 + offsetX;
        const ay = triangle.v0 * 2 - 1 + offsetY;
        const bx = triangle.u1 * 2 - 1 + offsetX;
        const by = triangle.v1 * 2 - 1 + offsetY;
        const cx = triangle.u2 * 2 - 1 + offsetX;
        const cy = triangle.v2 * 2 - 1 + offsetY;
        uvFill.push(ax, ay, 0.2, bx, by, 0.2, cx, cy, 0.2);
        uvLines.push(
          ax, ay, 0.25, bx, by, 0.25,
          bx, by, 0.25, cx, cy, 0.25,
          cx, cy, 0.25, ax, ay, 0.25
        );
      }
    }
    const uvFillGeometry = new THREE.BufferGeometry();
    uvFillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(uvFill, 3));
    const uvFillMesh = new THREE.Mesh(
      uvFillGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x4ade80,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        depthTest: false,
        toneMapped: false
      })
    );
    uvFillMesh.renderOrder = 3;
    this.uvSelectionGroup.add(uvFillMesh);

    const uvLineGeometry = new THREE.BufferGeometry();
    uvLineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(uvLines, 3));
    const uvOutline = new THREE.LineSegments(
      uvLineGeometry,
      new THREE.LineBasicMaterial({ color: 0x22c55e, depthTest: false, toneMapped: false })
    );
    uvOutline.renderOrder = 4;
    this.uvSelectionGroup.add(uvOutline);

    const worldFill: number[] = [];
    const worldLines: number[] = [];
    for (const triangle of this.selectedUvTriangles) {
      const points = this.triangleWorldPoints(triangle);
      if (!points) continue;
      const [p0, p1, p2] = points;
      worldFill.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      worldLines.push(
        p0.x, p0.y, p0.z, p1.x, p1.y, p1.z,
        p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
        p2.x, p2.y, p2.z, p0.x, p0.y, p0.z
      );
    }
    if (worldFill.length) {
      const worldFillGeometry = new THREE.BufferGeometry();
      worldFillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(worldFill, 3));
      const worldFillMesh = new THREE.Mesh(
        worldFillGeometry,
        new THREE.MeshBasicMaterial({
          color: 0x4ade80,
          transparent: true,
          opacity: 0.42,
          side: THREE.DoubleSide,
          depthTest: false,
          toneMapped: false
        })
      );
      worldFillMesh.renderOrder = 999;
      this.modelSelectionGroup.add(worldFillMesh);

      const worldLineGeometry = new THREE.BufferGeometry();
      worldLineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(worldLines, 3));
      const worldOutline = new THREE.LineSegments(
        worldLineGeometry,
        new THREE.LineBasicMaterial({ color: 0x22c55e, depthTest: false, toneMapped: false })
      );
      worldOutline.renderOrder = 1000;
      this.modelSelectionGroup.add(worldOutline);
    }
  }

  private clearSelection(): void {
    this.selectedUvTriangles = [];
    this.clearSelectionVisuals();
    this.selectedUv = null;
    this.updateUvHud();
  }

  private clearSelectionVisuals(): void {
    const disposeGroup = (group: THREE.Group) => {
      for (const child of [...group.children]) {
        const object = child as THREE.Mesh;
        object.geometry?.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
        group.remove(child);
      }
    };
    disposeGroup(this.uvSelectionGroup);
    disposeGroup(this.modelSelectionGroup);
  }

  activate(): void {
    this.active = true;
    this.controls.enabled = this.mode === '3d' && this.altHeld;
    this.updateNavCursor();
    this.resize();
    this.resizeMaterialBall();
    const loop = () => {
      if (!this.active) return;
      if (this.mode === 'uv') {
        this.renderer.render(this.uvScene, this.uvCamera);
      } else {
        this.controls.update();
        if (this.composer) this.composer.render();
        else this.renderer.render(this.scene, this.camera);
      }
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  deactivate(): void {
    this.active = false;
    this.controls.enabled = false;
    this.endNavigation();
    cancelAnimationFrame(this.raf);
  }
}

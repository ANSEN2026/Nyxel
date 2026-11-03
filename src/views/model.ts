import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { ViewCallbacks } from '../types';
import { basename } from '../utils';

type UpAxis = 'y' | 'z';
type UvBackground = 'checker' | 'solid' | 'texture';
type ViewMode = '3d' | 'uv';

const UV_ATTRIBUTES = ['uv', 'uv1', 'uv2', 'uv3'] as const;
const UV_LABELS: Record<string, string> = { uv: 'UV1', uv1: 'UV2', uv2: 'UV3', uv3: 'UV4' };
const UV_COLORS = [
  0x55d6a0, 0x60a5fa, 0xf59e0b, 0xf472b6, 0xa78bfa,
  0x22d3ee, 0xf87171, 0xa3e635, 0xfb923c, 0x38bdf8
];
const UV_OUT_OF_BOUNDS = 0xff5d5d;

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

interface UvOverlapResponse {
  requestId: number;
  gridSize: number;
  covered: number;
  overlap: number;
  data: Uint8Array;
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

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private grid: THREE.GridHelper;
  private refCube: THREE.Group;

  private model: THREE.Object3D | null = null;
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
  private uvDragging = false;
  private uvLastX = 0;
  private uvLastY = 0;
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
  private uvBgMode: UvBackground = 'checker';
  private uvTriangles: UvTriangle[] = [];
  private uvOobCount = 0;
  private uvMeshCount = 0;
  private uvDataBuilt = false;
  private selectedUv: UvTriangle | null = null;
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
          <button data-action="uv-tiles" id="uv-tiles">2×2 象限</button>
          <button data-action="uv-overlap">检测重叠</button>
        </span>
        <span class="muted" id="model-file-label">未加载</span>
      </div>
      <div class="view-body model-body">
        <canvas class="view-canvas"></canvas>
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

    const uColor = new THREE.Color(0x5ee8a0);
    const vColor = new THREE.Color(0x60a5fa);
    const axisGeometry = new THREE.BufferGeometry();
    axisGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -1, 0.07, 1, -1, 0.07,
      -1, -1, 0.07, -1, 1, 0.07
    ], 3));
    axisGeometry.setAttribute('color', new THREE.Float32BufferAttribute([
      uColor.r, uColor.g, uColor.b, uColor.r, uColor.g, uColor.b,
      vColor.r, vColor.g, vColor.b, vColor.r, vColor.g, vColor.b
    ], 3));
    const axisLines = new THREE.LineSegments(
      axisGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        depthTest: false,
        toneMapped: false
      })
    );
    axisLines.renderOrder = 1;

    this.uvScene.add(
      this.uvBgPlane,
      border,
      this.uvTileGrid,
      axisLines,
      this.uvOverlapMesh,
      this.uvLineGroup,
      this.uvSelectionGroup
    );
    this.scene.add(this.modelSelectionGroup);

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.body);
    this.resize();
    this.fitUv();
  }

  private bindEvents(): void {
    this.element.querySelector('[data-action="open"]')?.addEventListener('click', () => void this.pickOpen());
    this.element.querySelector('[data-action="fit"]')?.addEventListener('click', () => this.fitCurrent());
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
    this.element.querySelector('[data-action="uv-overlap"]')?.addEventListener('click', () => {
      this.detectOverlap();
    });
    this.element.querySelector('[data-action="uv-tiles"]')?.addEventListener('click', () => {
      this.uvTiles = !this.uvTiles;
      this.element.querySelector('[data-action="uv-tiles"]')?.classList.toggle('active', this.uvTiles);
      this.updateUvTiles();
      this.fitUv();
      this.updateUvBackground();
    });

    this.canvas.addEventListener('wheel', (event) => {
      if (this.mode !== 'uv') return;
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
    }, { passive: false });

    this.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.pointerDownX = event.clientX;
      this.pointerDownY = event.clientY;
      this.pointerMoved = false;
      if (this.mode === 'uv') {
        this.uvDragging = true;
        this.uvLastX = event.clientX;
        this.uvLastY = event.clientY;
        try {
          this.canvas.setPointerCapture(event.pointerId);
        } catch {
          // synthetic pointer events in automation have no active pointer
        }
      }
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (this.pointerDownX >= 0) {
        if (Math.abs(event.clientX - this.pointerDownX) > 3 || Math.abs(event.clientY - this.pointerDownY) > 3) {
          this.pointerMoved = true;
        }
      }
      if (!this.uvDragging || this.mode !== 'uv') return;
      const rect = this.canvas.getBoundingClientRect();
      const halfW = (this.uvCamera.right - this.uvCamera.left) / 2;
      const halfH = (this.uvCamera.top - this.uvCamera.bottom) / 2;
      const dx = event.clientX - this.uvLastX;
      const dy = event.clientY - this.uvLastY;
      this.uvCenter.x -= (dx / Math.max(1, rect.width)) * halfW * 2;
      this.uvCenter.y += (dy / Math.max(1, rect.height)) * halfH * 2;
      this.uvLastX = event.clientX;
      this.uvLastY = event.clientY;
      this.updateUvCamera();
    });

    const endPointer = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const moved = this.pointerMoved;
      this.uvDragging = false;
      this.pointerDownX = -1;
      this.pointerDownY = -1;
      try {
        if (this.canvas.hasPointerCapture(event.pointerId)) {
          this.canvas.releasePointerCapture(event.pointerId);
        }
      } catch {
        // ignore synthetic pointer events without capture
      }
      if (moved) return;
      if (this.mode === 'uv') this.pickUv(event.clientX, event.clientY);
      else this.pick3d(event.clientX, event.clientY);
    };
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', () => {
      this.uvDragging = false;
      this.pointerDownX = -1;
      this.pointerDownY = -1;
    });
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
    const axis = await this.askAxis('y');
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
        this.showError(`FBX 版本过低：文件声明版本 ${version}，Nyxel v0.1 至少需要 6400。`);
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
    this.disposeModel();
    this.upAxis = axis;
    this.model = object;
    this.originalMaterials = new WeakMap();
    this.generatedMaterials = [];

    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.originalMaterials.set(mesh, mesh.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    this.scene.add(object);
    this.uvDataBuilt = false;
    this.refreshUvChannels();
    this.setUpAxis(axis, false);
    this.rebuildMaterials();
    this.fit();

    if (this.mode === 'uv') {
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
    if (this.model) {
      this.model.rotation.x = axis === 'z' ? -Math.PI / 2 : 0;
      this.model.updateMatrixWorld(true);
    }
    this.clearSelection();
    this.element.querySelectorAll('[data-up]').forEach((button) => {
      button.classList.toggle('active', (button as HTMLElement).dataset.up === axis);
    });
    if (doFit) this.fit();
    this.updateStats();
  }

  private rebuildMaterials(): void {
    this.generatedMaterials.forEach((material) => material.dispose());
    this.generatedMaterials = [];
    if (!this.model) return;

    this.model.traverse((child) => {
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
        if (this.externalTexture) {
          const textured = next as THREE.MeshStandardMaterial;
          textured.map = this.externalTexture;
          if (textured.color) textured.color.set(0xffffff);
        }
        next.needsUpdate = true;
        this.generatedMaterials.push(next);
        return next;
      };
      mesh.material = Array.isArray(original) ? original.map(build) : build(original);
    });
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
    if (!this.model) return;
    const box = this.boundingBox(this.model);
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
    const width = Math.max(1, this.body.clientWidth);
    const height = Math.max(1, this.body.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.updateUvCamera();
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
    this.clearUvData();
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach((material) => {
          const map = (material as THREE.MeshStandardMaterial).map;
          if (map) map.dispose();
          material.dispose();
        });
      }
    });
    if (this.externalTexture) {
      this.externalTexture.dispose();
      this.externalTexture = null;
    }
    this.generatedMaterials = [];
    this.model = null;
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
          context.fillStyle = (x / cell + y / cell) % 2 === 0 ? '#151a22' : '#0d1117';
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
    this.controls.enabled = mode === '3d';
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
    const materialColors = new Map<THREE.Material, THREE.Color>();
    const outOfBounds = new THREE.Color(UV_OUT_OF_BOUNDS);
    let colorIndex = 0;

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
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
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
        const material = (materials[Math.min(materialIndex, materials.length - 1)] ?? materials[0]) as THREE.Material;
        let faceColor = materialColors.get(material);
        if (!faceColor) {
          faceColor = new THREE.Color(UV_COLORS[colorIndex % UV_COLORS.length]);
          materialColors.set(material, faceColor);
          colorIndex += 1;
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
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
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

    if (this.selectedUv) {
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
      this.uvHudDetail.textContent = '滚轮缩放 · 拖拽平移 · 点击选择 UV 面';
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

  private pickUv(clientX: number, clientY: number): void {
    if (!this.uvTriangles.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    const halfW = (this.uvCamera.right - this.uvCamera.left) / 2;
    const halfH = (this.uvCamera.top - this.uvCamera.bottom) / 2;
    const centerX = (this.uvCamera.left + this.uvCamera.right) / 2;
    const centerY = (this.uvCamera.top + this.uvCamera.bottom) / 2;
    const u = ((centerX + ndcX * halfW) + 1) / 2;
    const v = ((centerY + ndcY * halfH) + 1) / 2;

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

    if (hit) this.selectUvTriangle(hit);
    else this.clearSelection();
  }

  private pick3d(clientX: number, clientY: number): void {
    const model = this.model;
    if (!model) return;
    if (!this.uvDataBuilt) this.ensureUvData();
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(model, true);
    const hit = hits.find((entry) => (entry.object as THREE.Mesh).isMesh && entry.faceIndex !== undefined);
    if (!hit) {
      this.clearSelection();
      return;
    }
    const mesh = hit.object as THREE.Mesh;
    const faceIndex = hit.faceIndex ?? -1;
    const triangle = this.uvTriangles.find((entry) => entry.mesh === mesh && entry.faceIndex === faceIndex);
    if (!triangle) {
      this.callbacks.toast(`该面没有 ${this.uvChannelLabel(this.uvChannel)} 数据`, 'info');
      return;
    }
    this.selectUvTriangle(triangle);
  }

  private selectUvTriangle(triangle: UvTriangle): void {
    this.clearSelectionVisuals();
    this.selectedUv = triangle;

    const uvGeometry = new THREE.BufferGeometry();
    uvGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      triangle.u0 * 2 - 1, triangle.v0 * 2 - 1, 0.2,
      triangle.u1 * 2 - 1, triangle.v1 * 2 - 1, 0.2,
      triangle.u2 * 2 - 1, triangle.v2 * 2 - 1, 0.2
    ], 3));
    const uvFill = new THREE.Mesh(
      uvGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x8affc1,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthTest: false,
        toneMapped: false
      })
    );
    uvFill.renderOrder = 3;
    this.uvSelectionGroup.add(uvFill);

    const uvOutline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(triangle.u0 * 2 - 1, triangle.v0 * 2 - 1, 0.25),
        new THREE.Vector3(triangle.u1 * 2 - 1, triangle.v1 * 2 - 1, 0.25),
        new THREE.Vector3(triangle.u2 * 2 - 1, triangle.v2 * 2 - 1, 0.25)
      ]),
      new THREE.LineBasicMaterial({ color: 0xc4ffe0, depthTest: false, toneMapped: false })
    );
    uvOutline.renderOrder = 4;
    this.uvSelectionGroup.add(uvOutline);

    const geometry = triangle.mesh.geometry;
    const posAttr = geometry.getAttribute('position');
    if (posAttr) {
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

      const worldGeometry = new THREE.BufferGeometry();
      worldGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
        p0.x, p0.y, p0.z,
        p1.x, p1.y, p1.z,
        p2.x, p2.y, p2.z
      ], 3));
      const worldFill = new THREE.Mesh(
        worldGeometry,
        new THREE.MeshBasicMaterial({
          color: 0x8affc1,
          transparent: true,
          opacity: 0.4,
          side: THREE.DoubleSide,
          depthTest: false,
          toneMapped: false
        })
      );
      worldFill.renderOrder = 999;
      this.modelSelectionGroup.add(worldFill);

      const worldOutline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([p0, p1, p2]),
        new THREE.LineBasicMaterial({ color: 0xc4ffe0, depthTest: false, toneMapped: false })
      );
      worldOutline.renderOrder = 1000;
      this.modelSelectionGroup.add(worldOutline);
    }

    this.updateUvHud();
  }

  private clearSelection(): void {
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
    this.selectedUv = null;
  }

  activate(): void {
    this.active = true;
    this.resize();
    const loop = () => {
      if (!this.active) return;
      if (this.mode === 'uv') {
        this.renderer.render(this.uvScene, this.uvCamera);
      } else {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
      }
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

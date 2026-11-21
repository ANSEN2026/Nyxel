import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SkeletonAnimation } from '../../electron/motion_capture/contracts';

type TimeListener = (time: number, duration: number) => void;

export class SkeletonPreview {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly jointMaterial: THREE.MeshStandardMaterial;
  private readonly lineMaterial: THREE.LineBasicMaterial;
  private readonly sphereGeometry: THREE.SphereGeometry;

  private animation: SkeletonAnimation | null = null;
  private jointObjects: THREE.Object3D[] = [];
  private jointMeshes: THREE.Mesh[] = [];
  private line: THREE.LineSegments | null = null;
  private linePositions: Float32Array | null = null;
  private connections: Array<[number, number]> = [];
  private time = 0;
  private playing = false;
  private raf = 0;
  private active = false;
  private lastTimestamp = 0;
  private onTime: TimeListener | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'motion-preview-renderer';
    host.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x101b18, 0.16);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
    this.camera.position.set(1.65, 1.25, 2.35);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.88, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.1;
    this.controls.maxDistance = 6;
    this.controls.maxPolarAngle = Math.PI * 0.94;

    const ambient = new THREE.HemisphereLight(0xc9ffe9, 0x0a1512, 1.8);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 3.5, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x54d6a0, 1.1);
    rim.position.set(-2.5, 1.2, -2);
    this.scene.add(rim);

    const grid = new THREE.GridHelper(3.4, 17, 0x2a6553, 0x1a332b);
    grid.position.y = 0;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    this.jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x9df2cf,
      emissive: 0x123c30,
      roughness: 0.35,
      metalness: 0.1
    });
    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0x8be8c2,
      transparent: true,
      opacity: 0.92
    });
    this.sphereGeometry = new THREE.SphereGeometry(0.021, 10, 10);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
  }

  setOnTime(listener: TimeListener | null): void {
    this.onTime = listener;
    if (this.animation) listener?.(this.time, this.animation.duration);
  }

  setAnimation(animation: SkeletonAnimation): void {
    this.clearSkeleton();
    this.animation = animation;
    this.time = 0;
    const jointObjects = animation.joints.map((joint) => {
      const object = new THREE.Object3D();
      object.position.set(joint.offset[0], joint.offset[1], joint.offset[2]);
      return object;
    });
    this.jointObjects = jointObjects;
    this.connections = [];
    animation.joints.forEach((joint, index) => {
      if (joint.parent >= 0 && joint.parent < jointObjects.length) {
        jointObjects[joint.parent].add(jointObjects[index]);
        this.connections.push([index, joint.parent]);
      } else {
        this.scene.add(jointObjects[index]);
      }
    });

    this.jointMeshes = jointObjects.map(() => {
      const mesh = new THREE.Mesh(this.sphereGeometry, this.jointMaterial);
      this.scene.add(mesh);
      return mesh;
    });

    const lineGeometry = new THREE.BufferGeometry();
    this.linePositions = new Float32Array(this.connections.length * 6);
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.line = new THREE.LineSegments(lineGeometry, this.lineMaterial);
    this.scene.add(this.line);

    this.setTime(0);
    this.play();
  }

  clear(): void {
    this.pause();
    this.animation = null;
    this.time = 0;
    this.clearSkeleton();
    this.onTime?.(0, 0);
  }

  play(): void {
    if (!this.animation) return;
    if (this.time >= this.animation.duration) this.time = 0;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): boolean {
    if (this.playing) this.pause();
    else this.play();
    return this.playing;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setTime(time: number): void {
    if (!this.animation || this.animation.frames.length === 0) return;
    const duration = this.animation.duration;
    this.time = Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0));
    const frameIndex = Math.min(
      this.animation.frames.length - 1,
      Math.max(0, Math.floor(this.time * this.animation.fps + 1e-6))
    );
    const frame = this.animation.frames[frameIndex];
    for (let index = 0; index < this.jointObjects.length; index += 1) {
      const object = this.jointObjects[index];
      const joint = this.animation.joints[index];
      const pose = frame.poses[index];
      object.position.set(
        joint.offset[0] + pose.translation[0],
        joint.offset[1] + pose.translation[1],
        joint.offset[2] + pose.translation[2]
      );
      object.quaternion.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
    }
    this.scene.updateMatrixWorld(true);
    this.syncMeshes();
    this.onTime?.(this.time, duration);
  }

  activate(): void {
    this.active = true;
    this.resize();
    this.startLoop();
  }

  deactivate(): void {
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.deactivate();
    this.observer.disconnect();
    this.clearSkeleton();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearSkeleton(): void {
    for (const object of this.jointObjects) object.removeFromParent();
    for (const mesh of this.jointMeshes) {
      mesh.removeFromParent();
    }
    if (this.line) {
      this.line.removeFromParent();
      this.line.geometry.dispose();
      this.line = null;
    }
    this.jointObjects = [];
    this.jointMeshes = [];
    this.linePositions = null;
    this.connections = [];
  }

  private syncMeshes(): void {
    if (!this.animation || !this.line || !this.linePositions) return;
    const position = new THREE.Vector3();
    for (let index = 0; index < this.jointObjects.length; index += 1) {
      this.jointObjects[index].getWorldPosition(position);
      this.jointMeshes[index].position.copy(position);
    }
    let cursor = 0;
    for (const [child, parent] of this.connections) {
      this.jointObjects[child].getWorldPosition(position);
      this.linePositions[cursor] = position.x;
      this.linePositions[cursor + 1] = position.y;
      this.linePositions[cursor + 2] = position.z;
      this.jointObjects[parent].getWorldPosition(position);
      this.linePositions[cursor + 3] = position.x;
      this.linePositions[cursor + 4] = position.y;
      this.linePositions[cursor + 5] = position.z;
      cursor += 6;
    }
    const attribute = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
  }

  private startLoop(): void {
    if (this.raf) return;
    this.lastTimestamp = performance.now();
    const tick = (now: number): void => {
      if (!this.active) {
        this.raf = 0;
        return;
      }
      this.raf = requestAnimationFrame(tick);
      const delta = Math.min(0.1, (now - this.lastTimestamp) / 1000);
      this.lastTimestamp = now;
      if (this.playing && this.animation) {
        let next = this.time + delta;
        if (next > this.animation.duration) next = 0;
        this.setTime(next);
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}

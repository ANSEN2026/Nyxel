export const SKELETON_ID = 'humanoid-24';

export const MOTION_STAGES = [
  'decode',
  'detect',
  'track',
  'pose2d',
  'pose3d',
  'cleanup',
  'export'
] as const;

export type MotionStage = (typeof MOTION_STAGES)[number];
export type MotionFormat = 'bvh' | 'fbx';
export type MotionDevice = 'cpu' | 'cuda' | 'mps';
export type MotionProviderKind = 'mock' | 'sidecar';

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export interface MotionCaptureJob {
  jobId: string;
  inputPath: string;
  fps: number;
  targetRig: string;
  createdAt: string;
}

export interface MotionCaptureProgress {
  jobId: string;
  stage: MotionStage;
  percent: number;
  message: string;
}

export interface MotionCaptureResult {
  jobId: string;
  format: MotionFormat;
  outputPath: string;
  fps: number;
  duration: number;
  skeletonId: string;
  hasRootMotion: boolean;
  warnings: string[];
}

export type MotionCaptureErrorCode =
  | 'INPUT_NOT_FOUND'
  | 'SIDECAR_NOT_FOUND'
  | 'SIDECAR_CRASHED'
  | 'SIDECAR_PROTOCOL'
  | 'SIDECAR_DEPS_MISSING'
  | 'MODEL_NOT_FOUND'
  | 'NO_PERSON_DETECTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNSUPPORTED_FORMAT'
  | 'EXPORT_FAILED'
  | 'INTERNAL_ERROR';

export class MotionCaptureError extends Error {
  readonly code: MotionCaptureErrorCode;

  constructor(code: MotionCaptureErrorCode, message: string) {
    super(message);
    this.name = 'MotionCaptureError';
    this.code = code;
  }
}

export interface MotionCaptureConfig {
  version: 1;
  provider: MotionProviderKind;
  modelDir: string;
  device: MotionDevice;
  outputFormat: MotionFormat;
  fps: number;
  keepRootMotion: boolean;
  outputDir: string;
  pythonPath: string;
  timeoutSeconds: number;
}

export interface MotionCaptureRuntime {
  ok: boolean;
  provider: MotionProviderKind;
  pythonPath: string;
  pythonVersion?: string;
  mediapipeVersion?: string;
  opencvVersion?: string;
  message?: string;
  missing?: string[];
}

export interface SkeletonJoint {
  name: string;
  parent: number;
  offset: Vec3;
}

export interface JointPose {
  rotation: Quaternion;
  translation: Vec3;
}

export interface SkeletonFrame {
  time: number;
  poses: JointPose[];
}

export interface SkeletonAnimation {
  skeletonId: string;
  fps: number;
  duration: number;
  joints: SkeletonJoint[];
  frames: SkeletonFrame[];
  hasRootMotion: boolean;
}

export interface MotionCaptureOptions {
  format: MotionFormat;
  outputDir: string;
  keepRootMotion: boolean;
  device: MotionDevice;
  modelDir: string;
  timeoutMs: number;
  logPath: string;
}

export interface MotionCaptureContext {
  onProgress: (progress: MotionCaptureProgress) => void;
  log: (message: string) => void;
  isCancelled: () => boolean;
}

export interface MotionCaptureProvider {
  readonly id: string;
  run(
    job: MotionCaptureJob,
    options: MotionCaptureOptions,
    context: MotionCaptureContext
  ): Promise<MotionCaptureResult>;
  cancel(jobId: string): Promise<boolean>;
  getPreview(jobId: string): Promise<SkeletonAnimation | null>;
}

export interface MotionCaptureRunOptions {
  inputPath: string;
  fps?: number;
  targetRig?: string;
}

export interface MotionCaptureRunResponse {
  ok: boolean;
  jobId: string;
  result?: MotionCaptureResult;
  error?: string;
  code?: MotionCaptureErrorCode;
  cancelled?: boolean;
  logPath: string;
}

export interface MotionCaptureExportResponse {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

export interface MotionCaptureLogResponse {
  ok: boolean;
  jobId: string;
  path: string;
  content: string;
  error?: string;
}

/**
 * 24 joints = 21 joints from the product spec, plus a root joint for root
 * motion and two clavicle connectors. All product-spec names are present.
 */
export const HUMANOID_JOINTS: readonly SkeletonJoint[] = [
  { name: 'root', parent: -1, offset: [0, 0, 0] },
  { name: 'hips', parent: 0, offset: [0, 0.95, 0] },
  { name: 'spine', parent: 1, offset: [0, 0.12, 0] },
  { name: 'chest', parent: 2, offset: [0, 0.18, 0] },
  { name: 'neck', parent: 3, offset: [0, 0.2, 0] },
  { name: 'head', parent: 4, offset: [0, 0.11, 0] },
  { name: 'l_clavicle', parent: 3, offset: [0.04, 0.16, 0] },
  { name: 'l_shoulder', parent: 6, offset: [0.08, 0.02, 0] },
  { name: 'l_upperarm', parent: 7, offset: [0.04, 0, 0] },
  { name: 'l_forearm', parent: 8, offset: [0, -0.28, 0] },
  { name: 'l_hand', parent: 9, offset: [0, -0.25, 0] },
  { name: 'r_clavicle', parent: 3, offset: [-0.04, 0.16, 0] },
  { name: 'r_shoulder', parent: 11, offset: [-0.08, 0.02, 0] },
  { name: 'r_upperarm', parent: 12, offset: [-0.04, 0, 0] },
  { name: 'r_forearm', parent: 13, offset: [0, -0.28, 0] },
  { name: 'r_hand', parent: 14, offset: [0, -0.25, 0] },
  { name: 'l_upperleg', parent: 1, offset: [0.09, -0.06, 0] },
  { name: 'l_lowerleg', parent: 16, offset: [0, -0.42, 0] },
  { name: 'l_foot', parent: 17, offset: [0, -0.4, 0] },
  { name: 'l_toe', parent: 18, offset: [0, -0.02, 0.12] },
  { name: 'r_upperleg', parent: 1, offset: [-0.09, -0.06, 0] },
  { name: 'r_lowerleg', parent: 20, offset: [0, -0.42, 0] },
  { name: 'r_foot', parent: 21, offset: [0, -0.4, 0] },
  { name: 'r_toe', parent: 22, offset: [0, -0.02, 0.12] }
];

export const HUMANOID_JOINT_COUNT = HUMANOID_JOINTS.length;

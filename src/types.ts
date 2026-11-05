export type ViewName = 'home' | 'texture' | 'model' | 'color' | 'gallery' | 'textures' | 'video' | 'videos' | 'draw';
export type Theme = 'dark' | 'light' | 'system';
export type UpdateChannel = 'stable' | 'beta';

export interface RecentProject {
  type: 'texture' | 'model';
  path: string;
  name: string;
  time: number;
}

export interface Settings {
  schemaVersion: 2;
  theme: Theme;
  language: 'zh' | 'en' | 'system';
  exportDir: string;
  screenshotDir: string;
  videoNoteDir: string;
  audioVisualizer: boolean;
  restoreWorkspace: boolean;
  hardwareAcceleration: boolean;
  cacheDir: string;
  ffmpegPath: string;
  screenshotHotkey: string;
  updateChannel: UpdateChannel;
  colorCount: number;
  colorRatioMode: 'perceptual' | 'pixel';
  colorIgnoreNearBW: boolean;
  colorAlphaThreshold: number;
  recentProjects: RecentProject[];
}

export interface AiProgress {
  phase: 'download' | 'extract' | 'upscale' | 'done' | 'error';
  percent: number;
  message?: string;
}

export type AiEngine = 'realesrgan' | 'upscayl';

export interface AiStatus {
  engine: AiEngine;
  model?: string;
  available: boolean;
  dir: string;
  downloading: boolean;
  progress?: AiProgress;
}

export interface AiDownloadResult {
  ok: boolean;
  error?: string;
  status: AiStatus;
}

export interface AiUpscaleResult {
  ok: boolean;
  data?: Uint8Array;
  width?: number;
  height?: number;
  error?: string;
}

export interface UpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  latestTag?: string;
  hasUpdate?: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  publishedAt?: string;
  channel?: string;
  message?: string;
  error?: string;
}

export type VideoCodec = 'h264' | 'h265' | 'copy';
export type VideoResolution = 'source' | '1080' | '720' | '480';
export type VideoFps = 'source' | '60' | '30' | '24';
export type VideoAudio = 'aac192' | 'aac128' | 'aac96' | 'copy' | 'none';

export interface VideoInfo {
  path: string;
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec?: string;
  bitrate?: number;
}

export interface VideoProgress {
  phase: 'download' | 'extract' | 'probe' | 'compress' | 'done' | 'error';
  percent: number;
  message?: string;
  speed?: string;
  currentTime?: number;
  duration?: number;
}

export interface VideoStatus {
  available: boolean;
  dir: string;
  defaultOutputDir: string;
  downloading: boolean;
  progress?: VideoProgress;
}

export interface VideoDownloadResult {
  ok: boolean;
  error?: string;
  status: VideoStatus;
}

export interface VideoProbeResult {
  ok: boolean;
  info?: VideoInfo;
  error?: string;
}

export interface VideoCompressOptions {
  input: string;
  outputDir: string;
  codec: VideoCodec;
  crf: number;
  preset: string;
  resolution: VideoResolution;
  fps: VideoFps;
  audio: VideoAudio;
}

export interface VideoCompressResult {
  ok: boolean;
  output?: string;
  size?: number;
  error?: string;
  cancelled?: boolean;
}

export interface LibraryFile {
  name: string;
  path: string;
  relative: string;
  size: number;
  mtime: number;
  thumbnail?: string;
}

export interface LibraryFolder {
  name: string;
  relative: string;
  depth: number;
  count: number;
  color?: string;
}

export interface LibraryInfo {
  root: string;
  galleryDir: string;
  texturesDir: string;
  videosDir: string;
}

export interface LibraryGallery {
  root: string;
  files: LibraryFile[];
}

export interface LibraryTextures {
  root: string;
  current: string;
  total: number;
  folders: LibraryFolder[];
  files: LibraryFile[];
}

export interface LibraryVideos {
  root: string;
  files: LibraryFile[];
}

export interface VideoNoteMeta {
  path: string;
  fileName: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoNoteImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoNoteDocument {
  version: 1;
  videoPath: string;
  videoName: string;
  createdAt: string;
  updatedAt: string;
  text: string;
  textHtml: string;
  drawing: string;
  image?: string;
  imageRect?: VideoNoteImageRect;
  canvasWidth?: number;
  canvasHeight?: number;
}

export interface AccountUser {
  email: string;
  displayName: string;
  createdAt: string;
  signedInAt: string;
}

export interface AccountState {
  hasAccount: boolean;
  user: AccountUser | null;
  email?: string;
  storagePath: string;
}

export interface AccountActionResult {
  ok: boolean;
  state?: AccountState;
  error?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  settingsPath: string;
  exportDir: string;
  cacheDir: string;
  hotkeyRegistered: boolean;
  windowsStore: boolean;
}

export interface NyxelApi {
  platform: string;
  test: { noRestoreWorkspace: boolean };
  versions: { electron: string; chrome: string; node: string };
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    isMaximized: () => Promise<boolean>;
    close: () => Promise<void>;
  };
  dialog: {
    openImage: () => Promise<string | null>;
    openModel: () => Promise<string | null>;
    openVideo: () => Promise<string | null>;
    openDirectory: () => Promise<string | null>;
  };
  file: {
    read: (filePath: string) => Promise<Uint8Array>;
    openProject: (filePath?: string) => Promise<{ path: string; data: Uint8Array } | null>;
    savePng: (data: Uint8Array, suggestedName: string) => Promise<string | null>;
    saveProject: (data: Uint8Array, suggestedName: string) => Promise<string | null>;
    saveVideo: (data: Uint8Array, suggestedName: string, extension: 'mp4' | 'webm') => Promise<string | null>;
  };
  settings: {
    load: () => Promise<Settings>;
    save: (settings: Settings) => Promise<Settings>;
  };
  account: {
    status: () => Promise<AccountState>;
    register: (input: { email: string; password: string; displayName?: string }) => Promise<AccountActionResult>;
    login: (input: { email: string; password: string }) => Promise<AccountActionResult>;
    logout: () => Promise<AccountActionResult>;
    reset: () => Promise<AccountActionResult>;
  };
  app: {
    info: () => Promise<AppInfo>;
    openPath: (target: string) => Promise<string>;
    showItemInFolder: (target: string) => Promise<void>;
    clearCache: () => Promise<boolean>;
  };
  update: {
    check: () => Promise<UpdateCheckResult>;
  };
  video: {
    status: () => Promise<VideoStatus>;
    download: () => Promise<VideoDownloadResult>;
    probe: (path: string) => Promise<VideoProbeResult>;
    compress: (options: VideoCompressOptions) => Promise<VideoCompressResult>;
    cancel: () => Promise<boolean>;
    onProgress: (callback: (progress: VideoProgress) => void) => () => void;
  };
  screenshot: {
    capture: () => Promise<{ ok: boolean; path?: string; copied?: boolean; error?: string; cancelled?: boolean }>;
    setHotkey: (accelerator: string) => Promise<{ ok: boolean; accelerator: string }>;
    onDone: (callback: (data: { ok: boolean; path?: string; copied?: boolean; error?: string; cancelled?: boolean }) => void) => () => void;
  };
  ai: {
    status: (engine: AiEngine, model?: string) => Promise<AiStatus>;
    download: (engine: AiEngine, model?: string) => Promise<AiDownloadResult>;
    upscale: (data: Uint8Array, scale: number, engine: AiEngine, model?: string) => Promise<AiUpscaleResult>;
    cancel: () => Promise<boolean>;
    onProgress: (callback: (progress: AiProgress) => void) => () => void;
  };
  library: {
    info: () => Promise<LibraryInfo>;
    gallery: () => Promise<LibraryGallery>;
    textures: (folder: string) => Promise<LibraryTextures>;
    createFolder: (parent: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    importTextures: (folder: string) => Promise<{ ok: boolean; imported?: number; cancelled?: boolean; error?: string }>;
    videos: () => Promise<LibraryVideos>;
    importVideos: () => Promise<{ ok: boolean; imported?: number; cancelled?: boolean; error?: string }>;
    moveFolder: (source: string, targetParent: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    setFolderColor: (folder: string, color: string | null) => Promise<{ ok: boolean; error?: string }>;
    deleteFolder: (folder: string) => Promise<{ ok: boolean; error?: string }>;
    openFolder: (folder: string) => Promise<{ ok: boolean; error?: string }>;
    showFolder: (folder: string) => Promise<void>;
    moveVideo: (filePath: string, destinationDir: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    mediaUrl: (filePath: string) => string;
    delete: (target: string) => Promise<{ ok: boolean; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  notes: {
    list: (videoPath: string) => Promise<{ ok: boolean; dir: string; notes: VideoNoteMeta[]; error?: string }>;
    create: (videoPath: string) => Promise<{ ok: boolean; note?: VideoNoteDocument; path?: string; error?: string }>;
    read: (notePath: string) => Promise<{ ok: boolean; note?: VideoNoteDocument; path?: string; error?: string }>;
    save: (notePath: string, updates: { text?: string; textHtml?: string; drawing?: string; image?: string; imageRect?: VideoNoteImageRect; canvasWidth?: number; canvasHeight?: number }) => Promise<{ ok: boolean; note?: VideoNoteDocument; path?: string; error?: string }>;
    delete: (notePath: string) => Promise<{ ok: boolean; error?: string }>;
    openDir: () => Promise<{ ok: boolean; dir: string; error?: string }>;
  };
  audio: {
    source: () => Promise<{ id: string; name: string } | null>;
  };
}

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastApi {
  (message: string, kind?: ToastKind): void;
}

export interface StatusApi {
  set(file?: string, info?: string, log?: string): void;
}

export interface ViewCallbacks {
  openTexturePath: (path: string) => Promise<void>;
  openModelPath: (path: string) => Promise<void>;
  pushRecent: (type: 'texture' | 'model', path: string, name: string) => void;
  toast: ToastApi;
  status: StatusApi;
}

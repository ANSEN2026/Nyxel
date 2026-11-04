export type ViewName = 'home' | 'texture' | 'model' | 'color' | 'gallery' | 'textures';
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
}

export interface LibraryInfo {
  root: string;
  galleryDir: string;
  texturesDir: string;
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

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  settingsPath: string;
  exportDir: string;
  cacheDir: string;
  hotkeyRegistered: boolean;
}

export interface NyxelApi {
  platform: string;
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
    openDirectory: () => Promise<string | null>;
  };
  file: {
    read: (filePath: string) => Promise<Uint8Array>;
    savePng: (data: Uint8Array, suggestedName: string) => Promise<string | null>;
  };
  settings: {
    load: () => Promise<Settings>;
    save: (settings: Settings) => Promise<Settings>;
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
    delete: (target: string) => Promise<{ ok: boolean; error?: string }>;
    onChanged: (callback: () => void) => () => void;
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

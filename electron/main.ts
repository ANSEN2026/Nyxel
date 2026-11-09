import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as httpFetch, type Dispatcher } from 'undici';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { unzipSync } from 'fflate';
import { extractText } from 'unpdf';

// Keep the existing AppData folder name after the Texture map rename so
// downloaded ffmpeg / AI runtimes and Chromium caches survive upgrades.
const userDataOverride = process.env.NYXEL_USER_DATA_DIR;
app.setPath(
  'userData',
  userDataOverride ? path.resolve(userDataOverride) : path.join(app.getPath('appData'), 'Nyxel')
);

type Theme = 'dark' | 'light' | 'system';
type UpdateChannel = 'stable' | 'beta';

interface RecentProject {
  type: 'texture' | 'model';
  path: string;
  name: string;
  time: number;
}

interface Settings {
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

interface StoredLocalAccount {
  version: 1;
  email: string;
  displayName: string;
  createdAt: string;
  signedInAt?: string;
  password: {
    algorithm: 'scrypt';
    salt: string;
    hash: string;
  };
}

interface AccountUser {
  email: string;
  displayName: string;
  createdAt: string;
  signedInAt: string;
}

interface AccountState {
  hasAccount: boolean;
  user: AccountUser | null;
  email?: string;
  storagePath: string;
}

interface AccountActionResult {
  ok: boolean;
  state?: AccountState;
  error?: string;
}

interface CaptureResult {
  ok: boolean;
  path?: string;
  copied?: boolean;
  error?: string;
  cancelled?: boolean;
}

interface AiProgress {
  phase: 'download' | 'extract' | 'upscale' | 'done' | 'error';
  percent: number;
  message?: string;
}

type AiEngine = 'realesrgan' | 'upscayl';

interface AiStatus {
  engine: AiEngine;
  model?: string;
  available: boolean;
  dir: string;
  downloading: boolean;
  progress?: AiProgress;
}

interface AiUpscaleResult {
  ok: boolean;
  data?: Uint8Array;
  width?: number;
  height?: number;
  error?: string;
}

interface SelectorSession {
  display: Electron.Display;
  image: Electron.NativeImage;
}

let mainWindow: BrowserWindow | null = null;
let currentHotkey = '';
let hotkeyRegistered = false;
let selectorWindows: BrowserWindow[] = [];
const selectorSessions = new Map<number, SelectorSession>();
let selectorResolver: ((result: CaptureResult) => void) | null = null;
let editorWindow: BrowserWindow | null = null;
let captureInEditor = false;
let editorCommitted = false;
let aiDownloading = false;
let aiProgress: AiProgress | null = null;
let aiProcess: ChildProcess | null = null;
let aiCancelled = false;

function settingsFile(): string {
  return path.join(app.getPath('appData'), 'Nyxel', 'settings.json');
}

function defaultSettings(): Settings {
  return {
    schemaVersion: 2,
    theme: 'dark',
    language: 'system',
    exportDir: path.join(app.getPath('documents'), 'Nyxel'),
    screenshotDir: path.join(app.getPath('documents'), 'Nyxel', 'Screenshots'),
    videoNoteDir: path.join(app.getPath('userData'), 'VideoNotes'),
    audioVisualizer: true,
    restoreWorkspace: false,
    hardwareAcceleration: true,
    cacheDir: path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Nyxel', 'cache'),
    ffmpegPath: '',
    screenshotHotkey: 'Ctrl+Alt+A',
    updateChannel: 'stable',
    colorCount: 6,
    colorRatioMode: 'perceptual',
    colorIgnoreNearBW: true,
    colorAlphaThreshold: 0.05,
    recentProjects: []
  };
}

function saveSettings(settings: Settings): void {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(settings, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, payload, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, payload, 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

function loadSettings(): Settings {
  const defaults = defaultSettings();
  const file = settingsFile();
  try {
    if (!fs.existsSync(file)) {
      saveSettings(defaults);
      return defaults;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    const merged: Settings = {
      ...defaults,
      ...parsed,
      schemaVersion: 2,
      recentProjects: Array.isArray(parsed.recentProjects)
        ? parsed.recentProjects.filter((item): item is RecentProject => Boolean(item && item.type && item.path && item.name)).slice(0, 8)
        : []
    };
    return merged;
  } catch {
    try {
      fs.copyFileSync(file, path.join(path.dirname(file), 'settings.broken.json'));
    } catch {
      // ignore backup failure
    }
    return defaults;
  }
}

function localAccountFile(): string {
  return path.join(app.getPath('userData'), 'account.json');
}

function readLocalAccount(): StoredLocalAccount | null {
  const file = localAccountFile();
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredLocalAccount>;
    if (
      parsed.version !== 1 ||
      typeof parsed.email !== 'string' ||
      typeof parsed.displayName !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      !parsed.password ||
      parsed.password.algorithm !== 'scrypt' ||
      typeof parsed.password.salt !== 'string' ||
      typeof parsed.password.hash !== 'string'
    ) {
      return null;
    }
    return {
      version: 1,
      email: parsed.email,
      displayName: parsed.displayName,
      createdAt: parsed.createdAt,
      signedInAt: typeof parsed.signedInAt === 'string' ? parsed.signedInAt : undefined,
      password: parsed.password
    };
  } catch {
    return null;
  }
}

function writeLocalAccount(account: StoredLocalAccount): void {
  const file = localAccountFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify(account, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, payload, 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

function localAccountState(): AccountState {
  const account = readLocalAccount();
  return {
    hasAccount: Boolean(account),
    user: account?.signedInAt
      ? {
          email: account.email,
          displayName: account.displayName,
          createdAt: account.createdAt,
          signedInAt: account.signedInAt
        }
      : null,
    email: account?.email,
    storagePath: localAccountFile()
  };
}

function normaliseAccountEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isAccountEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function accountDisplayName(value: unknown, email: string): string {
  const cleaned = Array.from(
    String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  ).slice(0, 24).join('');
  if (cleaned) return cleaned;
  return Array.from(email.split('@')[0] ?? '').slice(0, 24).join('') || 'Texture map 用户';
}

function hashLocalPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function registerLocalAccount(input: { email?: unknown; password?: unknown; displayName?: unknown }): AccountActionResult {
  const email = normaliseAccountEmail(input?.email);
  const password = String(input?.password ?? '');
  if (!isAccountEmail(email)) {
    return { ok: false, error: '请输入有效的邮箱地址' };
  }
  if (password.length < 6 || password.length > 128) {
    return { ok: false, error: '密码长度需要在 6–128 个字符之间' };
  }
  if (readLocalAccount()) {
    return { ok: false, error: '本机已经有账号了，请直接登录' };
  }

  const now = new Date().toISOString();
  const salt = randomBytes(16).toString('hex');
  const account: StoredLocalAccount = {
    version: 1,
    email,
    displayName: accountDisplayName(input?.displayName, email),
    createdAt: now,
    signedInAt: now,
    password: {
      algorithm: 'scrypt',
      salt,
      hash: hashLocalPassword(password, salt)
    }
  };
  try {
    writeLocalAccount(account);
    return { ok: true, state: localAccountState() };
  } catch (error) {
    return { ok: false, error: `保存账号失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function loginLocalAccount(input: { email?: unknown; password?: unknown }): AccountActionResult {
  const account = readLocalAccount();
  if (!account) return { ok: false, error: '本机还没有账号，请先注册' };

  const email = normaliseAccountEmail(input?.email);
  const password = String(input?.password ?? '');
  let matches = false;
  try {
    const expected = Buffer.from(account.password.hash, 'hex');
    const actual = Buffer.from(hashLocalPassword(password, account.password.salt), 'hex');
    matches = expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    matches = false;
  }
  if (!matches || email !== account.email) {
    return { ok: false, error: '邮箱或密码不正确' };
  }

  try {
    account.signedInAt = new Date().toISOString();
    writeLocalAccount(account);
    return { ok: true, state: localAccountState() };
  } catch (error) {
    return { ok: false, error: `登录失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function logoutLocalAccount(): AccountActionResult {
  const account = readLocalAccount();
  if (!account) return { ok: true, state: localAccountState() };
  try {
    delete account.signedInAt;
    writeLocalAccount(account);
    return { ok: true, state: localAccountState() };
  } catch (error) {
    return { ok: false, error: `退出失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function resetLocalAccount(): Promise<AccountActionResult> {
  const file = localAccountFile();
  if (!fs.existsSync(file)) return { ok: true, state: localAccountState() };

  if (mainWindow) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '清除本机账号',
      message: '确定清除本机账号吗？',
      detail: '只会删除本机保存的邮箱和密码，不会影响贴图、视频和记事本文件。清除后可以用新邮箱重新注册。',
      buttons: ['取消', '清除账号'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (result.response !== 1) {
      return { ok: false, error: '已取消' };
    }
  }

  try {
    fs.rmSync(file, { force: true });
    return { ok: true, state: localAccountState() };
  } catch (error) {
    return { ok: false, error: `清除失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    backgroundColor: '#141414',
    show: false,
    title: 'Texture map',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    runAutomation();
  });
}

async function runAutomation(): Promise<void> {
  if (!mainWindow) return;
  const capturePath = process.env.NYXEL_CAPTURE;
  const texturePath = process.env.NYXEL_TEST_TEXTURE;
  const modelPath = process.env.NYXEL_TEST_MODEL;
  const videoPath = process.env.NYXEL_TEST_VIDEO;

  if (videoPath) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(
        `window.__nyxel?.openVideoPath(${JSON.stringify(videoPath)})`
      ).catch((error) => console.error(error));
    }, 600);
  }
  if (texturePath) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(
        `window.__nyxel?.openTexturePath(${JSON.stringify(texturePath)})`
      ).catch((error) => console.error(error));
    }, 500);
  }
  if (modelPath) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(
        `window.__nyxel?.openModelPath(${JSON.stringify(modelPath)})`
      ).catch((error) => console.error(error));
    }, 700);
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(
        `document.querySelector('[data-axis="y"]')?.click()`
      ).catch((error) => console.error(error));
    }, 1600);
    if (process.env.NYXEL_TEST_MODEL_TEXTURE) {
      setTimeout(() => {
        void mainWindow?.webContents.executeJavaScript(
          `window.__nyxel?.applyModelTexturePath(${JSON.stringify(process.env.NYXEL_TEST_MODEL_TEXTURE)})`
        ).catch((error) => console.error(error));
      }, 2800);
    }
  }
  if (process.env.NYXEL_TEST_TEXTURE_ACTION) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(
        process.env.NYXEL_TEST_TEXTURE_ACTION as string
      ).catch((error) => console.error(error));
    }, 1800);
  }
  if (process.env.NYXEL_TEST_SETTINGS) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(
        `document.querySelector('#btn-settings')?.click()`
      ).catch((error) => console.error(error));
    }, 600);
  }
  if (process.env.NYXEL_TEST_SCRIPT) {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(process.env.NYXEL_TEST_SCRIPT as string)
        .then((result) => console.log('TEST_SCRIPT', JSON.stringify(result)))
        .catch((error) => console.error(error));
    }, 2200);
  }
  if (process.env.NYXEL_TEST_SCREENSHOT) {
    setTimeout(() => {
      const capturePromise = mainWindow?.webContents.executeJavaScript(
        `window.nyxel.screenshot.capture()`
      );
      setTimeout(async () => {
        const overlay = BrowserWindow.getAllWindows().find((win) => win !== mainWindow);
        if (!overlay) {
          console.error('SCREENSHOT_TEST: no selector window');
          return;
        }
        try {
          if (process.env.NYXEL_SELECTOR_CAPTURE) {
            await overlay.webContents.executeJavaScript(`
              document.dispatchEvent(new PointerEvent('pointerdown', {clientX:100, clientY:100, button:0, bubbles:true}));
              document.dispatchEvent(new PointerEvent('pointermove', {clientX:500, clientY:400, bubbles:true}));
              document.dispatchEvent(new PointerEvent('pointerup', {clientX:500, clientY:400, bubbles:true}));
              true
            `);
            await new Promise((resolve) => setTimeout(resolve, 350));
            const selectorState = await overlay.webContents.executeJavaScript(`
              ({
                left: document.querySelector('#selection').style.left,
                top: document.querySelector('#selection').style.top,
                width: document.querySelector('#selection').style.width,
                height: document.querySelector('#selection').style.height,
                toolbar: document.querySelector('#toolbar').style.display,
                size: document.querySelector('#size').textContent
              })
            `);
            console.log('SELECTOR_STATE', JSON.stringify(selectorState));
            const overlayImage = await overlay.webContents.capturePage();
            fs.writeFileSync(process.env.NYXEL_SELECTOR_CAPTURE, overlayImage.toPNG());
          }
          await overlay.webContents.executeJavaScript(
            `window.selector.confirm({x:100,y:100,width:400,height:300})`
          );
        } catch (error) {
          console.error('SCREENSHOT_TEST: confirm failed', error);
        }
      }, 1400);
      void capturePromise?.then((result) => console.log('SCREENSHOT_RESULT', JSON.stringify(result))).catch((error) => console.error(error));
      setTimeout(() => app.quit(), 9000);
    }, 1000);
  }
  if (capturePath) {
    setTimeout(async () => {
      try {
        const image = await mainWindow?.webContents.capturePage();
        if (image) fs.writeFileSync(capturePath, image.toPNG());
      } catch (error) {
        console.error(error);
      } finally {
        app.quit();
      }
    }, Number(process.env.NYXEL_CAPTURE_DELAY) || (modelPath ? 6000 : 2500));
  }
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function dataUrlToPngBuffer(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error('截图数据格式无效');
  return Buffer.from(match[1], 'base64');
}

const LIBRARY_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tga']);
const LIBRARY_VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.ts', '.flv', '.wmv']);
const libraryThumbnailCache = new Map<string, { mtimeMs: number; dataUrl?: string }>();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nyxel-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);

function libraryRoot(): string {
  return process.env.NYXEL_LIBRARY_DIR || path.join(app.getPath('documents'), 'Nyxel', 'Library');
}

function galleryDir(): string {
  return path.join(libraryRoot(), 'Screenshots');
}

function texturesDir(): string {
  return path.join(libraryRoot(), 'Textures');
}

function videosDir(): string {
  return path.join(libraryRoot(), 'Videos');
}

function libraryMetaDir(): string {
  return path.join(libraryRoot(), '.nyxel-meta');
}

function folderColorsFile(): string {
  return path.join(libraryMetaDir(), 'folder-colors.json');
}

async function ensureLibraryDirs(): Promise<void> {
  await Promise.all([
    fs.promises.mkdir(galleryDir(), { recursive: true }),
    fs.promises.mkdir(texturesDir(), { recursive: true }),
    fs.promises.mkdir(videosDir(), { recursive: true }),
    fs.promises.mkdir(libraryMetaDir(), { recursive: true })
  ]);
}

const OFFICIAL_TEXTURE_PACK_VERSION = 1;

function officialTexturePackSource(): string {
  const packaged = path.join(process.resourcesPath, 'official-textures', '官方贴图');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'resources', 'official-textures', '官方贴图');
}

async function copyDirectoryMissing(source: string, target: string): Promise<void> {
  await fs.promises.mkdir(target, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryMissing(sourcePath, targetPath);
    } else if (entry.isFile() && !fs.existsSync(targetPath)) {
      await fs.promises.copyFile(sourcePath, targetPath);
    }
  }
}

async function seedOfficialTextures(): Promise<void> {
  const source = officialTexturePackSource();
  if (!fs.existsSync(source)) return;
  const marker = path.join(app.getPath('userData'), 'official-textures.json');
  try {
    const previous = JSON.parse(await fs.promises.readFile(marker, 'utf8')) as { version?: number };
    if (Number(previous.version) >= OFFICIAL_TEXTURE_PACK_VERSION) return;
  } catch {
    // First run or an unreadable marker: seed the built-in pack.
  }
  try {
    await ensureLibraryDirs();
    await copyDirectoryMissing(source, path.join(texturesDir(), '官方贴图'));
    await fs.promises.writeFile(
      marker,
      JSON.stringify({ version: OFFICIAL_TEXTURE_PACK_VERSION, seededAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
    notifyLibraryChanged();
  } catch (error) {
    console.warn('official textures seed failed', error);
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelative(relative: string): string {
  return String(relative ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function resolveInside(root: string, relative: string): { target: string; relative: string } {
  const normalized = normalizeRelative(relative);
  const target = path.resolve(root, normalized);
  if (!isInside(root, target)) throw new Error('路径不在资源库内');
  return { target, relative: normalized };
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function isLibraryImage(fileName: string): boolean {
  return LIBRARY_IMAGE_EXTS.has(path.extname(fileName).toLowerCase());
}

function isLibraryVideo(fileName: string): boolean {
  return LIBRARY_VIDEO_EXTS.has(path.extname(fileName).toLowerCase());
}

async function readFolderColors(): Promise<Record<string, string>> {
  try {
    const raw = await fs.promises.readFile(folderColorsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const colors: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
        colors[normalizeRelative(key)] = value;
      }
    }
    return colors;
  } catch {
    return {};
  }
}

async function writeFolderColors(colors: Record<string, string>): Promise<void> {
  await ensureLibraryDirs();
  await fs.promises.writeFile(
    folderColorsFile(),
    JSON.stringify(colors, null, 2),
    'utf8'
  );
}

const MEDIA_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tga': 'image/x-tga'
};

function mediaMime(filePath: string): string {
  return MEDIA_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function parseByteRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  let start: number;
  let end: number;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}

function registerAudioCapture(): void {
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((item) => item.display_id === primaryId) ?? sources[0];
      if (!source) {
        callback(null);
        return;
      }
      callback({ video: source, audio: 'loopback' });
    } catch {
      callback(null);
    }
  });
}

function registerMediaProtocol(): void {
  protocol.handle('nyxel-media', async (request) => {
    try {
      const requestUrl = new URL(request.url);
      const raw = requestUrl.searchParams.get('path');
      if (!raw) return new Response('Bad request', { status: 400 });
      const filePath = path.resolve(raw);
      const allowed = [videosDir(), galleryDir(), texturesDir()].some((dir) => isInside(dir, filePath));
      if (!allowed) return new Response('Forbidden', { status: 403 });
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const mime = mediaMime(filePath);
      const size = stat.size;
      const range = parseByteRange(request.headers.get('range'), size);
      if (range) {
        const { start, end } = range;
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-store'
          }
        });
      }
      if (request.headers.get('range')) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${size}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-store'
          }
        });
      }
      const stream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function uniqueFilePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

async function recordScreenshot(buffer: Buffer): Promise<string> {
  await ensureLibraryDirs();
  const file = await uniqueFilePath(galleryDir(), `Nyxel_${timestamp()}.png`);
  await fs.promises.writeFile(file, buffer);
  notifyLibraryChanged();
  return file;
}

async function libraryThumbnail(filePath: string, mtimeMs: number): Promise<string | undefined> {
  const cached = libraryThumbnailCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.dataUrl;
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, { width: 360, height: 240 });
    const dataUrl = image.isEmpty() ? undefined : image.toDataURL();
    libraryThumbnailCache.set(filePath, { mtimeMs, dataUrl });
    return dataUrl;
  } catch {
    libraryThumbnailCache.set(filePath, { mtimeMs, dataUrl: undefined });
    return undefined;
  }
}

async function readLibraryFiles(root: string, filePaths: string[]): Promise<Array<{
  name: string;
  path: string;
  relative: string;
  size: number;
  mtime: number;
  thumbnail?: string;
}>> {
  const files = await Promise.all(filePaths.map(async (filePath) => {
    try {
      const stat = await fs.promises.stat(filePath);
      return {
        name: path.basename(filePath),
        path: filePath,
        relative: toRelative(root, filePath),
        size: stat.size,
        mtime: stat.mtimeMs,
        thumbnail: await libraryThumbnail(filePath, stat.mtimeMs)
      };
    } catch {
      return null;
    }
  }));
  return files.filter((file): file is NonNullable<typeof file> => file !== null);
}

async function walkLibraryFiles(root: string, dir = root): Promise<string[]> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walkLibraryFiles(root, fullPath));
    } else if (entry.isFile() && isLibraryImage(entry.name)) {
      result.push(fullPath);
    }
  }
  return result;
}

async function countLibraryImages(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) count += await countLibraryImages(fullPath);
    else if (entry.isFile() && isLibraryImage(entry.name)) count += 1;
  }
  return count;
}

async function collectLibraryFolders(
  root: string,
  colors: Record<string, string>,
  dir = root,
  depth = 0,
  result: Array<{ name: string; relative: string; depth: number; count: number; color?: string }> = []
): Promise<Array<{ name: string; relative: string; depth: number; count: number; color?: string }>> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  for (const entry of folders) {
    const fullPath = path.join(dir, entry.name);
    const relative = toRelative(root, fullPath);
    result.push({
      name: entry.name,
      relative,
      depth,
      count: await countLibraryImages(fullPath),
      color: colors[relative]
    });
    await collectLibraryFolders(root, colors, fullPath, depth + 1, result);
  }
  return result;
}

function notifyLibraryChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('library:changed');
  }
}

async function listGallery(): Promise<{ root: string; files: Array<{
  name: string;
  path: string;
  relative: string;
  size: number;
  mtime: number;
  thumbnail?: string;
}> }> {
  await ensureLibraryDirs();
  const root = galleryDir();
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && isLibraryImage(entry.name))
    .map((entry) => path.join(root, entry.name));
  const files = await readLibraryFiles(root, paths);
  files.sort((left, right) => right.mtime - left.mtime);
  return { root, files };
}

async function listTextures(folder: string): Promise<{
  root: string;
  current: string;
  total: number;
  folders: Array<{ name: string; relative: string; depth: number; count: number; color?: string }>;
  files: Array<{
    name: string;
    path: string;
    relative: string;
    size: number;
    mtime: number;
    thumbnail?: string;
  }>;
}> {
  await ensureLibraryDirs();
  const root = texturesDir();
  const current = resolveInside(root, folder);
  const colors = await readFolderColors();
  const folders = await collectLibraryFolders(root, colors);
  const allPaths = await walkLibraryFiles(root);
  const filePaths = current.relative
    ? (await fs.promises.readdir(current.target, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isLibraryImage(entry.name))
      .map((entry) => path.join(current.target, entry.name))
    : allPaths;
  const files = await readLibraryFiles(root, filePaths);
  files.sort((left, right) => left.relative.localeCompare(right.relative, 'zh-CN'));
  return { root, current: current.relative, total: allPaths.length, folders, files };
}

async function createLibraryFolder(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const clean = String(name ?? '').trim();
  if (!clean) return { ok: false, error: '文件夹名称不能为空' };
  if (clean === '.' || clean === '..' || /[\\/:*?"<>|]/.test(clean)) {
    return { ok: false, error: '文件夹名称包含非法字符' };
  }
  await ensureLibraryDirs();
  const root = texturesDir();
  const parentDir = resolveInside(root, parent);
  const target = path.join(parentDir.target, clean);
  if (!isInside(root, target)) return { ok: false, error: '路径不在资源库内' };
  try {
    await fs.promises.mkdir(target);
    notifyLibraryChanged();
    return { ok: true, path: toRelative(root, target) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.includes('EEXIST') ? '同名文件夹已存在' : message };
  }
}

async function importLibraryTextures(folder: string): Promise<{ ok: boolean; imported?: number; cancelled?: boolean; error?: string }> {
  await ensureLibraryDirs();
  const root = texturesDir();
  const target = resolveInside(root, folder);
  await fs.promises.mkdir(target.target, { recursive: true });
  const options: Electron.OpenDialogOptions = {
    title: '导入贴图',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '贴图图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga'] }
    ]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return { ok: false, cancelled: true };
  let imported = 0;
  for (const filePath of result.filePaths) {
    if (!isLibraryImage(filePath)) continue;
    const destination = await uniqueFilePath(target.target, path.basename(filePath));
    await fs.promises.copyFile(filePath, destination);
    imported += 1;
  }
  if (imported) notifyLibraryChanged();
  return { ok: true, imported };
}

async function moveLibraryFolder(source: string, targetParent: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  await ensureLibraryDirs();
  const root = texturesDir();
  const sourceDir = resolveInside(root, source);
  const parentDir = resolveInside(root, targetParent);
  if (!sourceDir.relative) return { ok: false, error: '不能移动资源库根目录' };
  try {
    const stat = await fs.promises.stat(sourceDir.target);
    if (!stat.isDirectory()) return { ok: false, error: '只能移动文件夹' };
  } catch {
    return { ok: false, error: '文件夹不存在' };
  }
  if (parentDir.target === sourceDir.target || isInside(sourceDir.target, parentDir.target)) {
    return { ok: false, error: '不能把文件夹移动到自身或子文件夹里' };
  }
  const target = path.join(parentDir.target, path.basename(sourceDir.target));
  if (!isInside(root, target)) return { ok: false, error: '路径不在资源库内' };
  if (path.resolve(target) === path.resolve(sourceDir.target)) {
    return { ok: true, path: sourceDir.relative };
  }
  if (fs.existsSync(target)) return { ok: false, error: '目标文件夹里已经有同名文件夹' };
  try {
    await fs.promises.rename(sourceDir.target, target);
    const nextRelative = toRelative(root, target);
    const colors = await readFolderColors();
    let changed = false;
    for (const key of Object.keys(colors)) {
      if (key === sourceDir.relative || key.startsWith(`${sourceDir.relative}/`)) {
        colors[`${nextRelative}${key.slice(sourceDir.relative.length)}`] = colors[key];
        delete colors[key];
        changed = true;
      }
    }
    if (changed) await writeFolderColors(colors);
    notifyLibraryChanged();
    return { ok: true, path: nextRelative };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function uniqueDirectoryPath(parent: string, name: string): Promise<string> {
  const safeName = String(name || '导入文件夹').replace(/[\\/:*?"<>|]/g, '_').trim() || '导入文件夹';
  let candidate = path.join(parent, safeName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${safeName} (${index})`);
    index += 1;
  }
  return candidate;
}

async function copyImageDirectory(source: string, target: string): Promise<number> {
  await fs.promises.mkdir(target, { recursive: true });
  let count = 0;
  let entries: Dirent[];
  try {
    entries = await fs.promises.readdir(source, { withFileTypes: true });
  } catch {
    return count;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      count += await copyImageDirectory(sourcePath, targetPath);
    } else if (entry.isFile() && isLibraryImage(entry.name)) {
      const destination = await uniqueFilePath(target, entry.name);
      await fs.promises.copyFile(sourcePath, destination);
      count += 1;
    }
  }
  return count;
}

async function importDroppedTextures(
  paths: string[],
  folder: string
): Promise<{ ok: boolean; imported?: number; folders?: number; skipped?: number; error?: string }> {
  await ensureLibraryDirs();
  const root = texturesDir();
  let target: string;
  try {
    target = resolveInside(root, folder).target;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await fs.promises.mkdir(target, { recursive: true });
  const sources = [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((item) => path.resolve(String(item ?? '')))
      .filter(Boolean)
  )].slice(0, 200);
  if (!sources.length) return { ok: false, error: '没有收到可导入的文件' };

  let imported = 0;
  let folders = 0;
  let skipped = 0;
  for (const source of sources) {
    if (isInside(root, source)) {
      skipped += 1;
      continue;
    }
    try {
      const stat = await fs.promises.stat(source);
      if (stat.isDirectory()) {
        const destination = await uniqueDirectoryPath(target, path.basename(source));
        await fs.promises.mkdir(destination, { recursive: true });
        folders += 1;
        imported += await copyImageDirectory(source, destination);
      } else if (stat.isFile() && isLibraryImage(source)) {
        const destination = await uniqueFilePath(target, path.basename(source));
        await fs.promises.copyFile(source, destination);
        imported += 1;
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  if (imported || folders) notifyLibraryChanged();
  return { ok: true, imported, folders, skipped };
}

async function moveLibraryImage(
  filePath: string,
  folder: string
): Promise<{ ok: boolean; path?: string; moved?: boolean; error?: string }> {
  await ensureLibraryDirs();
  const root = texturesDir();
  const source = path.resolve(String(filePath ?? ''));
  if (!isInside(root, source)) return { ok: false, error: '只能移动资源库中的图片' };
  let targetDir: string;
  try {
    targetDir = resolveInside(root, folder).target;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || !isLibraryImage(source)) return { ok: false, error: '只能移动图片文件' };
    await fs.promises.mkdir(targetDir, { recursive: true });
    if (path.dirname(source) === targetDir) return { ok: true, path: source, moved: false };
    const destination = await uniqueFilePath(targetDir, path.basename(source));
    try {
      await fs.promises.rename(source, destination);
    } catch {
      try {
        await fs.promises.copyFile(source, destination);
        await shell.trashItem(source);
      } catch (error) {
        try { await fs.promises.rm(destination, { force: true }); } catch { /* ignore */ }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    notifyLibraryChanged();
    return { ok: true, path: destination, moved: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function setLibraryFolderColor(folder: string, color: string | null): Promise<{ ok: boolean; error?: string }> {
  await ensureLibraryDirs();
  const root = texturesDir();
  const target = resolveInside(root, folder);
  if (!target.relative) return { ok: false, error: '不能给资源库根目录改色' };
  try {
    const stat = await fs.promises.stat(target.target);
    if (!stat.isDirectory()) return { ok: false, error: '只能给文件夹改色' };
  } catch {
    return { ok: false, error: '文件夹不存在' };
  }
  if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) {
    return { ok: false, error: '颜色格式无效' };
  }
  const colors = await readFolderColors();
  if (color) colors[target.relative] = color;
  else delete colors[target.relative];
  await writeFolderColors(colors);
  notifyLibraryChanged();
  return { ok: true };
}

async function deleteLibraryFolder(folder: string): Promise<{ ok: boolean; error?: string }> {
  await ensureLibraryDirs();
  const root = texturesDir();
  const target = resolveInside(root, folder);
  if (!target.relative) return { ok: false, error: '不能删除资源库根目录' };
  try {
    const stat = await fs.promises.stat(target.target);
    if (!stat.isDirectory()) return { ok: false, error: '只能删除文件夹' };
    await shell.trashItem(target.target);
    notifyLibraryChanged();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function openLibraryFolder(folder: string): Promise<{ ok: boolean; error?: string }> {
  await ensureLibraryDirs();
  const target = resolveInside(texturesDir(), folder);
  try {
    const stat = await fs.promises.stat(target.target);
    if (!stat.isDirectory()) return { ok: false, error: '文件夹不存在' };
    const error = await shell.openPath(target.target);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function showLibraryFolder(folder: string): Promise<void> {
  await ensureLibraryDirs();
  const target = resolveInside(texturesDir(), folder);
  shell.showItemInFolder(target.target);
}

async function moveLibraryVideo(filePath: string, destinationDir: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  await ensureLibraryDirs();
  const source = path.resolve(String(filePath ?? ''));
  if (!isInside(videosDir(), source)) return { ok: false, error: '只能迁移视频作品库中的文件' };
  const targetDir = path.resolve(String(destinationDir ?? ''));
  try {
    const sourceStat = await fs.promises.stat(source);
    if (!sourceStat.isFile()) return { ok: false, error: '视频文件不存在' };
    const targetStat = await fs.promises.stat(targetDir);
    if (!targetStat.isDirectory()) return { ok: false, error: '目标不是文件夹' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (path.dirname(source) === targetDir) return { ok: false, error: '视频已经在这个文件夹里' };
  const destination = await uniqueFilePath(targetDir, path.basename(source));
  try {
    await fs.promises.rename(source, destination);
  } catch {
    try {
      await fs.promises.copyFile(source, destination);
      await shell.trashItem(source);
    } catch (error) {
      try { await fs.promises.rm(destination, { force: true }); } catch { /* ignore */ }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  notifyLibraryChanged();
  return { ok: true, path: destination };
}

interface MemoFileDocument {
  version: 1;
  id: string;
  title: string;
  html: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

function memoDir(): string {
  return process.env.NYXEL_NOTES_DIR || path.join(app.getPath('documents'), 'Nyxel', 'Notes');
}

async function ensureMemoDir(): Promise<void> {
  await fs.promises.mkdir(memoDir(), { recursive: true });
}

function memoId(): string {
  return `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
}

function validDateString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

async function parseMemoFile(filePath: string): Promise<MemoFileDocument> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('备忘录不是一个文件');
  if (stat.size > 32 * 1024 * 1024) throw new Error('备忘录文件过大');
  const raw = JSON.parse(stripBom(await fs.promises.readFile(filePath, 'utf8')));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('备忘录格式无效');
  const createdAt = validDateString(raw.createdAt, stat.birthtime.toISOString());
  const updatedAt = validDateString(raw.updatedAt, stat.mtime.toISOString());
  return {
    version: 1,
    id: typeof raw.id === 'string' && raw.id ? raw.id : memoId(),
    title: String(raw.title ?? '').slice(0, 200),
    html: String(raw.html ?? '').slice(0, 24 * 1024 * 1024),
    text: String(raw.text ?? '').slice(0, 2 * 1024 * 1024),
    createdAt,
    updatedAt
  };
}

function memoMeta(doc: MemoFileDocument, filePath: string, size: number) {
  return {
    path: filePath,
    title: doc.title,
    preview: doc.text.replace(/\s+/g, ' ').trim().slice(0, 160),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    size
  };
}

async function listMemos(): Promise<{ dir: string; notes: ReturnType<typeof memoMeta>[] }> {
  await ensureMemoDir();
  const root = memoDir();
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const notes = (await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tmnote'))
    .map(async (entry) => {
      const filePath = path.join(root, entry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        const doc = await parseMemoFile(filePath);
        return memoMeta(doc, filePath, stat.size);
      } catch {
        return null;
      }
    })))
    .filter((note): note is NonNullable<typeof note> => note !== null)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return { dir: root, notes };
}

async function createMemo(): Promise<{ ok: boolean; note?: MemoFileDocument; path?: string; error?: string }> {
  await ensureMemoDir();
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const doc: MemoFileDocument = {
    version: 1,
    id: memoId(),
    title: '',
    html: '',
    text: '',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  try {
    const target = await uniqueFilePath(memoDir(), `备忘录-${stamp}-${doc.id.slice(-4)}.tmnote`);
    await fs.promises.writeFile(target, JSON.stringify(doc, null, 2), 'utf8');
    return { ok: true, note: doc, path: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readMemo(filePath: string): Promise<{ ok: boolean; note?: MemoFileDocument; path?: string; error?: string }> {
  const target = path.resolve(String(filePath ?? ''));
  if (!isInside(memoDir(), target)) return { ok: false, error: '只能读取备忘录文件夹中的文件' };
  try {
    return { ok: true, note: await parseMemoFile(target), path: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function saveMemo(
  filePath: string,
  updates: { title?: string; html?: string; text?: string }
): Promise<{ ok: boolean; note?: MemoFileDocument; path?: string; error?: string }> {
  const target = path.resolve(String(filePath ?? ''));
  if (!isInside(memoDir(), target) || !target.toLowerCase().endsWith('.tmnote')) {
    return { ok: false, error: '备忘录路径无效' };
  }
  try {
    const existing = await parseMemoFile(target);
    const html = String(updates.html ?? '');
    if (html.length > 24 * 1024 * 1024) {
      return { ok: false, error: '备忘录内容过大，请减少图片数量或尺寸' };
    }
    const now = new Date().toISOString();
    const note: MemoFileDocument = {
      version: 1,
      id: existing.id,
      title: String(updates.title ?? '').slice(0, 200),
      html,
      text: String(updates.text ?? '').slice(0, 2 * 1024 * 1024),
      createdAt: existing.createdAt,
      updatedAt: now
    };
    await fs.promises.writeFile(target, JSON.stringify(note, null, 2), 'utf8');
    return { ok: true, note, path: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function deleteMemo(filePath: string): Promise<{ ok: boolean; error?: string }> {
  const target = path.resolve(String(filePath ?? ''));
  if (!isInside(memoDir(), target) || !target.toLowerCase().endsWith('.tmnote')) {
    return { ok: false, error: '只能删除备忘录文件夹中的文件' };
  }
  try {
    await shell.trashItem(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function safeMemoName(title: string): string {
  const clean = title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  return (clean || '备忘录').slice(0, 80);
}

async function exportMemo(filePath: string): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }> {
  const source = await readMemo(filePath);
  if (!source.ok || !source.note) return { ok: false, error: source.error ?? '读取备忘录失败' };
  const testTarget = process.env.NYXEL_TEST_MEMO_EXPORT;
  let result: Electron.SaveDialogReturnValue;
  if (testTarget) {
    result = { canceled: false, filePath: testTarget };
  } else {
    const options: Electron.SaveDialogOptions = {
      title: '导出备忘录',
      defaultPath: path.join(app.getPath('documents'), `${safeMemoName(source.note.title)}.tmnote`),
      filters: [{ name: 'Texture map 备忘录', extensions: ['tmnote'] }]
    };
    result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
  }
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  try {
    if (path.resolve(result.filePath) !== path.resolve(source.path ?? '')) {
      await fs.promises.copyFile(source.path ?? filePath, result.filePath);
    }
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function decodeMemoEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function memoTextFromHtml(html: string): string {
  const withoutHidden = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeMemoEntities(withoutHidden)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function memoTitleFromText(text: string, fallback: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  return (firstLine.replace(/^#+\s*/, '').slice(0, 200) || fallback).trim();
}

function rtfToPlainText(rtf: string): string {
  let text = rtf.replace(/\\'([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  text = text.replace(/\\u(-?\d+)\??/g, (_match, value: string) => {
    const code = Number(value);
    return String.fromCharCode(code < 0 ? code + 65536 : code);
  });
  text = text.replace(/\\par[d]?\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function importedMemo(
  title: string,
  html: string,
  text: string,
  createdAt: string
): MemoFileDocument {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: memoId(),
    title: title.slice(0, 200),
    html,
    text,
    createdAt,
    updatedAt: now
  };
}

async function memoDocsFromImportFile(source: string): Promise<MemoFileDocument[]> {
  const ext = path.extname(source).toLowerCase();
  const fallbackTitle = path.basename(source, path.extname(source)) || '导入备忘录';
  if (ext === '.tmnote') return [await parseMemoFile(source)];
  if (!['.pdf', '.txt', '.md', '.html', '.htm', '.rtf', '.enex'].includes(ext)) return [];
  const stat = await fs.promises.stat(source);
  if (!stat.isFile()) return [];
  if (stat.size > 64 * 1024 * 1024) throw new Error('导入文件过大');
  const createdAt = stat.birthtime.toISOString();

  if (ext === '.pdf') {
    const result = await extractText(new Uint8Array(await fs.promises.readFile(source)), { mergePages: true });
    const text = String(result.text ?? '').replace(/\u0000/g, '').trim();
    if (!text) throw new Error('PDF 中没有可提取的文字，可能是扫描件');
    return [importedMemo(memoTitleFromText(text, fallbackTitle), '', text, createdAt)];
  }

  if (ext === '.txt' || ext === '.md') {
    const text = stripBom(await fs.promises.readFile(source, 'utf8')).trim();
    if (!text) return [];
    return [importedMemo(memoTitleFromText(text, fallbackTitle), '', text, createdAt)];
  }

  if (ext === '.html' || ext === '.htm') {
    const html = stripBom(await fs.promises.readFile(source, 'utf8'));
    const text = memoTextFromHtml(html);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
      ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    const title = titleMatch ? memoTextFromHtml(titleMatch[1]) : memoTitleFromText(text, fallbackTitle);
    if (!text && !html.trim()) return [];
    return [importedMemo(title || fallbackTitle, html, text, createdAt)];
  }

  if (ext === '.rtf') {
    const text = rtfToPlainText(stripBom(await fs.promises.readFile(source, 'utf8')));
    if (!text) return [];
    return [importedMemo(memoTitleFromText(text, fallbackTitle), '', text, createdAt)];
  }

  const xml = stripBom(await fs.promises.readFile(source, 'utf8'));
  const notes: MemoFileDocument[] = [];
  for (const match of xml.matchAll(/<note\b[^>]*>([\s\S]*?)<\/note>/gi)) {
    const block = match[1];
    const titleRaw = /<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? '';
    const contentRaw = /<content>([\s\S]*?)<\/content>/i.exec(block)?.[1] ?? '';
    const unwrap = (value: string) => value.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
    const html = unwrap(contentRaw);
    const text = memoTextFromHtml(html);
    const title = memoTextFromHtml(unwrap(titleRaw)) || memoTitleFromText(text, fallbackTitle);
    if (!text && !html.trim()) continue;
    notes.push(importedMemo(title, html, text, createdAt));
    if (notes.length >= 100) break;
  }
  if (!notes.length) {
    const text = memoTextFromHtml(xml);
    if (text) notes.push(importedMemo(memoTitleFromText(text, fallbackTitle), '', text, createdAt));
  }
  return notes;
}

async function importMemoPaths(
  paths: string[]
): Promise<{ ok: boolean; imported?: number; note?: MemoFileDocument; path?: string; error?: string }> {
  await ensureMemoDir();
  const candidates = (Array.isArray(paths) ? paths : [])
    .map((item) => path.resolve(String(item ?? '')))
    .filter((item) => !isInside(memoDir(), item))
    .slice(0, 100);
  if (!candidates.length) return { ok: false, error: '没有可导入的备忘录文件' };
  let imported = 0;
  let lastNote: MemoFileDocument | undefined;
  let lastPath = '';
  let lastError = '';
  for (const source of candidates) {
    try {
      const docs = await memoDocsFromImportFile(source);
      for (const doc of docs) {
        const now = new Date().toISOString();
        const note: MemoFileDocument = {
          ...doc,
          id: memoId(),
          updatedAt: now
        };
        const baseName = source.toLowerCase().endsWith('.tmnote')
          ? path.basename(source)
          : `${safeMemoName(note.title || path.basename(source, path.extname(source)))}.tmnote`;
        const target = await uniqueFilePath(memoDir(), baseName);
        await fs.promises.writeFile(target, JSON.stringify(note, null, 2), 'utf8');
        imported += 1;
        lastNote = note;
        lastPath = target;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!imported) return { ok: false, error: lastError || '没有可导入的有效备忘录' };
  return { ok: true, imported, note: lastNote, path: lastPath };
}

async function importMemoDialog(): Promise<{ ok: boolean; imported?: number; note?: MemoFileDocument; path?: string; cancelled?: boolean; error?: string }> {
  const options: Electron.OpenDialogOptions = {
    title: '导入备忘录',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '备忘录与 iPad 导出文件', extensions: ['tmnote', 'pdf', 'txt', 'md', 'html', 'htm', 'rtf', 'enex'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return { ok: false, cancelled: true };
  return importMemoPaths(result.filePaths);
}

interface VideoNoteMeta {
  path: string;
  fileName: string;
  createdAt: string;
  updatedAt: string;
}

interface VideoNoteImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface VideoNoteDocument {
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

function videoNotesDir(): string {
  const settings = loadSettings();
  return path.resolve(settings.videoNoteDir || path.join(app.getPath('userData'), 'VideoNotes'));
}

function normalizeNoteImageRect(value: unknown): VideoNoteImageRect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<VideoNoteImageRect>;
  const x = Number(source.x);
  const y = Number(source.y);
  const width = Number(source.width);
  const height = Number(source.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function safeFileBase(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note';
}

async function ensureVideoNotesDir(): Promise<string> {
  const dir = videoNotesDir();
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function listVideoNotes(videoPath: string): Promise<{ ok: boolean; dir: string; notes: VideoNoteMeta[]; error?: string }> {
  const dir = videoNotesDir();
  try {
    if (!fs.existsSync(dir)) return { ok: true, dir, notes: [] };
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const notes: VideoNoteMeta[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const notePath = path.join(dir, entry.name);
      try {
        const parsed = JSON.parse(await fs.promises.readFile(notePath, 'utf8')) as Partial<VideoNoteDocument>;
        if (path.resolve(String(parsed.videoPath ?? '')) !== path.resolve(videoPath)) continue;
        notes.push({
          path: notePath,
          fileName: entry.name,
          createdAt: String(parsed.createdAt ?? ''),
          updatedAt: String(parsed.updatedAt ?? parsed.createdAt ?? '')
        });
      } catch {
        // ignore malformed notes
      }
    }
    notes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { ok: true, dir, notes };
  } catch (error) {
    return { ok: false, dir, notes: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function createVideoNote(videoPath: string): Promise<{ ok: boolean; note?: VideoNoteDocument; path?: string; error?: string }> {
  const source = path.resolve(String(videoPath ?? ''));
  if (!isInside(videosDir(), source)) return { ok: false, error: '只能给视频作品库中的视频创建记事本' };
  try {
    await ensureVideoNotesDir();
    const stat = await fs.promises.stat(source);
    if (!stat.isFile()) return { ok: false, error: '视频文件不存在' };
    const dir = videoNotesDir();
    const base = safeFileBase(path.basename(source, path.extname(source)));
    const fileName = await uniqueFilePath(dir, `${base}_复盘_${timestamp()}.json`);
    const now = new Date().toISOString();
    const note: VideoNoteDocument = {
      version: 1,
      videoPath: source,
      videoName: path.basename(source),
      createdAt: now,
      updatedAt: now,
      text: '',
      textHtml: '',
      drawing: '',
      image: ''
    };
    await fs.promises.writeFile(fileName, JSON.stringify(note, null, 2), 'utf8');
    return { ok: true, note, path: fileName };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readVideoNote(notePath: string): Promise<{ ok: boolean; note?: VideoNoteDocument; path?: string; error?: string }> {
  try {
    const dir = videoNotesDir();
    const target = path.resolve(String(notePath ?? ''));
    if (!isInside(dir, target)) return { ok: false, error: '记事本文件不在当前记事本目录中' };
    const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8')) as VideoNoteDocument;
    if (!parsed || typeof parsed !== 'object' || !parsed.videoPath) return { ok: false, error: '记事本文件格式无效' };
    return {
      ok: true,
      path: target,
      note: {
        version: 1,
        videoPath: String(parsed.videoPath),
        videoName: String(parsed.videoName ?? path.basename(parsed.videoPath)),
        createdAt: String(parsed.createdAt ?? ''),
        updatedAt: String(parsed.updatedAt ?? parsed.createdAt ?? ''),
        text: String(parsed.text ?? ''),
        textHtml: String(parsed.textHtml ?? ''),
        drawing: String(parsed.drawing ?? ''),
        image: String(parsed.image ?? ''),
        imageRect: normalizeNoteImageRect(parsed.imageRect),
        canvasWidth: Number.isFinite(Number(parsed.canvasWidth)) ? Number(parsed.canvasWidth) : undefined,
        canvasHeight: Number.isFinite(Number(parsed.canvasHeight)) ? Number(parsed.canvasHeight) : undefined
      }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function saveVideoNote(
  notePath: string,
  updates: { text?: string; textHtml?: string; drawing?: string; image?: string; imageRect?: VideoNoteImageRect; canvasWidth?: number; canvasHeight?: number }
): Promise<{ ok: boolean; note?: VideoNoteDocument; path?: string; error?: string }> {
  try {
    const dir = videoNotesDir();
    const target = path.resolve(String(notePath ?? ''));
    if (!isInside(dir, target)) return { ok: false, error: '记事本文件不在当前记事本目录中' };
    const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8')) as VideoNoteDocument;
    const note: VideoNoteDocument = {
      version: 1,
      videoPath: String(parsed.videoPath ?? ''),
      videoName: String(parsed.videoName ?? ''),
      createdAt: String(parsed.createdAt ?? new Date().toISOString()),
      updatedAt: new Date().toISOString(),
      text: updates.text !== undefined ? String(updates.text) : String(parsed.text ?? ''),
      textHtml: updates.textHtml !== undefined ? String(updates.textHtml) : String(parsed.textHtml ?? ''),
      drawing: updates.drawing !== undefined ? String(updates.drawing) : String(parsed.drawing ?? ''),
      image: updates.image !== undefined ? String(updates.image) : String(parsed.image ?? ''),
      imageRect: updates.imageRect !== undefined
        ? normalizeNoteImageRect(updates.imageRect)
        : normalizeNoteImageRect(parsed.imageRect),
      canvasWidth: updates.canvasWidth !== undefined
        ? Number(updates.canvasWidth)
        : (Number.isFinite(Number(parsed.canvasWidth)) ? Number(parsed.canvasWidth) : undefined),
      canvasHeight: updates.canvasHeight !== undefined
        ? Number(updates.canvasHeight)
        : (Number.isFinite(Number(parsed.canvasHeight)) ? Number(parsed.canvasHeight) : undefined)
    };
    await fs.promises.writeFile(target, JSON.stringify(note, null, 2), 'utf8');
    return { ok: true, note, path: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function openVideoNotesDir(): Promise<{ ok: boolean; dir: string; error?: string }> {
  const dir = await ensureVideoNotesDir();
  const error = await shell.openPath(dir);
  return error ? { ok: false, dir, error } : { ok: true, dir };
}

async function deleteVideoNote(notePath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const dir = videoNotesDir();
    const target = path.resolve(String(notePath ?? ''));
    if (!isInside(dir, target) || target === path.resolve(dir)) {
      return { ok: false, error: '记事本文件不在当前记事本目录中' };
    }
    if (!target.toLowerCase().endsWith('.json')) return { ok: false, error: '只能删除记事本文件' };
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) return { ok: false, error: '记事本文件不存在' };
    await shell.trashItem(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function listVideos(): Promise<{ root: string; files: Array<{
  name: string;
  path: string;
  relative: string;
  size: number;
  mtime: number;
}> }> {
  await ensureLibraryDirs();
  const root = videosDir();
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && isLibraryVideo(entry.name))
    .map(async (entry) => {
      const filePath = path.join(root, entry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        return {
          name: entry.name,
          path: filePath,
          relative: toRelative(root, filePath),
          size: stat.size,
          mtime: stat.mtimeMs
        };
      } catch {
        return null;
      }
    }));
  const result = files.filter((file): file is NonNullable<typeof file> => file !== null);
  result.sort((left, right) => right.mtime - left.mtime);
  return { root, files: result };
}

async function importLibraryVideos(): Promise<{ ok: boolean; imported?: number; cancelled?: boolean; error?: string }> {
  await ensureLibraryDirs();
  const root = videosDir();
  const options: Electron.OpenDialogOptions = {
    title: '上传视频到作品区',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'flv', 'wmv'] }
    ]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return { ok: false, cancelled: true };
  let imported = 0;
  for (const filePath of result.filePaths) {
    if (!isLibraryVideo(filePath)) continue;
    const destination = await uniqueFilePath(root, path.basename(filePath));
    await fs.promises.copyFile(filePath, destination);
    imported += 1;
  }
  if (imported) notifyLibraryChanged();
  return { ok: true, imported };
}

const UPDATE_REPO = 'ANSEN2026/Nyxel';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`;

interface GithubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

interface UpdateCheckResult {
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

function parseVersion(value: string): { major: number; minor: number; patch: number; pre: string } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? ''
  };
}

function comparePrerelease(left: string, right: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference;
    } else if (leftNumeric) {
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else {
      const difference = leftPart.localeCompare(rightPart);
      if (difference !== 0) return difference;
    }
  }
  return 0;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.pre, b.pre);
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const testVersion = process.env.NYXEL_TEST_UPDATE_VERSION;
  if (testVersion) {
    return {
      ok: true,
      currentVersion,
      latestVersion: testVersion,
      latestTag: `v${testVersion}`,
      hasUpdate: compareVersions(`v${testVersion}`, currentVersion) > 0,
      releaseUrl: 'https://github.com/ANSEN2026/Nyxel/releases',
      downloadUrl: 'https://github.com/ANSEN2026/Nyxel/releases',
      channel: 'stable',
      message: `发现新版本 v${testVersion}`
    };
  }
  if (process.windowsStore) {
    return {
      ok: false,
      currentVersion,
      error: 'Microsoft Store 版本由商店自动更新'
    };
  }
  const settings = loadSettings();
  const channel = process.env.NYXEL_UPDATE_CHANNEL || settings.updateChannel;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await net.fetch(UPDATE_API, {
      headers: {
        'User-Agent': 'Nyxel-Update-Checker',
        Accept: 'application/vnd.github+json'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, currentVersion, channel, error: `GitHub 返回 ${response.status}` };
    }
    const releases = await response.json() as GithubRelease[];
    const candidates = releases.filter((release) => !release.draft && (channel === 'beta' || !release.prerelease));
    if (!candidates.length) {
      return {
        ok: true,
        currentVersion,
        channel,
        hasUpdate: false,
        message: channel === 'stable'
          ? '稳定频道暂无新版本；可切换到「测试（含 Alpha）」查看预发布版本。'
          : '暂无可用的新版本。'
      };
    }

    const latest = candidates.reduce((best, release) => {
      if (!best) return release;
      return compareVersions(release.tag_name, best.tag_name) > 0 ? release : best;
    }, candidates[0]);
    const latestVersion = latest.tag_name.replace(/^v/i, '');
    const hasUpdate = compareVersions(latest.tag_name, currentVersion) > 0;
    const installer = latest.assets.find((asset) => asset.name.toLowerCase().endsWith('.exe'));
    return {
      ok: true,
      currentVersion,
      latestVersion,
      latestTag: latest.tag_name,
      hasUpdate,
      releaseUrl: latest.html_url,
      downloadUrl: installer?.browser_download_url ?? latest.html_url,
      publishedAt: latest.published_at,
      channel,
      message: hasUpdate ? `发现新版本 ${latest.tag_name}` : `已是最新版本（v${currentVersion}）`
    };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? '网络请求超时，请检查网络或代理设置'
      : error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      currentVersion,
      channel,
      error: message
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function captureFullScreen(): Promise<string> {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale)
    }
  });
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
  if (!source) throw new Error('没有找到可用的屏幕源');

  const image = source.thumbnail;
  const settings = loadSettings();
  const dir = settings.screenshotDir || path.join(settings.exportDir, 'Screenshots');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `Nyxel_${timestamp()}.png`);
  const png = new Uint8Array(image.toPNG());
  await fs.promises.writeFile(file, png);
  await clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([png], { type: 'image/png' })
    })
  ]);
  return file;
}

function closeSelectorWindows(): void {
  const windows = selectorWindows;
  selectorWindows = [];
  selectorSessions.clear();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      try {
        win.close();
      } catch {
        // ignore
      }
    }
  }
}

function resolveCapture(result: CaptureResult): void {
  const resolve = selectorResolver;
  selectorResolver = null;
  captureInEditor = false;
  closeSelectorWindows();
  resolve?.(result);
}

function createSelectorWindow(session: SelectorSession): void {
  const { display, image } = session;
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'selector-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  selectorWindows.push(win);
  selectorSessions.set(win.id, session);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(false);

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('selector:image', image.toDataURL());
    win.show();
    win.focus();
  });
  win.webContents.on('did-fail-load', () => {
    resolveCapture({ ok: false, error: '截图选区窗口加载失败' });
  });
  win.on('closed', () => {
    selectorWindows = selectorWindows.filter((item) => item !== win);
    selectorSessions.delete(win.id);
    if (!selectorWindows.length && selectorResolver && !captureInEditor) {
      const resolve = selectorResolver;
      selectorResolver = null;
      resolve({ ok: false, cancelled: true });
    }
  });

  void win.loadFile(path.join(__dirname, '..', 'electron', 'selector.html'));
}

function finishScreenshotEditor(result: CaptureResult): void {
  editorCommitted = true;
  const win = editorWindow;
  editorWindow = null;
  captureInEditor = false;
  const resolve = selectorResolver;
  selectorResolver = null;
  if (win && !win.isDestroyed()) {
    // Let the renderer receive the IPC result before the window disappears.
    setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, 80);
  }
  resolve?.(result);
}

function openScreenshotEditor(image: Electron.NativeImage, display: Electron.Display): void {
  if (editorWindow) {
    if (!editorWindow.isDestroyed()) editorWindow.focus();
    return;
  }

  captureInEditor = true;
  closeSelectorWindows();

  const size = image.getSize();
  const work = display.workArea;
  const width = Math.max(620, Math.min(Math.min(1180, work.width - 60), size.width + 96));
  const height = Math.max(460, Math.min(Math.min(860, work.height - 60), size.height + 176));

  const win = new BrowserWindow({
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    width,
    height,
    minWidth: 560,
    minHeight: 420,
    frame: false,
    backgroundColor: '#141414',
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    show: false,
    alwaysOnTop: true,
    title: 'Nyxel 截图',
    webPreferences: {
      preload: path.join(__dirname, 'editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  editorWindow = win;
  editorCommitted = false;
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('editor:image', {
      dataUrl: image.toDataURL(),
      width: size.width,
      height: size.height
    });
    win.show();
    win.focus();

    if (process.env.NYXEL_EDITOR_CAPTURE) {
      const capturePath = process.env.NYXEL_EDITOR_CAPTURE;
      const delay = Number(process.env.NYXEL_EDITOR_CAPTURE_DELAY) || 900;
      setTimeout(async () => {
        try {
          const captured = await win.webContents.capturePage();
          if (captured) fs.writeFileSync(capturePath, captured.toPNG());
        } catch (error) {
          console.error('EDITOR_CAPTURE', error);
        }
      }, delay);
    }
    if (process.env.NYXEL_EDITOR_ACTION) {
      const action = process.env.NYXEL_EDITOR_ACTION;
      const delay = Number(process.env.NYXEL_EDITOR_ACTION_DELAY) || 1100;
      setTimeout(() => {
        void win.webContents.executeJavaScript(action).catch((error) => console.error('EDITOR_ACTION', error));
      }, delay);
    }
  });

  win.webContents.on('did-fail-load', () => {
    finishScreenshotEditor({ ok: false, error: '截图预览窗口加载失败' });
  });

  win.on('closed', () => {
    const committed = editorCommitted;
    editorWindow = null;
    editorCommitted = false;
    captureInEditor = false;
    if (!committed && selectorResolver) {
      const resolve = selectorResolver;
      selectorResolver = null;
      resolve({ ok: false, cancelled: true });
    }
  });

  void win.loadFile(path.join(__dirname, '..', 'electron', 'editor.html'));
}

async function captureRegion(): Promise<CaptureResult> {
  if (selectorWindows.length || editorWindow) return { ok: false, cancelled: true };
  const displays = screen.getAllDisplays();
  const sessions: SelectorSession[] = [];

  for (const display of displays) {
    const scale = display.scaleFactor || 1;
    const width = Math.max(1, Math.round(display.bounds.width * scale));
    const height = Math.max(1, Math.round(display.bounds.height * scale));
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      });
      const source = sources.find((item) => item.display_id === String(display.id))
        ?? (displays.length === 1 ? sources[0] : undefined);
      if (!source || source.thumbnail.isEmpty()) continue;
      sessions.push({ display, image: source.thumbnail });
    } catch (error) {
      console.error('capture display failed', display.id, error);
    }
  }

  if (!sessions.length) {
    return { ok: false, error: '没有可用的屏幕源，无法开始截图' };
  }

  return new Promise<CaptureResult>((resolve) => {
    selectorResolver = resolve;
    for (const session of sessions) createSelectorWindow(session);
  });
}

function registerScreenshotShortcut(accelerator: string): boolean {
  if (!accelerator) return false;
  if (currentHotkey) {
    try {
      globalShortcut.unregister(currentHotkey);
    } catch {
      // ignore
    }
  }
  const ok = globalShortcut.register(accelerator, () => {
    void captureRegion()
      .then((result) => {
        if (result.cancelled) return;
        mainWindow?.webContents.send('screenshot:done', result);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        mainWindow?.webContents.send('screenshot:done', { ok: false, error: message });
      });
  });
  currentHotkey = ok ? accelerator : '';
  hotkeyRegistered = ok;
  return ok;
}

const AI_RUNTIME_URL = process.env.NYXEL_AI_RUNTIME_URL || 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
const AI_RUNTIME_URLS = process.env.NYXEL_AI_RUNTIME_URL
  ? [AI_RUNTIME_URL]
  : [
    AI_RUNTIME_URL,
    `https://ghproxy.net/${AI_RUNTIME_URL}`,
    `https://gh-proxy.com/${AI_RUNTIME_URL}`
  ];
const AI_MODEL_NAME = 'realesrgan-x4plus';
const UPSCAYL_BIN_URL = process.env.NYXEL_UPSCAYL_BIN_URL || 'https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/upscayl-bin-20251207-174704-windows.zip';
const UPSCAYL_BIN_URLS = process.env.NYXEL_UPSCAYL_BIN_URL
  ? [UPSCAYL_BIN_URL]
  : [
    UPSCAYL_BIN_URL,
    `https://ghproxy.net/${UPSCAYL_BIN_URL}`,
    `https://gh-proxy.com/${UPSCAYL_BIN_URL}`
  ];
const UPSCAYL_MODEL_NAME = 'upscayl-standard-4x';
const UPSCAYL_MODELS = ['upscayl-standard-4x', 'ultrasharp-4x', 'ultramix-balanced-4x', 'remacri-4x'];
const UPSCAYL_MODEL_BASES = [
  'https://ghproxy.net/https://raw.githubusercontent.com/upscayl/upscayl/main/resources/models',
  'https://gh-proxy.com/https://raw.githubusercontent.com/upscayl/upscayl/main/resources/models',
  'https://raw.githubusercontent.com/upscayl/upscayl/main/resources/models'
];

function aiRuntimeDir(engine: AiEngine = 'realesrgan'): string {
  return path.join(app.getPath('userData'), 'runtime', engine === 'upscayl' ? 'upscayl' : 'realesrgan');
}

function aiExePath(engine: AiEngine = 'realesrgan'): string {
  return path.join(
    aiRuntimeDir(engine),
    engine === 'upscayl' ? 'upscayl-bin.exe' : 'realesrgan-ncnn-vulkan.exe'
  );
}

function aiModelsDir(engine: AiEngine = 'realesrgan'): string {
  return path.join(aiRuntimeDir(engine), 'models');
}

function normalizeUpscaylModel(model?: string): string {
  return model && UPSCAYL_MODELS.includes(model) ? model : UPSCAYL_MODEL_NAME;
}

function aiStatus(engine: AiEngine = 'realesrgan', model?: string): AiStatus {
  let modelFiles: string[] = [];
  try {
    modelFiles = fs.readdirSync(aiModelsDir(engine));
  } catch {
    // runtime not downloaded yet
  }
  const upscaylModel = normalizeUpscaylModel(model);
  const available = engine === 'upscayl'
    ? fs.existsSync(aiExePath(engine)) &&
      modelFiles.includes(`${upscaylModel}.param`) &&
      modelFiles.includes(`${upscaylModel}.bin`)
    : fs.existsSync(aiExePath(engine)) && modelFiles.some((name) => name.endsWith('.param'));
  return {
    engine,
    model: engine === 'upscayl' ? upscaylModel : undefined,
    available,
    dir: aiRuntimeDir(engine),
    downloading: aiDownloading,
    progress: aiProgress ?? undefined
  };
}

function sendAiProgress(progress: AiProgress): void {
  aiProgress = progress;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai:progress', progress);
  }
}

const FFMPEG_BUILD_URL = process.env.NYXEL_FFMPEG_URL || 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const FFMPEG_DOWNLOAD_URLS = process.env.NYXEL_FFMPEG_URL
  ? [FFMPEG_BUILD_URL]
  : [
    FFMPEG_BUILD_URL,
    `https://ghproxy.net/${FFMPEG_BUILD_URL}`,
    `https://gh-proxy.com/${FFMPEG_BUILD_URL}`
  ];

let videoDownloading = false;
let videoProgress: VideoProgress | null = null;
let videoProcess: ChildProcess | null = null;
let videoCancelled = false;

interface VideoInfo {
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

interface VideoProgress {
  phase: 'download' | 'extract' | 'probe' | 'compress' | 'done' | 'error';
  percent: number;
  message?: string;
  speed?: string;
  currentTime?: number;
  duration?: number;
}

interface VideoStatus {
  available: boolean;
  dir: string;
  defaultOutputDir: string;
  downloading: boolean;
  progress?: VideoProgress;
}

interface VideoCompressOptions {
  input: string;
  outputDir: string;
  codec: 'h264' | 'h265' | 'copy';
  crf: number;
  preset: string;
  resolution: 'source' | '1080' | '720' | '480';
  fps: 'source' | '60' | '30' | '24';
  audio: 'aac192' | 'aac128' | 'aac96' | 'aac64' | 'copy' | 'none';
}

interface VideoProbeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    duration?: string;
  }>;
  format?: {
    duration?: string;
    bit_rate?: string;
  };
}

function ffmpegRuntimeDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'ffmpeg');
}

function ffmpegExePath(): string {
  return path.join(ffmpegRuntimeDir(), 'ffmpeg.exe');
}

function ffprobeExePath(): string {
  return path.join(ffmpegRuntimeDir(), 'ffprobe.exe');
}

function videoStatus(): VideoStatus {
  return {
    available: fs.existsSync(ffmpegExePath()) && fs.existsSync(ffprobeExePath()),
    dir: ffmpegRuntimeDir(),
    defaultOutputDir: path.join(app.getPath('documents'), 'Nyxel', 'Videos'),
    downloading: videoDownloading,
    progress: videoProgress ?? undefined
  };
}

function sendVideoProgress(progress: VideoProgress): void {
  videoProgress = progress;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('video:progress', progress);
  }
}

function parseFps(value?: string): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator)) return 0;
  if (!denominator) return numerator;
  return numerator / denominator;
}

function parseTimeToSeconds(value?: string): number {
  if (!value) return 0;
  const parts = value.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

async function downloadFfmpegRuntime(): Promise<{ ok: boolean; error?: string; status: VideoStatus }> {
  if (videoStatus().available) return { ok: true, status: videoStatus() };
  if (videoDownloading) return { ok: false, error: 'ffmpeg 正在下载中', status: videoStatus() };

  videoDownloading = true;
  const runtime = ffmpegRuntimeDir();
  const staging = `${runtime}-staging`;
  const zipPath = path.join(os.tmpdir(), `nyxel-ffmpeg-${process.pid}.zip`);

  try {
    await fs.promises.mkdir(runtime, { recursive: true });
    sendVideoProgress({ phase: 'download', percent: 0, message: '连接 ffmpeg 下载服务器…' });

    await downloadFileAccelerated({
      urls: FFMPEG_DOWNLOAD_URLS,
      targetPath: zipPath,
      threads: 32,
      onProgress: (received, total) => {
        const percent = total ? Math.min(78, (received / total) * 78) : 0;
        sendVideoProgress({
          phase: 'download',
          percent,
          message: total
            ? `下载 ffmpeg ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
            : `下载 ffmpeg ${(received / 1048576).toFixed(1)} MB`
        });
      }
    });
    const zip = await fs.promises.readFile(zipPath);

    sendVideoProgress({ phase: 'extract', percent: 82, message: '解压 ffmpeg…' });
    const entries = unzipSync(new Uint8Array(zip), {
      filter: (file) => /(^|\/)(ffmpeg|ffprobe)\.exe$/i.test(file.name) || /(^|\/)LICENSE/i.test(file.name)
    });
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.mkdir(staging, { recursive: true });
    for (const [name, data] of Object.entries(entries)) {
      const base = path.basename(name);
      if (!base) continue;
      await fs.promises.writeFile(path.join(staging, base), data);
    }
    if (!fs.existsSync(path.join(staging, 'ffmpeg.exe')) || !fs.existsSync(path.join(staging, 'ffprobe.exe'))) {
      throw new Error('解压后未找到 ffmpeg.exe / ffprobe.exe');
    }

    await fs.promises.rm(runtime, { recursive: true, force: true });
    await fs.promises.rename(staging, runtime);
    videoDownloading = false;
    sendVideoProgress({ phase: 'done', percent: 100, message: 'ffmpeg 运行时已就绪' });
    return { ok: true, status: videoStatus() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    videoDownloading = false;
    sendVideoProgress({ phase: 'error', percent: 0, message });
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: message, status: videoStatus() };
  } finally {
    videoDownloading = false;
    await fs.promises.rm(zipPath, { force: true }).catch(() => undefined);
  }
}

async function probeVideo(filePath: string): Promise<{ ok: boolean; info?: VideoInfo; error?: string }> {
  if (!videoStatus().available) return { ok: false, error: '请先下载 ffmpeg 运行时' };
  try {
    const stat = await fs.promises.stat(filePath);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(ffprobeExePath(), [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `ffprobe 退出码 ${code}`));
      });
    });
    const parsed = JSON.parse(output) as VideoProbeJson;
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
    if (!video || !video.width || !video.height) throw new Error('文件中没有可用的视频轨道');
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
    const duration = Number(parsed.format?.duration ?? video.duration ?? 0);
    return {
      ok: true,
      info: {
        path: filePath,
        name: path.basename(filePath),
        size: stat.size,
        duration: Number.isFinite(duration) ? duration : 0,
        width: video.width,
        height: video.height,
        fps: parseFps(video.r_frame_rate),
        videoCodec: video.codec_name ?? '',
        audioCodec: audio?.codec_name,
        bitrate: Number(parsed.format?.bit_rate ?? 0) || undefined
      }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function compressVideo(options: VideoCompressOptions): Promise<{ ok: boolean; output?: string; size?: number; error?: string; cancelled?: boolean }> {
  if (videoProcess) return { ok: false, error: '已有压缩任务正在运行' };
  if (!videoStatus().available) return { ok: false, error: '请先下载 ffmpeg 运行时' };
  const input = path.resolve(String(options.input ?? ''));
  try {
    const stat = await fs.promises.stat(input);
    if (!stat.isFile()) return { ok: false, error: '输入文件不存在' };
  } catch {
    return { ok: false, error: '输入文件不存在' };
  }

  const probe = await probeVideo(input);
  if (!probe.ok || !probe.info) return { ok: false, error: probe.error ?? '无法读取视频信息' };
  const info = probe.info;
  const outputDir = path.resolve(options.outputDir || path.join(app.getPath('documents'), 'Nyxel', 'Videos'));
  await fs.promises.mkdir(outputDir, { recursive: true });
  const baseName = path.basename(input, path.extname(input));
  const copyMode = options.codec === 'copy';
  const outputExt = copyMode ? (path.extname(input) || '.mp4') : '.mp4';
  const output = await uniqueFilePath(
    outputDir,
    `${baseName}_${copyMode ? 'original' : 'compressed'}${outputExt}`
  );
  const codec = options.codec === 'h265' ? 'libx265' : 'libx264';
  const args = [
    '-hide_banner',
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a?'
  ];
  if (copyMode) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', codec,
      '-preset', options.preset || 'medium',
      '-crf', String(Math.min(35, Math.max(12, options.crf || 23))),
      '-pix_fmt', 'yuv420p'
    );
    if (codec === 'libx265') args.push('-tag:v', 'hvc1');
    if (['.mp4', '.mov', '.m4v'].includes(outputExt)) args.push('-movflags', '+faststart');
  }
  if (!copyMode && options.resolution !== 'source') {
    const targetHeight = Number(options.resolution);
    if (targetHeight && info.height > targetHeight) args.push('-vf', `scale=-2:${targetHeight}`);
  }
  if (!copyMode && options.fps !== 'source') args.push('-r', options.fps);
  if (options.audio === 'none') {
    args.push('-an');
  } else if (options.audio === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    const audioBitrate = options.audio === 'aac192'
      ? '192k'
      : options.audio === 'aac96'
        ? '96k'
        : options.audio === 'aac64'
          ? '64k'
          : '128k';
    args.push('-c:a', 'aac', '-b:a', audioBitrate);
  }
  args.push('-map_metadata', '0', '-progress', 'pipe:1', '-nostats', '-loglevel', 'error', output);

  videoCancelled = false;
  sendVideoProgress({ phase: 'compress', percent: 0, message: '开始压缩…' });

  return new Promise((resolve) => {
    const child = spawn(ffmpegExePath(), args, { windowsHide: true });
    videoProcess = child;
    let stdoutBuffer = '';
    let stderr = '';
    let currentTime = 0;
    let speed = '';
    let settled = false;

    const finish = (result: { ok: boolean; output?: string; size?: number; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      videoProcess = null;
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const split = line.indexOf('=');
        if (split < 0) continue;
        const key = line.slice(0, split);
        const value = line.slice(split + 1);
        if (key === 'out_time_us' || key === 'out_time_ms') {
          currentTime = Number(value) / 1_000_000;
        } else if (key === 'out_time') {
          currentTime = parseTimeToSeconds(value);
        } else if (key === 'speed') {
          speed = value;
        } else if (key === 'progress' && value === 'end') {
          sendVideoProgress({ phase: 'compress', percent: 100, message: '压缩完成', speed, currentTime, duration: info.duration });
        }
        const percent = info.duration > 0 ? Math.min(99, (currentTime / info.duration) * 100) : 0;
        if (Number.isFinite(percent)) {
          sendVideoProgress({
            phase: 'compress',
            percent,
            message: `压缩中 ${percent.toFixed(0)}%${speed ? ` · ${speed}` : ''}`,
            speed,
            currentTime,
            duration: info.duration
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    child.on('error', (error) => {
      finish({ ok: false, error: error.message });
    });

    child.on('close', async (code) => {
      if (videoCancelled) {
        await fs.promises.rm(output, { force: true }).catch(() => undefined);
        sendVideoProgress({ phase: 'error', percent: 0, message: '已取消' });
        finish({ ok: false, cancelled: true, error: '已取消' });
        return;
      }
      if (code !== 0) {
        await fs.promises.rm(output, { force: true }).catch(() => undefined);
        const message = stderr.trim() || `ffmpeg 退出码 ${code}`;
        sendVideoProgress({ phase: 'error', percent: 0, message });
        finish({ ok: false, error: message });
        return;
      }
      try {
        const outputStat = await fs.promises.stat(output);
        sendVideoProgress({ phase: 'done', percent: 100, message: '压缩完成', duration: info.duration, currentTime: info.duration });
        finish({ ok: true, output, size: outputStat.size });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}

async function findFile(root: string, fileName: string): Promise<string | null> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, fileName);
      if (found) return found;
    } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

async function copyDir(source: string, target: string): Promise<void> {
  await fs.promises.mkdir(target, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDir(sourcePath, targetPath);
    else if (entry.isFile()) await fs.promises.copyFile(sourcePath, targetPath);
  }
}

async function downloadRealESRGANRuntime(): Promise<AiStatus> {
  if (aiStatus('realesrgan').available) return aiStatus('realesrgan');
  if (aiDownloading) return aiStatus('realesrgan');

  aiDownloading = true;
  const runtime = aiRuntimeDir('realesrgan');
  const staging = `${runtime}-staging`;
  const finalStaging = `${runtime}-final`;
  const zipPath = path.join(os.tmpdir(), `nyxel-realesrgan-${process.pid}.zip`);

  try {
    await fs.promises.mkdir(runtime, { recursive: true });
    sendAiProgress({ phase: 'download', percent: 0, message: '连接 Real-ESRGAN 下载服务器…' });

    await downloadFileAccelerated({
      urls: AI_RUNTIME_URLS,
      targetPath: zipPath,
      threads: 32,
      onProgress: (received, total) => {
        const percent = total ? Math.min(80, (received / total) * 80) : 0;
        sendAiProgress({
          phase: 'download',
          percent,
          message: total
            ? `下载运行时 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
            : `下载运行时 ${(received / 1048576).toFixed(1)} MB`
        });
      }
    });

    const zip = await fs.promises.readFile(zipPath);
    sendAiProgress({ phase: 'extract', percent: 82, message: '解压运行时…' });
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.mkdir(staging, { recursive: true });

    const entries = unzipSync(new Uint8Array(zip));
    const names = Object.keys(entries);
    let index = 0;
    for (const name of names) {
      index += 1;
      const normalized = name.replace(/\\/g, '/');
      if (normalized.endsWith('/')) continue;
      const safe = normalized
        .split('/')
        .filter((part) => part && part !== '.' && part !== '..')
        .join(path.sep);
      if (!safe) continue;
      const target = path.join(staging, safe);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, entries[name]);
      if (index % 25 === 0) {
        sendAiProgress({
          phase: 'extract',
          percent: 82 + Math.round((index / names.length) * 14),
          message: '解压运行时…'
        });
      }
    }

    const exe = await findFile(staging, 'realesrgan-ncnn-vulkan.exe');
    if (!exe) throw new Error('运行时压缩包中未找到 realesrgan-ncnn-vulkan.exe');
    const sourceRoot = path.dirname(exe);
    await fs.promises.rm(finalStaging, { recursive: true, force: true });
    await copyDir(sourceRoot, finalStaging);
    if (!fs.existsSync(path.join(finalStaging, 'models'))) {
      throw new Error('运行时缺少 models 目录');
    }

    await fs.promises.rm(runtime, { recursive: true, force: true });
    try {
      await fs.promises.rename(finalStaging, runtime);
    } catch {
      await copyDir(finalStaging, runtime);
      await fs.promises.rm(finalStaging, { recursive: true, force: true });
    }

    const status = aiStatus('realesrgan');
    if (!status.available) throw new Error('运行时安装后校验失败');
    sendAiProgress({ phase: 'done', percent: 100, message: 'Real-ESRGAN 运行时已就绪' });
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendAiProgress({ phase: 'error', percent: 0, message });
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.rm(finalStaging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    aiDownloading = false;
    await fs.promises.rm(zipPath, { force: true }).catch(() => undefined);
  }
}

async function fetchUrlBuffer(
  url: string,
  onProgress?: (received: number, total: number) => void
): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('无法读取下载数据');
  const total = Number(response.headers.get('content-length') ?? 0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
    }
    const now = Date.now();
    if (onProgress && now - lastReport > 120) {
      lastReport = now;
      onProgress(received, total);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function downloadUpscaylRuntime(model?: string): Promise<AiStatus> {
  const modelName = normalizeUpscaylModel(model);
  if (aiStatus('upscayl', modelName).available) return aiStatus('upscayl', modelName);
  if (aiDownloading) return aiStatus('upscayl', modelName);

  aiDownloading = true;
  const runtime = aiRuntimeDir('upscayl');
  const modelsDir = aiModelsDir('upscayl');
  const tempFiles: string[] = [];

  try {
    await fs.promises.mkdir(modelsDir, { recursive: true });

    if (!fs.existsSync(aiExePath('upscayl'))) {
      sendAiProgress({ phase: 'download', percent: 0, message: '连接 Upscayl 下载服务器…' });
      const binaryZipPath = path.join(os.tmpdir(), `nyxel-upscayl-${process.pid}.zip`);
      tempFiles.push(binaryZipPath);
      await downloadFileAccelerated({
        urls: UPSCAYL_BIN_URLS,
        targetPath: binaryZipPath,
        threads: 32,
        onProgress: (received, total) => {
          const percent = total ? Math.min(10, (received / total) * 10) : 0;
          sendAiProgress({
            phase: 'download',
            percent,
            message: total
              ? `下载 Upscayl 运行时 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
              : `下载 Upscayl 运行时 ${(received / 1048576).toFixed(1)} MB`
          });
        }
      });
      const binaryZip = await fs.promises.readFile(binaryZipPath);

      sendAiProgress({ phase: 'extract', percent: 11, message: '解压 Upscayl…' });
      const entries = unzipSync(new Uint8Array(binaryZip));
      const exeEntry = Object.keys(entries).find((name) =>
        name.toLowerCase().endsWith('upscayl-bin.exe')
      );
      if (!exeEntry) throw new Error('Upscayl 压缩包中未找到 upscayl-bin.exe');
      const exeTemp = path.join(runtime, 'upscayl-bin.exe.tmp');
      tempFiles.push(exeTemp);
      await fs.promises.writeFile(exeTemp, entries[exeEntry]);
      await fs.promises.rm(aiExePath('upscayl'), { force: true });
      await fs.promises.rename(exeTemp, aiExePath('upscayl'));
    } else {
      sendAiProgress({ phase: 'download', percent: 10, message: 'Upscayl 运行时已存在' });
    }

    for (const extension of ['param', 'bin']) {
      const target = path.join(modelsDir, `${modelName}.${extension}`);
      let existingSize = 0;
      try {
        existingSize = (await fs.promises.stat(target)).size;
      } catch {
        // model not downloaded yet
      }
      const validExisting = extension === 'param'
        ? existingSize >= 1000
        : existingSize >= 1048576;
      if (validExisting) continue;

      const temp = path.join(modelsDir, `${modelName}.${extension}.tmp`);
      tempFiles.push(temp);
      await downloadFileAccelerated({
        urls: UPSCAYL_MODEL_BASES.map((base) => `${base}/${modelName}.${extension}`),
        targetPath: temp,
        threads: extension === 'bin' ? 32 : 4,
        onProgress: (received, total) => {
          const fraction = total ? received / total : 0;
          const percent = extension === 'param'
            ? 12 + fraction * 2
            : 14 + fraction * 80;
          sendAiProgress({
            phase: 'download',
            percent,
            message: total
              ? `下载 Upscayl 模型 ${modelName} ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
              : `下载 Upscayl 模型 ${modelName} ${(received / 1048576).toFixed(1)} MB`
          });
        }
      });
      const downloadedSize = (await fs.promises.stat(temp)).size;
      if (extension === 'param' && downloadedSize < 1000) throw new Error('模型参数文件无效');
      if (extension === 'bin' && downloadedSize < 1048576) throw new Error('模型权重文件无效');
      await fs.promises.rm(target, { force: true });
      await fs.promises.rename(temp, target);
    }

    const status = aiStatus('upscayl', modelName);
    if (!status.available) throw new Error('Upscayl 安装后校验失败');
    sendAiProgress({ phase: 'done', percent: 100, message: 'Upscayl 运行时已就绪' });
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendAiProgress({ phase: 'error', percent: 0, message });
    for (const file of tempFiles) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    aiDownloading = false;
    for (const file of tempFiles) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
    }
  }
}
async function downloadAiRuntime(engine: AiEngine, model?: string): Promise<AiStatus> {
  return engine === 'upscayl'
    ? downloadUpscaylRuntime(model)
    : downloadRealESRGANRuntime();
}

async function upscaleWithAi(
  data: Uint8Array,
  scale: number,
  engine: AiEngine = 'realesrgan',
  model?: string
): Promise<AiUpscaleResult> {
  const status = aiStatus(engine, model);
  const upscaylModel = normalizeUpscaylModel(model);
  if (!status.available) {
    return {
      ok: false,
      error: engine === 'upscayl' ? '请先下载 Upscayl 运行时' : '请先下载 Real-ESRGAN 运行时'
    };
  }
  if (aiProcess) return { ok: false, error: '已有 AI 任务在进行' };
  if (![2, 3, 4].includes(scale)) return { ok: false, error: '不支持的放大倍数' };

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nyxel-ai-'));
  const input = path.join(tempDir, 'input.png');
  const output = path.join(tempDir, 'output.png');

  try {
    await fs.promises.writeFile(input, Buffer.from(data));
    aiCancelled = false;
    sendAiProgress({ phase: 'upscale', percent: 0, message: '启动 Real-ESRGAN…' });

    return await new Promise<AiUpscaleResult>((resolve) => {
      let settled = false;
      const finish = (result: AiUpscaleResult) => {
        if (settled) return;
        settled = true;
        aiProcess = null;
        void fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        resolve(result);
      };

      const engineLabel = engine === 'upscayl' ? 'Upscayl' : 'Real-ESRGAN';
      const args = engine === 'upscayl'
        ? ['-i', input, '-o', output, '-s', String(scale), '-m', aiModelsDir(engine), '-n', upscaylModel, '-f', 'png']
        : ['-i', input, '-o', output, '-n', AI_MODEL_NAME, '-s', String(scale), '-f', 'png'];
      const child = spawn(aiExePath(engine), args, {
        cwd: aiRuntimeDir(engine),
        windowsHide: true
      });
      aiProcess = child;

      let stderr = '';
      let lastPercent = -1;
      const collect = (buffer: Buffer) => {
        const text = buffer.toString();
        stderr = (stderr + text).slice(-2400);
        const matches = [...text.matchAll(/(\d+(?:\.\d+)?)%/g)];
        if (!matches.length) return;
        const percent = Number(matches[matches.length - 1][1]);
        if (percent === lastPercent) return;
        lastPercent = percent;
        sendAiProgress({
          phase: 'upscale',
          percent,
          message: `AI 超分中 ${percent.toFixed(0)}%`
        });
      };

      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) => {
        finish({ ok: false, error: error.message });
      });
      child.once('close', async (code) => {
        if (aiCancelled) {
          finish({ ok: false, error: '已取消' });
          return;
        }
        try {
          if (code !== 0) {
            finish({ ok: false, error: stderr.trim() || `${engineLabel} 退出码 ${code}` });
            return;
          }
          const buffer = await fs.promises.readFile(output);
          const image = nativeImage.createFromBuffer(buffer);
          const size = image.getSize();
          if (!size.width || !size.height) throw new Error(`${engineLabel} 输出无效`);
          sendAiProgress({ phase: 'done', percent: 100, message: 'AI 超分完成' });
          finish({
            ok: true,
            data: new Uint8Array(buffer),
            width: size.width,
            height: size.height
          });
        } catch (error) {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
  } catch (error) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface DownloadTaskState {
  cancelled: boolean;
  controllers: Set<AbortController>;
  downloaded: number;
  total: number;
  lastTick: number;
  lastBytes: number;
  timer: NodeJS.Timeout | null;
  threads: number;
  startedAt: number;
  useChromium: boolean;
  failure: boolean;
  dispatcher: Dispatcher | null;
}

let activeDownload: DownloadTaskState | null = null;

const downloadAgentOptions = {
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  headersTimeout: 60_000,
  bodyTimeout: 0,
  connectTimeout: 20_000
};
const proxyConfigured = Boolean(
  process.env.HTTPS_PROXY || process.env.https_proxy
  || process.env.HTTP_PROXY || process.env.http_proxy
);
const downloadDispatcher = proxyConfigured
  ? new EnvHttpProxyAgent(downloadAgentOptions)
  : new Agent(downloadAgentOptions);

function sendDownloadProgress(progress: {
  phase: 'probe' | 'download' | 'done' | 'error' | 'cancel';
  percent: number;
  downloaded: number;
  total: number;
  speed: number;
  threads: number;
  message?: string;
  output?: string;
}): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('download:progress', progress);
}

function sanitizeDownloadFilename(filename: string): string {
  const base = path.basename(String(filename ?? '').trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');
  if (!base) throw new Error('文件名不能为空');
  return base;
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3])
  };
}

const downloadRequestHeaders = {
  Accept: '*/*',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TextureMapDownloader/1.0'
};

async function configureDownloadProxy(url: string, state: DownloadTaskState): Promise<void> {
  try {
    const resolved = await session.defaultSession.resolveProxy(url);
    const entries = String(resolved ?? '').split(';').map((entry) => entry.trim()).filter(Boolean);
    const proxyEntry = entries.find((entry) => /^(PROXY|HTTPS|SOCKS4|SOCKS5?)\s+/i.test(entry));
    if (!proxyEntry) return;
    const [kind, address] = proxyEntry.split(/\s+/);
    if (!address) return;
    if (/^SOCKS/i.test(kind)) {
      // undici 没有内置 SOCKS 代理，交给 Chromium 网络栈处理系统代理。
      state.useChromium = true;
      return;
    }
    const scheme = kind.toUpperCase() === 'HTTPS' ? 'https' : 'http';
    state.dispatcher = new ProxyAgent({
      uri: `${scheme}://${address}`,
      ...downloadAgentOptions
    });
  } catch { /* use direct/env proxy */ }
}

async function probeDownload(
  url: string,
  state: DownloadTaskState,
  fallbackToChromium = true
): Promise<{ total: number; ranges: boolean }> {
  const runProbe = async (useChromium: boolean): Promise<{ total: number; ranges: boolean }> => {
    const request = (init: Parameters<typeof httpFetch>[1]) => (
      useChromium
        ? net.fetch(url, init as RequestInit)
        : httpFetch(url, { ...init, dispatcher: state.dispatcher ?? downloadDispatcher })
    );
    let total = 0;
    let ranges = false;
    try {
      const controller = new AbortController();
      state.controllers.add(controller);
      try {
        const response = await request({
          method: 'HEAD',
          redirect: 'follow',
          headers: downloadRequestHeaders,
          signal: controller.signal
        });
        if (response.ok) {
          total = Number(response.headers.get('content-length') ?? 0) || 0;
          ranges = String(response.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes') && total > 0;
        }
      } finally {
        state.controllers.delete(controller);
      }
    } catch { /* some servers reject HEAD */ }

    if (!total || !ranges) {
      const controller = new AbortController();
      state.controllers.add(controller);
      try {
        const response = await request({
          redirect: 'follow',
          headers: { ...downloadRequestHeaders, Range: 'bytes=0-0' },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`);
        if (response.status === 206) {
          const range = parseContentRange(response.headers.get('content-range'));
          if (range?.total) {
            total = range.total;
            ranges = true;
          }
        } else {
          total = Number(response.headers.get('content-length') ?? 0) || 0;
          ranges = false;
        }
        try { await response.body?.cancel(); } catch { /* ignore */ }
      } finally {
        state.controllers.delete(controller);
      }
    }
    return { total, ranges };
  };

  if (state.useChromium) return runProbe(true);
  try {
    return await runProbe(false);
  } catch (error) {
    if (state.cancelled || !fallbackToChromium) throw error;
    state.useChromium = true;
    return await runProbe(true);
  }
}

function downloadRequest(url: string, state: DownloadTaskState, init: Parameters<typeof httpFetch>[1]) {
  return state.useChromium
    ? net.fetch(url, init as RequestInit)
    : httpFetch(url, { ...init, dispatcher: state.dispatcher ?? downloadDispatcher });
}

async function downloadRangeToFile(
  url: string,
  start: number,
  end: number,
  handle: FileHandle,
  state: DownloadTaskState,
  onWritten?: (bytes: number) => void
): Promise<void> {
  const controller = new AbortController();
  state.controllers.add(controller);
  const bufferLimit = 1024 * 1024;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let offset = start;
  const flush = async (): Promise<void> => {
    if (!pendingLength) return;
    const output = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);
    await handle.write(output, 0, output.length, offset);
    offset += output.length;
    state.downloaded += output.length;
    onWritten?.(output.length);
    pending = [];
    pendingLength = 0;
  };
  try {
    const response = await downloadRequest(url, state, {
      redirect: 'follow',
      headers: { ...downloadRequestHeaders, Range: `bytes=${start}-${end}` },
      signal: controller.signal
    });
    if (response.status !== 206 || !response.body) {
      throw new Error(`服务器未返回分段内容（HTTP ${response.status}）`);
    }
    const contentRange = parseContentRange(response.headers.get('content-range'));
    if (!contentRange || contentRange.start !== start || contentRange.end !== end) {
      throw new Error('下载源返回了错误的分段范围');
    }
    if (contentRange.total && state.total && contentRange.total !== state.total) {
      throw new Error('下载源文件大小不一致');
    }
    const expected = end - start + 1;
    let received = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (state.cancelled || state.failure) throw new Error('cancelled');
      if (value?.length) {
        received += value.length;
        if (received > expected) throw new Error('下载源返回的分段内容超出请求范围');
        pending.push(Buffer.from(value));
        pendingLength += value.length;
        if (pendingLength >= bufferLimit) await flush();
      }
    }
    await flush();
  } finally {
    state.controllers.delete(controller);
  }
}

async function downloadRangeWithRetry(
  urls: string[],
  chunkIndex: number,
  start: number,
  end: number,
  handle: FileHandle,
  state: DownloadTaskState
): Promise<void> {
  const maxAttempts = Math.max(3, urls.length + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (state.cancelled || state.failure) throw new Error('cancelled');
    const url = urls[(chunkIndex + attempt - 1) % urls.length];
    let written = 0;
    try {
      await downloadRangeToFile(url, start, end, handle, state, (bytes) => { written += bytes; });
      return;
    } catch (error) {
      state.downloaded = Math.max(0, state.downloaded - written);
      if (state.cancelled || state.failure) throw error;
      if (attempt >= maxAttempts) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = /HTTP (429|503)/.test(message);
      await new Promise((resolve) => setTimeout(resolve, (rateLimited ? 1200 : 250) * attempt));
    }
  }
}

/**
 * Shared fast downloader for plugin/runtime assets.
 * Uses the same range queue, mirror rotation and proxy handling as the manual downloader.
 */
async function downloadFileAccelerated(options: {
  urls: string[];
  targetPath: string;
  threads?: number;
  onProgress?: (received: number, total: number) => void;
}): Promise<{ size: number; sources: number }> {
  const target = path.resolve(options.targetPath);
  const partPath = `${target}.part`;
  const urls = [...new Set(options.urls.map((url) => String(url ?? '').trim()).filter(Boolean))];
  if (!urls.length) throw new Error('没有可用的下载地址');
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.rm(partPath, { force: true });

  const state: DownloadTaskState = {
    cancelled: false,
    controllers: new Set(),
    downloaded: 0,
    total: 0,
    lastTick: Date.now(),
    lastBytes: 0,
    timer: null,
    threads: 1,
    startedAt: Date.now(),
    useChromium: false,
    failure: false,
    dispatcher: null
  };
  let progressTimer: NodeJS.Timeout | null = null;

  try {
    await configureDownloadProxy(urls[0], state);

    let primary: { url: string; total: number; ranges: boolean } | null = null;
    let lastError: unknown = null;
    for (let index = 0; index < urls.length; index += 1) {
      try {
        const probe = await probeDownload(urls[index], state, index === 0);
        if (probe.total > 0) {
          primary = { url: urls[index], ...probe };
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!primary) {
      throw lastError instanceof Error ? lastError : new Error('无法连接下载服务器');
    }

    state.total = primary.total;
    const sources = [primary.url];
    if (primary.ranges) {
      for (const url of urls) {
        if (url === primary.url) continue;
        try {
          const probe = await probeDownload(url, state, false);
          if (probe.ranges && probe.total === primary.total) sources.push(url);
        } catch { /* skip unavailable mirror */ }
      }
    }

    progressTimer = setInterval(() => {
      options.onProgress?.(state.downloaded, state.total);
    }, 150);
    options.onProgress?.(0, state.total);

    if (primary.ranges && state.total > 0) {
      const threads = Math.max(1, Math.min(32, Math.floor(options.threads ?? 32) || 32));
      const chunkSize = Math.max(512 * 1024, Math.min(4 * 1024 * 1024, Math.ceil(state.total / (threads * 3))));
      const chunks: Array<{ start: number; end: number }> = [];
      for (let start = 0; start < state.total; start += chunkSize) {
        chunks.push({ start, end: Math.min(state.total - 1, start + chunkSize - 1) });
      }

      const handle = await fs.promises.open(partPath, 'w');
      let multiError: unknown = null;
      try {
        await handle.truncate(state.total);
        let nextChunk = 0;
        const worker = async (): Promise<void> => {
          while (!state.cancelled && !state.failure) {
            const chunkIndex = nextChunk;
            const chunk = chunks[chunkIndex];
            nextChunk += 1;
            if (!chunk) return;
            try {
              await downloadRangeWithRetry(sources, chunkIndex, chunk.start, chunk.end, handle, state);
            } catch (error) {
              if (state.failure) return;
              state.failure = true;
              multiError = error;
              for (const controller of state.controllers) {
                try { controller.abort(); } catch { /* ignore */ }
              }
              return;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(threads, chunks.length) }, () => worker()));
      } catch (error) {
        multiError = error;
      } finally {
        try { await handle.close(); } catch { /* already closed */ }
      }

      if (multiError) {
        await fs.promises.rm(partPath, { force: true });
        state.failure = false;
        state.downloaded = 0;
        state.useChromium = true;
        await downloadSingleToFile(primary.url, partPath, state);
      }
    } else {
      await downloadSingleToFile(primary.url, partPath, state);
    }

    const stat = await fs.promises.stat(partPath);
    if (state.total > 0 && stat.size !== state.total) {
      throw new Error(`下载不完整：${stat.size} / ${state.total} 字节`);
    }
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(partPath, target);
    options.onProgress?.(stat.size, stat.size || state.total);
    return { size: stat.size, sources: sources.length };
  } catch (error) {
    await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    for (const controller of state.controllers) {
      try { controller.abort(); } catch { /* ignore */ }
    }
  }
}

async function downloadSingleToFile(url: string, partPath: string, state: DownloadTaskState): Promise<void> {
  const controller = new AbortController();
  state.controllers.add(controller);
  const handle = await fs.promises.open(partPath, 'w');
  try {
    const response = await downloadRequest(url, state, {
      redirect: 'follow',
      headers: downloadRequestHeaders,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`);
    const headerTotal = Number(response.headers.get('content-length') ?? 0) || 0;
    if (headerTotal > 0) state.total = headerTotal;
    if (!response.body) throw new Error('服务器没有返回文件内容');
    const reader = response.body.getReader();
    const bufferLimit = 1024 * 1024;
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let offset = 0;
    const flush = async (): Promise<void> => {
      if (!pendingLength) return;
      const output = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);
      await handle.write(output, 0, output.length, offset);
      offset += output.length;
      state.downloaded += output.length;
      pending = [];
      pendingLength = 0;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (state.cancelled) throw new Error('cancelled');
      if (value?.length) {
        pending.push(Buffer.from(value));
        pendingLength += value.length;
        if (pendingLength >= bufferLimit) await flush();
      }
    }
    await flush();
  } finally {
    state.controllers.delete(controller);
    await handle.close();
  }
}

async function runDownload(options: {
  url: string;
  mirrors?: string[];
  directory: string;
  filename: string;
  threads: number;
}): Promise<{ ok: boolean; output?: string; size?: number; threads?: number; error?: string; cancelled?: boolean }> {
  if (activeDownload) return { ok: false, error: '已有下载任务正在进行' };
  const rawUrl = String(options.url ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: '下载地址格式不正确' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '只支持 HTTP / HTTPS 下载地址' };
  }
  const directory = path.resolve(String(options.directory ?? '').trim());
  let filename: string;
  try {
    filename = sanitizeDownloadFilename(options.filename);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const target = path.join(directory, filename);
  if (path.dirname(target) !== directory) return { ok: false, error: '保存路径无效' };
  await fs.promises.mkdir(directory, { recursive: true });
  if (fs.existsSync(target)) {
    if (!mainWindow) return { ok: false, error: '窗口不可用' };
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '文件已存在',
      message: `「${filename}」已经存在，是否覆盖？`,
      buttons: ['覆盖', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (answer.response !== 0) return { ok: false, cancelled: true };
    await fs.promises.rm(target, { force: true });
  }

  const partPath = `${target}.part`;
  await fs.promises.rm(partPath, { force: true });
  const state: DownloadTaskState = {
    cancelled: false,
    controllers: new Set(),
    downloaded: 0,
    total: 0,
    lastTick: Date.now(),
    lastBytes: 0,
    timer: null,
    threads: 1,
    startedAt: 0,
    useChromium: false,
    failure: false,
    dispatcher: null
  };
  activeDownload = state;

  const emit = (phase: 'probe' | 'download' | 'done' | 'error' | 'cancel', message?: string): void => {
    const now = Date.now();
    const elapsed = Math.max(0.001, (now - state.lastTick) / 1000);
    let speed = 0;
    if (phase === 'download') {
      speed = Math.max(0, (state.downloaded - state.lastBytes) / elapsed);
      state.lastTick = now;
      state.lastBytes = state.downloaded;
    } else if (phase === 'done' && state.startedAt) {
      speed = state.downloaded / Math.max(0.001, (now - state.startedAt) / 1000);
    }
    sendDownloadProgress({
      phase,
      percent: state.total > 0 ? Math.min(100, (state.downloaded / state.total) * 100) : 0,
      downloaded: state.downloaded,
      total: state.total,
      speed,
      threads: state.threads,
      message,
      output: phase === 'done' ? target : undefined
    });
  };

  try {
    emit('probe', '正在检测服务器与网络代理…');
    await configureDownloadProxy(parsed.toString(), state);
    const probe = await probeDownload(parsed.toString(), state);
    state.total = probe.total;
    const requestedValue = Math.floor(Number(options.threads));
    const requested = requestedValue > 0 ? Math.min(64, requestedValue) : 64;
    let usedThreads = 1;

    const sourceUrls = [parsed.toString()];
    if (probe.ranges && probe.total > 0 && Array.isArray(options.mirrors) && options.mirrors.length) {
      emit('probe', '正在校验备用下载地址…');
      const seen = new Set(sourceUrls);
      for (const rawMirror of options.mirrors.slice(0, 8)) {
        try {
          const mirror = new URL(String(rawMirror ?? '').trim());
          if (mirror.protocol !== 'http:' && mirror.protocol !== 'https:') continue;
          const mirrorUrl = mirror.toString();
          if (seen.has(mirrorUrl)) continue;
          seen.add(mirrorUrl);
          const mirrorProbe = await probeDownload(mirrorUrl, state, false);
          if (mirrorProbe.ranges && mirrorProbe.total === probe.total) {
            sourceUrls.push(mirrorUrl);
          }
        } catch { /* ignore invalid mirror */ }
      }
    }
    const sourceNote = sourceUrls.length > 1 ? `（${sourceUrls.length} 个下载源）` : '';

    state.lastTick = Date.now();
    state.lastBytes = 0;
    state.startedAt = Date.now();
    state.timer = setInterval(() => emit('download', `正在下载${sourceNote}…`), 200);
    emit('download', `正在下载${sourceNote}…`);

    if (probe.ranges && probe.total > 0 && requested > 1) {
      const chunkSize = Math.max(512 * 1024, Math.min(8 * 1024 * 1024, Math.ceil(probe.total / (requested * 4))));
      const chunks: Array<{ start: number; end: number }> = [];
      for (let start = 0; start < probe.total; start += chunkSize) {
        chunks.push({ start, end: Math.min(probe.total - 1, start + chunkSize - 1) });
      }
      const workerCount = Math.min(requested, chunks.length);
      const handle = await fs.promises.open(partPath, 'w');
      try {
        await handle.truncate(probe.total);
        state.threads = 1;
        let nextChunk = 0;
        let workerError: unknown = null;
        let activeWorkers = 0;
        let rampReleased = false;
        let releaseRamp: () => void = () => {};
        const rampDone = new Promise<void>((resolve) => { releaseRamp = resolve; });
        const releaseRampOnce = (): void => {
          if (rampReleased) return;
          rampReleased = true;
          releaseRamp();
        };
        const waitForRamp = (delay: number): Promise<void> => new Promise((resolve) => {
          const timer = setTimeout(resolve, delay);
          rampDone.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        const worker = async (): Promise<void> => {
          while (!state.cancelled && !state.failure) {
            const chunkIndex = nextChunk;
            const chunk = chunks[chunkIndex];
            nextChunk += 1;
            if (!chunk) return;
            if (nextChunk >= chunks.length) releaseRampOnce();
            activeWorkers += 1;
            state.threads = Math.max(state.threads, activeWorkers);
            try {
              await downloadRangeWithRetry(sourceUrls, chunkIndex, chunk.start, chunk.end, handle, state);
            } catch (error) {
              if (state.cancelled) return;
              if (!workerError) workerError = error;
              state.failure = true;
              releaseRampOnce();
              for (const controller of state.controllers) {
                try { controller.abort(); } catch { /* ignore */ }
              }
              return;
            } finally {
              activeWorkers -= 1;
            }
          }
        };
        const startWorker = async (index: number): Promise<void> => {
          if (index >= 16) {
            await waitForRamp(Math.min(1800, (index - 15) * 80));
          }
          if (state.cancelled || state.failure) return;
          await worker();
        };
        try {
          await Promise.all(Array.from({ length: workerCount }, (_, index) => startWorker(index)));
          if (workerError) throw workerError;
          usedThreads = state.threads;
        } catch (error) {
          if (state.cancelled) throw error;
          await handle.close();
          await fs.promises.rm(partPath, { force: true });
          state.downloaded = 0;
          state.threads = 1;
          state.useChromium = true;
          state.failure = false;
          emit('download', '多线程不可用，已回退单线程…');
          await downloadSingleToFile(parsed.toString(), partPath, state);
          usedThreads = 1;
        }
      } finally {
        try { await handle.close(); } catch { /* already closed */ }
      }
    } else {
      state.threads = 1;
      await downloadSingleToFile(parsed.toString(), partPath, state);
    }

    if (state.cancelled) throw new Error('cancelled');
    if (state.total > 0 && state.downloaded < state.total) {
      throw new Error(`下载不完整：${state.downloaded} / ${state.total} 字节`);
    }
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    await fs.promises.rename(partPath, target);
    emit('done', '下载完成');
    const stat = await fs.promises.stat(target);
    return { ok: true, output: target, size: stat.size, threads: usedThreads };
  } catch (error) {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    for (const controller of state.controllers) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    await fs.promises.rm(partPath, { force: true });
    if (state.cancelled) {
      emit('cancel', '已取消下载');
      return { ok: false, cancelled: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    emit('error', message);
    return { ok: false, error: message };
  } finally {
    if (state.timer) clearInterval(state.timer);
    if (state.dispatcher) {
      try { await state.dispatcher.close(); } catch { /* ignore */ }
    }
    activeDownload = null;
  }
}

function registerIpc(): void {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle('window:close', () => mainWindow?.close());

  ipcMain.handle('dialog:openImage', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga', 'exr', 'hdr'] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:openModel', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'FBX Model', extensions: ['fbx'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:openVideo', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: '视频文件',
          extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'flv', 'wmv']
        }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('download:defaultDir', async () => {
    const dir = path.join(app.getPath('downloads'), 'Texture map');
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  });

  ipcMain.handle('download:start', async (_event, options: { url: string; mirrors?: string[]; directory: string; filename: string; threads: number }) => {
    return runDownload(options);
  });

  ipcMain.handle('download:cancel', () => {
    if (!activeDownload) return false;
    activeDownload.cancelled = true;
    if (activeDownload.timer) clearInterval(activeDownload.timer);
    activeDownload.timer = null;
    for (const controller of activeDownload.controllers) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    return true;
  });

  ipcMain.handle('file:read', async (_event, filePath: string) => {
    return fs.promises.readFile(filePath);
  });

  ipcMain.handle('file:openProject', async (_event, filePath?: string) => {
    if (!mainWindow) return null;
    const testPath = process.env.NYXEL_TEST_PROJECT_OPEN;
    let target = filePath || testPath || '';
    if (!target) {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Texture map Project', extensions: ['tmproj'] }]
      });
      if (result.canceled || !result.filePaths.length) return null;
      target = result.filePaths[0];
    }
    const data = await fs.promises.readFile(target);
    return { path: target, data: new Uint8Array(data) };
  });

  ipcMain.handle('file:saveProject', async (_event, data: Uint8Array, suggestedName: string) => {
    if (!mainWindow) return null;
    const settings = loadSettings();
    await fs.promises.mkdir(settings.exportDir, { recursive: true });
    const requested = path.basename(String(suggestedName || 'texture_map.tmproj'));
    const base = requested.replace(/\.[^.]+$/, '') || 'texture_map';
    const testTarget = process.env.NYXEL_TEST_PROJECT_SAVE;
    const target = testTarget || (await (async () => {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: path.join(settings.exportDir, `${base}.tmproj`),
        filters: [{ name: 'Texture map Project', extensions: ['tmproj'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });
      if (result.canceled || !result.filePath) return null;
      return result.filePath.toLowerCase().endsWith('.tmproj')
        ? result.filePath
        : `${result.filePath}.tmproj`;
    })());
    if (!target) return null;
    await fs.promises.writeFile(target, Buffer.from(data));
    return target;
  });

  ipcMain.handle('file:savePng', async (_event, data: Uint8Array, suggestedName: string) => {
    if (!mainWindow) return null;
    const settings = loadSettings();
    await fs.promises.mkdir(settings.exportDir, { recursive: true });
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(settings.exportDir, suggestedName || 'texture.png'),
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePath) return null;
    const target = result.filePath.toLowerCase().endsWith('.png')
      ? result.filePath
      : `${result.filePath}.png`;
    await fs.promises.writeFile(target, Buffer.from(data));
    return target;
  });

  ipcMain.handle('file:saveVideo', async (_event, data: Uint8Array, suggestedName: string, extension: 'mp4' | 'webm') => {
    if (!mainWindow) return null;
    const ext = extension === 'mp4' ? 'mp4' : 'webm';
    const settings = loadSettings();
    await fs.promises.mkdir(settings.exportDir, { recursive: true });
    const requested = path.basename(String(suggestedName || `texture_map.${ext}`));
    const base = requested.replace(/\.[^.]+$/, '') || 'texture_map';
    const testTarget = process.env.NYXEL_TEST_VIDEO_SAVE;
    if (testTarget) {
      await fs.promises.writeFile(testTarget, Buffer.from(data));
      return testTarget;
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(settings.exportDir, `${base}.${ext}`),
      filters: [{ name: ext === 'mp4' ? 'MP4 Video' : 'WebM Video', extensions: [ext] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (result.canceled || !result.filePath) return null;
    const target = result.filePath.toLowerCase().endsWith(`.${ext}`)
      ? result.filePath
      : `${result.filePath}.${ext}`;
    await fs.promises.writeFile(target, Buffer.from(data));
    return target;
  });

  ipcMain.handle('ai:status', (_event, engine: AiEngine = 'realesrgan', model?: string) => {
    return aiStatus(engine, model);
  });
  ipcMain.handle('ai:download', async (_event, engine: AiEngine = 'realesrgan', model?: string) => {
    try {
      const status = await downloadAiRuntime(engine, model);
      return { ok: true, status };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status: aiStatus(engine, model)
      };
    }
  });
  ipcMain.handle('ai:upscale', (
    _event,
    data: Uint8Array,
    scale: number,
    engine: AiEngine = 'realesrgan',
    model?: string
  ) => {
    return upscaleWithAi(data, scale, engine, model);
  });
  ipcMain.handle('ai:cancel', () => {
    aiCancelled = true;
    if (aiProcess) {
      aiProcess.kill();
      return true;
    }
    return false;
  });

  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, settings: Settings) => {
    const merged: Settings = { ...defaultSettings(), ...settings, schemaVersion: 2 };
    saveSettings(merged);
    return merged;
  });

  ipcMain.handle('account:status', () => localAccountState());
  ipcMain.handle('account:register', (_event, input: { email?: string; password?: string; displayName?: string }) => {
    return registerLocalAccount(input ?? {});
  });
  ipcMain.handle('account:login', (_event, input: { email?: string; password?: string }) => {
    return loginLocalAccount(input ?? {});
  });
  ipcMain.handle('account:logout', () => logoutLocalAccount());
  ipcMain.handle('account:reset', () => resetLocalAccount());

  ipcMain.handle('app:info', () => {
    const settings = loadSettings();
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      settingsPath: settingsFile(),
      exportDir: settings.exportDir,
      cacheDir: settings.cacheDir,
      hotkeyRegistered,
      windowsStore: Boolean(process.windowsStore)
    };
  });

  ipcMain.handle('update:check', async () => checkForUpdates());

  ipcMain.handle('video:status', () => videoStatus());
  ipcMain.handle('video:download', async () => downloadFfmpegRuntime());
  ipcMain.handle('video:probe', async (_event, filePath: string) => probeVideo(filePath));
  ipcMain.handle('video:compress', async (_event, options: VideoCompressOptions) => compressVideo(options));
  ipcMain.handle('video:cancel', () => {
    if (!videoProcess) return false;
    videoCancelled = true;
    try {
      videoProcess.kill();
    } catch {
      // ignore
    }
    return true;
  });

  ipcMain.handle('app:openPath', async (_event, target: string) => {
    const error = await shell.openPath(target);
    return error;
  });

  ipcMain.handle('app:showItemInFolder', (_event, target: string) => {
    shell.showItemInFolder(target);
  });

  ipcMain.handle('app:clearCache', async () => {
    const settings = loadSettings();
    await fs.promises.rm(settings.cacheDir, { recursive: true, force: true });
    await fs.promises.mkdir(settings.cacheDir, { recursive: true });
    return true;
  });

  ipcMain.on('selector:confirm', (event, rect: { x: number; y: number; width: number; height: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !selectorResolver || captureInEditor) return;
    const session = selectorSessions.get(win.id);
    if (!session) return;
    try {
      if (!rect || rect.width < 1 || rect.height < 1) {
        resolveCapture({ ok: false, cancelled: true });
        return;
      }
      const size = session.image.getSize();
      const scaleX = size.width / Math.max(1, session.display.bounds.width);
      const scaleY = size.height / Math.max(1, session.display.bounds.height);
      const x = Math.max(0, Math.min(size.width - 1, Math.round(rect.x * scaleX)));
      const y = Math.max(0, Math.min(size.height - 1, Math.round(rect.y * scaleY)));
      const width = Math.max(1, Math.min(size.width - x, Math.round(rect.width * scaleX)));
      const height = Math.max(1, Math.min(size.height - y, Math.round(rect.height * scaleY)));
      const cropped = session.image.crop({ x, y, width, height });
      openScreenshotEditor(cropped, session.display);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolveCapture({ ok: false, error: message });
    }
  });

  ipcMain.on('selector:cancel', () => {
    resolveCapture({ ok: false, cancelled: true });
  });

  ipcMain.handle('editor:save', async (event, dataUrl: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== editorWindow) return { ok: false, error: '截图窗口已关闭' };
    try {
      const buffer = dataUrlToPngBuffer(dataUrl);
      const settings = loadSettings();
      const dir = settings.screenshotDir || path.join(settings.exportDir, 'Screenshots');
      await fs.promises.mkdir(dir, { recursive: true });

      let filePath = '';
      const testPath = process.env.NYXEL_EDITOR_SAVE_PATH;
      if (testPath) {
        filePath = testPath;
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      } else {
        const result = await dialog.showSaveDialog(win, {
          title: '保存截图',
          defaultPath: path.join(dir, `Nyxel_${timestamp()}.png`),
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation']
        });
        if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
        filePath = /\.png$/i.test(result.filePath) ? result.filePath : `${result.filePath}.png`;
      }

      await fs.promises.writeFile(filePath, buffer);
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(buffer)], { type: 'image/png' })
        })
      ]);
      if (isInside(galleryDir(), filePath)) {
        notifyLibraryChanged();
      } else {
        try {
          await recordScreenshot(buffer);
        } catch (error) {
          console.error('record screenshot failed', error);
        }
      }
      finishScreenshotEditor({ ok: true, path: filePath });
      return { ok: true, path: filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('editor:copy', async (event, dataUrl: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== editorWindow) return { ok: false, error: '截图窗口已关闭' };
    try {
      const buffer = dataUrlToPngBuffer(dataUrl);
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(buffer)], { type: 'image/png' })
        })
      ]);
      try {
        await recordScreenshot(buffer);
      } catch (error) {
        console.error('record screenshot failed', error);
      }
      finishScreenshotEditor({ ok: true, copied: true });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.on('editor:cancel', () => {
    finishScreenshotEditor({ ok: false, cancelled: true });
  });

  ipcMain.on('editor:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle('library:info', async () => {
    await ensureLibraryDirs();
    return {
      root: libraryRoot(),
      galleryDir: galleryDir(),
      texturesDir: texturesDir(),
      videosDir: videosDir()
    };
  });

  ipcMain.handle('library:gallery', async () => listGallery());

  ipcMain.handle('library:textures', async (_event, folder: string) => listTextures(folder));

  ipcMain.handle('library:createFolder', async (_event, parent: string, name: string) => {
    return createLibraryFolder(parent, name);
  });

  ipcMain.handle('library:importTextures', async (_event, folder: string) => {
    return importLibraryTextures(folder);
  });

  ipcMain.handle('library:importDroppedTextures', async (_event, paths: string[], folder: string) => {
    return importDroppedTextures(paths, folder);
  });

  ipcMain.handle('library:videos', async () => listVideos());

  ipcMain.handle('library:importVideos', async () => importLibraryVideos());

  ipcMain.handle('library:moveFolder', async (_event, source: string, targetParent: string) => {
    return moveLibraryFolder(source, targetParent);
  });

  ipcMain.handle('library:setFolderColor', async (_event, folder: string, color: string | null) => {
    return setLibraryFolderColor(folder, color);
  });

  ipcMain.handle('library:deleteFolder', async (_event, folder: string) => deleteLibraryFolder(folder));

  ipcMain.handle('library:openFolder', async (_event, folder: string) => openLibraryFolder(folder));

  ipcMain.handle('library:showFolder', async (_event, folder: string) => showLibraryFolder(folder));

  ipcMain.handle('library:moveVideo', async (_event, filePath: string, destinationDir: string) => {
    return moveLibraryVideo(filePath, destinationDir);
  });

  ipcMain.handle('library:moveImage', async (_event, filePath: string, folder: string) => {
    return moveLibraryImage(filePath, folder);
  });

  ipcMain.handle('memo:list', async () => listMemos());
  ipcMain.handle('memo:create', async () => createMemo());
  ipcMain.handle('memo:read', async (_event, filePath: string) => readMemo(filePath));
  ipcMain.handle('memo:save', async (_event, filePath: string, updates: { title?: string; html?: string; text?: string }) => {
    return saveMemo(filePath, updates);
  });
  ipcMain.handle('memo:delete', async (_event, filePath: string) => deleteMemo(filePath));
  ipcMain.handle('memo:export', async (_event, filePath: string) => exportMemo(filePath));
  ipcMain.handle('memo:import', async () => importMemoDialog());
  ipcMain.handle('memo:importPaths', async (_event, paths: string[]) => importMemoPaths(paths));
  ipcMain.handle('memo:openDir', async () => {
    await ensureMemoDir();
    const error = await shell.openPath(memoDir());
    return error ? { ok: false, dir: memoDir(), error } : { ok: true, dir: memoDir() };
  });

  ipcMain.handle('notes:list', async (_event, videoPath: string) => listVideoNotes(videoPath));

  ipcMain.handle('notes:create', async (_event, videoPath: string) => createVideoNote(videoPath));

  ipcMain.handle('notes:read', async (_event, notePath: string) => readVideoNote(notePath));

  ipcMain.handle('notes:save', async (_event, notePath: string, updates: { text?: string; textHtml?: string; drawing?: string; image?: string; imageRect?: VideoNoteImageRect; canvasWidth?: number; canvasHeight?: number }) => {
    return saveVideoNote(notePath, updates);
  });

  ipcMain.handle('notes:delete', async (_event, notePath: string) => deleteVideoNote(notePath));

  ipcMain.handle('notes:openDir', async () => openVideoNotesDir());

  ipcMain.handle('audio:source', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }
    });
    const primaryId = String(screen.getPrimaryDisplay().id);
    const source = sources.find((item) => item.display_id === primaryId) ?? sources[0];
    return source ? { id: source.id, name: source.name } : null;
  });

  ipcMain.handle('library:delete', async (_event, target: string) => {
    const absolute = path.resolve(String(target ?? ''));
    if (!isInside(galleryDir(), absolute) && !isInside(texturesDir(), absolute) && !isInside(videosDir(), absolute)) {
      return { ok: false, error: '只能删除资源库中的文件' };
    }
    try {
      const stat = await fs.promises.stat(absolute);
      if (!stat.isFile()) return { ok: false, error: '只能删除文件' };
      await shell.trashItem(absolute);
      notifyLibraryChanged();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('screenshot:capture', async () => captureRegion());

  ipcMain.handle('screenshot:setHotkey', (_event, accelerator: string) => {
    const ok = registerScreenshotShortcut(accelerator);
    return { ok, accelerator: ok ? accelerator : currentHotkey };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.nyxel.app');
    registerMediaProtocol();
    registerAudioCapture();
    registerIpc();
    createWindow();
    void seedOfficialTextures();
    const settings = loadSettings();
    if (!registerScreenshotShortcut(settings.screenshotHotkey)) {
      mainWindow?.webContents.send('screenshot:done', {
        ok: false,
        error: `截图热键 ${settings.screenshotHotkey} 注册失败，可能已被其他程序占用`
      });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}

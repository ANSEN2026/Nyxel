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
  shell
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { unzipSync } from 'fflate';

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
    restoreWorkspace: true,
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0b0d12',
    show: false,
    title: 'Nyxel',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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
      return net.fetch(pathToFileURL(filePath).toString(), { headers: request.headers });
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
    backgroundColor: '#0b0d12',
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

const AI_RUNTIME_URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
const AI_MODEL_NAME = 'realesrgan-x4plus';
const UPSCAYL_BIN_URL = 'https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/upscayl-bin-20251207-174704-windows.zip';
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

const FFMPEG_BUILD_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const FFMPEG_DOWNLOAD_URLS = [
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
  codec: 'h264' | 'h265';
  crf: number;
  preset: string;
  resolution: 'source' | '1080' | '720' | '480';
  fps: 'source' | '60' | '30' | '24';
  audio: 'aac192' | 'aac128' | 'aac96' | 'none';
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

    let zip: Buffer | null = null;
    let lastError: Error | null = null;
    for (const url of FFMPEG_DOWNLOAD_URLS) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('无法读取下载数据');
        const total = Number(response.headers.get('content-length') ?? 0);
        const handle = await fs.promises.open(zipPath, 'w');
        let received = 0;
        let lastReport = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            await handle.write(value);
            received += value.byteLength;
            const now = Date.now();
            if (now - lastReport > 180) {
              lastReport = now;
              const percent = total ? Math.min(78, (received / total) * 78) : 0;
              sendVideoProgress({
                phase: 'download',
                percent,
                message: total
                  ? `下载 ffmpeg ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
                  : `下载 ffmpeg ${(received / 1048576).toFixed(1)} MB`
              });
            }
          }
        } finally {
          await handle.close();
        }
        zip = await fs.promises.readFile(zipPath);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await fs.promises.rm(zipPath, { force: true }).catch(() => undefined);
      }
    }

    if (!zip) throw lastError ?? new Error('ffmpeg 下载失败');

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
  const output = await uniqueFilePath(outputDir, `${baseName}_compressed.mp4`);
  const codec = options.codec === 'h265' ? 'libx265' : 'libx264';
  const args = [
    '-hide_banner',
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', codec,
    '-preset', options.preset || 'medium',
    '-crf', String(Math.min(35, Math.max(14, options.crf || 23))),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart'
  ];
  if (codec === 'libx265') args.push('-tag:v', 'hvc1');
  if (options.resolution !== 'source') {
    const targetHeight = Number(options.resolution);
    if (targetHeight && info.height > targetHeight) args.push('-vf', `scale=-2:${targetHeight}`);
  }
  if (options.fps !== 'source') args.push('-r', options.fps);
  if (options.audio === 'none') {
    args.push('-an');
  } else {
    const audioBitrate = options.audio === 'aac192' ? '192k' : options.audio === 'aac96' ? '96k' : '128k';
    args.push('-c:a', 'aac', '-b:a', audioBitrate);
  }
  args.push('-progress', 'pipe:1', '-nostats', '-loglevel', 'error', output);

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

  try {
    await fs.promises.mkdir(runtime, { recursive: true });
    sendAiProgress({ phase: 'download', percent: 0, message: '连接 Real-ESRGAN 下载服务器…' });

    const response = await fetch(AI_RUNTIME_URL);
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
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
      if (now - lastReport > 150) {
        lastReport = now;
        const percent = total ? Math.min(80, (received / total) * 80) : 0;
        sendAiProgress({
          phase: 'download',
          percent,
          message: total
            ? `下载运行时 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
            : `下载运行时 ${(received / 1048576).toFixed(1)} MB`
        });
      }
    }

    const zip = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
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
      const binaryZip = await fetchUrlBuffer(UPSCAYL_BIN_URL, (received, total) => {
        const percent = total ? Math.min(10, (received / total) * 10) : 0;
        sendAiProgress({
          phase: 'download',
          percent,
          message: total
            ? `下载 Upscayl 运行时 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
            : `下载 Upscayl 运行时 ${(received / 1048576).toFixed(1)} MB`
        });
      });

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

      let downloaded: Buffer | null = null;
      let lastError: unknown = null;
      for (const base of UPSCAYL_MODEL_BASES) {
        try {
          downloaded = await fetchUrlBuffer(`${base}/${modelName}.${extension}`, (received, total) => {
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
          });
          if (extension === 'param' && downloaded.length < 1000) throw new Error('模型参数文件无效');
          if (extension === 'bin' && downloaded.length < 1048576) throw new Error('模型权重文件无效');
          break;
        } catch (error) {
          lastError = error;
          downloaded = null;
        }
      }
      if (!downloaded) {
        throw new Error(
          `Upscayl 模型下载失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
        );
      }
      const temp = path.join(modelsDir, `${modelName}.${extension}.tmp`);
      tempFiles.push(temp);
      await fs.promises.writeFile(temp, downloaded);
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

  ipcMain.handle('file:read', async (_event, filePath: string) => {
    return fs.promises.readFile(filePath);
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

  ipcMain.handle('library:videos', async () => listVideos());

  ipcMain.handle('library:importVideos', async () => importLibraryVideos());

  ipcMain.handle('library:moveFolder', async (_event, source: string, targetParent: string) => {
    return moveLibraryFolder(source, targetParent);
  });

  ipcMain.handle('library:setFolderColor', async (_event, folder: string, color: string | null) => {
    return setLibraryFolderColor(folder, color);
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
    registerIpc();
    createWindow();
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

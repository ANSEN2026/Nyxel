import './styles.css';
import logoUrl from './assets/app-icon-face.png';
import type { AppInfo, RecentProject, Settings, StatusApi, ToastApi, ToastKind, ViewName } from './types';
import { AboutView } from './views/about';
import { ColorView } from './views/color';
import { FilesView } from './views/files';
import { HomeView } from './views/home';
import { ModelView } from './views/model';
import { SettingsView } from './views/settings';
import { TextureView } from './views/texture';
import { VideoView } from './views/video';
import { basename, isImageFile, isModelFile } from './utils';

const appRoot = document.querySelector('#app') as HTMLElement;
appRoot.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <img class="logo" src="${logoUrl}" alt="Nyxel" draggable="false" />
      <nav class="nav">
        <button class="nav-button active" data-view="home" type="button">⌂<span class="nav-tooltip">首页 Ctrl+0</span></button>
        <button class="nav-button" data-view="texture" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M4 14.5h16M9.5 4v16M14.5 4v16"/></svg>
          <span class="nav-tooltip">贴图 Ctrl+1</span>
        </button>
        <button class="nav-button" data-view="model" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 21 8v8l-9 5-9-5V8z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>
          <span class="nav-tooltip">模型 Ctrl+2</span>
        </button>
        <button class="nav-button" data-view="color" type="button">◑<span class="nav-tooltip">配色 Ctrl+3</span></button>
        <div class="nav-divider"></div>
        <div class="nav-section-title">文件</div>
        <button class="nav-button" data-view="gallery" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/></svg>
          <span class="nav-tooltip">图库 Ctrl+4</span>
        </button>
        <button class="nav-button" data-view="textures" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <span class="nav-tooltip">贴图资源 Ctrl+5</span>
        </button>
        <div class="nav-divider"></div>
        <div class="nav-section-title">媒体</div>
        <button class="nav-button" data-view="video" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>
          <span class="nav-tooltip">视频压缩 Ctrl+6</span>
        </button>
        <button class="nav-button" data-view="videos" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M3 9h18M7 5v4M17 5v4M8.5 13.2l4 2.3-4 2.3z"/></svg>
          <span class="nav-tooltip">视频作品 Ctrl+7</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button class="about-button" id="btn-about" type="button" title="关于我们">!</button>
        <div class="sidebar-footer">v0.2</div>
      </div>
    </aside>
    <div class="main">
      <header class="titlebar" id="titlebar">
        <div class="titlebar-title" id="titlebar-title">当前：<strong>首页</strong></div>
        <div class="titlebar-actions">
          <button id="btn-screenshot" type="button" title="截图（Ctrl+Alt+A）">⌗</button>
          <button id="btn-settings" type="button" title="设置（Ctrl+,）">⚙</button>
          <button id="btn-min" type="button" title="最小化">─</button>
          <button id="btn-max" type="button" title="最大化">□</button>
          <button id="btn-close" class="close" type="button" title="关闭">×</button>
        </div>
      </header>
      <section class="workspace" id="workspace"></section>
      <footer class="statusbar">
        <span class="status-dot"></span>
        <span class="status-file" id="status-file">就绪</span>
        <span class="status-info" id="status-info"></span>
        <span class="status-log" id="status-log"></span>
      </footer>
    </div>
  </div>
  <div class="toast-container" id="toast-container"></div>
`;

const workspace = document.querySelector('#workspace') as HTMLElement;
const titlebarTitle = document.querySelector('#titlebar-title') as HTMLElement;
const statusFile = document.querySelector('#status-file') as HTMLElement;
const statusInfo = document.querySelector('#status-info') as HTMLElement;
const statusLog = document.querySelector('#status-log') as HTMLElement;
const toastContainer = document.querySelector('#toast-container') as HTMLElement;

let settings: Settings;
let appInfo: AppInfo;
let currentView: ViewName = 'home';
let homeView: HomeView;
let textureView: TextureView;
let modelView: ModelView;
let colorView: ColorView;
let galleryView: FilesView;
let texturesView: FilesView;
let videoView: VideoView;
let videosView: FilesView;
let settingsView: SettingsView;
let aboutView: AboutView;

function toast(message: string, kind: ToastKind = 'info'): void {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  toastContainer.append(node);
  window.setTimeout(() => node.remove(), 4200);
}

const status: StatusApi = {
  set(file?: string, info?: string, log?: string) {
    if (file !== undefined) statusFile.textContent = file || '就绪';
    if (info !== undefined) statusInfo.textContent = info;
    if (log !== undefined) statusLog.textContent = log;
  }
};

function updateTitle(label: string, file?: string): void {
  titlebarTitle.innerHTML = `当前：<strong>${label}</strong>${file ? ` · ${file}` : ''}`;
}

function applyTheme(theme: Settings['theme']): void {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
}

async function saveSettings(next: Settings): Promise<void> {
  const previousHotkey = settings?.screenshotHotkey;
  const previousTheme = settings?.theme;
  settings = await window.nyxel.settings.save(next);
  if (settings.theme !== previousTheme) applyTheme(settings.theme);
  if (settings.screenshotHotkey !== previousHotkey) {
    const result = await window.nyxel.screenshot.setHotkey(settings.screenshotHotkey);
    if (!result.ok) toast(`截图热键 ${settings.screenshotHotkey} 注册失败`, 'error');
  }
}

function addRecent(type: 'texture' | 'model', path: string, name: string): void {
  if (!path) return;
  const next: RecentProject[] = [
    { type, path, name, time: Date.now() },
    ...(settings.recentProjects ?? []).filter((item) => !(item.type === type && item.path === path))
  ].slice(0, 8);
  settings = { ...settings, recentProjects: next };
  void window.nyxel.settings.save(settings);
  homeView.renderRecent(settings.recentProjects);
}

const callbacks = {
  openTexturePath: async (path: string) => {
    await openTexturePath(path);
  },
  openModelPath: async (path: string) => {
    await openModelPath(path);
  },
  pushRecent: addRecent,
  toast,
  status
};

async function openTexturePath(path: string): Promise<void> {
  showView('texture');
  updateTitle('贴图', basename(path));
  await textureView.loadPath(path);
}

async function openModelPath(path: string): Promise<void> {
  showView('model');
  updateTitle('模型', basename(path));
  await modelView.loadPath(path);
}

async function openTextureFile(file: File): Promise<void> {
  showView('texture');
  updateTitle('贴图', file.name);
  await textureView.loadFile(file);
  const path = (file as File & { path?: string }).path;
  if (path) addRecent('texture', path, file.name);
}

async function openModelFile(file: File): Promise<void> {
  showView('model');
  updateTitle('模型', file.name);
  await modelView.loadFile(file);
  const path = (file as File & { path?: string }).path;
  if (path) addRecent('model', path, file.name);
}

async function openColorPath(path: string): Promise<void> {
  showView('color');
  updateTitle('配色', basename(path));
  await colorView.loadPath(path);
}

async function openColorFile(file: File): Promise<void> {
  showView('color');
  updateTitle('配色', file.name);
  await colorView.loadFile(file);
}

async function openVideoPath(path: string): Promise<void> {
  showView('video');
  updateTitle('视频压缩', basename(path));
  await videoView.loadPath(path);
}

function showView(view: ViewName): void {
  if (currentView === 'texture') textureView.deactivate();
  if (currentView === 'model') modelView.deactivate();
  if (currentView === 'color') colorView.deactivate();
  if (currentView === 'gallery') galleryView.deactivate();
  if (currentView === 'textures') texturesView.deactivate();
  if (currentView === 'video') videoView.deactivate();
  if (currentView === 'videos') videosView.deactivate();

  currentView = view;
  homeView.element.classList.toggle('hidden', view !== 'home');
  textureView.element.classList.toggle('hidden', view !== 'texture');
  modelView.element.classList.toggle('hidden', view !== 'model');
  colorView.element.classList.toggle('hidden', view !== 'color');
  galleryView.element.classList.toggle('hidden', view !== 'gallery');
  texturesView.element.classList.toggle('hidden', view !== 'textures');
  videoView.element.classList.toggle('hidden', view !== 'video');
  videosView.element.classList.toggle('hidden', view !== 'videos');

  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', (button as HTMLElement).dataset.view === view);
  });

  if (view === 'home') {
    homeView.activate();
    updateTitle('首页');
  } else if (view === 'texture') {
    textureView.activate();
    updateTitle('贴图');
  } else if (view === 'color') {
    colorView.activate();
    updateTitle('配色');
  } else if (view === 'gallery') {
    void galleryView.activate();
    updateTitle('图库');
  } else if (view === 'textures') {
    void texturesView.activate();
    updateTitle('贴图资源');
  } else if (view === 'video') {
    void videoView.activate();
    updateTitle('视频压缩');
  } else if (view === 'videos') {
    void videosView.activate();
    updateTitle('视频作品');
  } else {
    modelView.activate();
    updateTitle('模型');
  }
}

async function captureScreenshot(): Promise<void> {
  const result = await window.nyxel.screenshot.capture();
  if (result.cancelled) return;
  if (result.ok) {
    if (result.copied) {
      toast('截图已复制到剪贴板，并存入图库', 'success');
      status.set(statusFile.textContent ?? '就绪', statusInfo.textContent ?? '', '截图：已复制并存入图库');
    } else {
      toast(`截图已保存并复制到剪贴板：${result.path ?? ''}`, 'success');
      status.set(statusFile.textContent ?? '就绪', statusInfo.textContent ?? '', `截图：${result.path ?? ''}`);
    }
  } else {
    toast(`截图失败：${result.error ?? '未知错误'}`, 'error');
  }
}

function bindWindowControls(): void {
  const titlebar = document.querySelector('#titlebar') as HTMLElement;
  const maximize = document.querySelector('#btn-max') as HTMLButtonElement;

  document.querySelector('#btn-min')?.addEventListener('click', () => void window.nyxel.window.minimize());
  document.querySelector('#btn-close')?.addEventListener('click', () => void window.nyxel.window.close());
  document.querySelector('#btn-settings')?.addEventListener('click', () => void settingsView.open(settings, appInfo));
  document.querySelector('#btn-about')?.addEventListener('click', () => aboutView.open(appInfo));
  document.querySelector('#btn-screenshot')?.addEventListener('click', () => void captureScreenshot());

  const toggleMaximize = async () => {
    const maximized = await window.nyxel.window.toggleMaximize();
    maximize.textContent = maximized ? '❐' : '□';
    maximize.title = maximized ? '还原' : '最大化';
  };
  maximize.addEventListener('click', () => void toggleMaximize());
  titlebar.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('.titlebar-actions')) return;
    void toggleMaximize();
  });
}

function bindKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey) return;
    if (event.key === '0') {
      event.preventDefault();
      showView('home');
    } else if (event.key === '1') {
      event.preventDefault();
      showView('texture');
    } else if (event.key === '2') {
      event.preventDefault();
      showView('model');
    } else if (event.key === '3') {
      event.preventDefault();
      showView('color');
    } else if (event.key === '4') {
      event.preventDefault();
      showView('gallery');
    } else if (event.key === '5') {
      event.preventDefault();
      showView('textures');
    } else if (event.key === '6') {
      event.preventDefault();
      showView('video');
    } else if (event.key === '7') {
      event.preventDefault();
      showView('videos');
    } else if (event.key === ',') {
      event.preventDefault();
      void settingsView.open(settings, appInfo);
    }
  });
}

function bindDrop(): void {
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (isModelFile(file.name)) {
      void openModelFile(file);
    } else if (isImageFile(file.name)) {
      if (currentView === 'color') void openColorFile(file);
      else void openTextureFile(file);
    } else {
      toast('只支持贴图图片或 .fbx 模型', 'error');
    }
  });
}

function bindNav(): void {
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.addEventListener('click', () => {
      showView(((button as HTMLElement).dataset.view as ViewName) ?? 'home');
    });
  });
}

async function bootstrap(): Promise<void> {
  settings = await window.nyxel.settings.load();
  appInfo = await window.nyxel.app.info();
  applyTheme(settings.theme);

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => {
    if (settings.theme === 'system') applyTheme('system');
  });

  homeView = new HomeView(callbacks, () => settings.recentProjects ?? []);
  colorView = new ColorView(toast, status, () => settings, saveSettings);
  textureView = new TextureView(callbacks, () => {
    showView('color');
  });
  modelView = new ModelView(callbacks);
  galleryView = new FilesView('gallery', callbacks);
  texturesView = new FilesView('textures', callbacks);
  videoView = new VideoView(callbacks);
  videosView = new FilesView('videos', callbacks);
  settingsView = new SettingsView(saveSettings, toast);
  aboutView = new AboutView(toast);

  workspace.append(
    homeView.element,
    textureView.element,
    modelView.element,
    colorView.element,
    galleryView.element,
    texturesView.element,
    videoView.element,
    videosView.element
  );
  textureView.element.classList.add('hidden');
  modelView.element.classList.add('hidden');
  colorView.element.classList.add('hidden');
  galleryView.element.classList.add('hidden');
  texturesView.element.classList.add('hidden');
  videoView.element.classList.add('hidden');
  videosView.element.classList.add('hidden');
  document.body.append(settingsView.element, aboutView.element);

  bindWindowControls();
  bindKeyboard();
  bindDrop();
  bindNav();

  window.nyxel.screenshot.onDone((data) => {
    if (data.cancelled) return;
    if (data.ok) {
      toast(data.copied ? '截图已复制到剪贴板，并存入图库' : `截图已保存并复制到剪贴板：${data.path ?? ''}`, 'success');
    } else {
      toast(`截图失败：${data.error ?? '未知错误'}`, 'error');
    }
  });

  window.__nyxel = {
    openTexturePath,
    openModelPath,
    openColorPath,
    openVideoPath,
    applyModelTexturePath: (path: string) => modelView.applyExternalTexturePath(path)
  };

  showView('home');
  status.set('就绪', '', '');

  if (!appInfo.hotkeyRegistered) {
    toast(`截图热键 ${settings.screenshotHotkey} 注册失败，可能已被其他程序占用`, 'error');
  }

  const maximized = await window.nyxel.window.isMaximized();
  const maximizeButton = document.querySelector('#btn-max') as HTMLButtonElement;
  maximizeButton.textContent = maximized ? '❐' : '□';

  if (settings.restoreWorkspace && settings.recentProjects?.length && !window.nyxel.test?.noRestoreWorkspace) {
    window.setTimeout(() => {
      const recent = settings.recentProjects[0];
      if (recent.type === 'model') void openModelPath(recent.path);
      else void openTexturePath(recent.path);
    }, 500);
  }
}

void bootstrap();

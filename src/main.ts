import './styles.css';
import logoUrl from './assets/app-icon-face.png';
import { audioMonitor } from './lib/audio-monitor';
import { startTitleWave } from './lib/title-wave';
import type { AccountUser, AppInfo, RecentProject, Settings, StatusApi, ToastApi, ToastKind, UpdateCheckResult, ViewName } from './types';
import { AboutView } from './views/about';
import { AccountView } from './views/account';
import { ColorView } from './views/color';
import { DownloadView } from './views/download';
import { DrawView } from './views/draw';
import { FilesView } from './views/files';
import { HomeView } from './views/home';
import { ModelView } from './views/model';
import { NotesView } from './views/notes';
import { SettingsView } from './views/settings';
import { TextureView } from './views/texture';
import { VideoView } from './views/video';
import { basename, isImageFile, isModelFile } from './utils';

const appRoot = document.querySelector('#app') as HTMLElement;
appRoot.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <button class="logo-button" id="btn-account" type="button" title="登录 / 注册" aria-label="登录或注册账号">
        <img class="logo" src="${logoUrl}" alt="Texture map" draggable="false" />
        <span class="logo-status" id="logo-status" aria-hidden="true"></span>
        <span class="logo-tooltip" id="logo-tooltip">登录 / 注册</span>
      </button>
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
        <button class="nav-button" data-view="notes" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h9l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z"/><path d="M15 3.5V8h4M8 12h7M8 15.5h7"/></svg>
          <span class="nav-tooltip">备忘录 Ctrl+Shift+N</span>
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
        <div class="nav-divider"></div>
        <div class="nav-section-title">工具</div>
        <button class="nav-button" data-view="draw" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16z"/><path d="m13.8 6.5 3.7 3.7M4 20l1-4.2"/></svg>
          <span class="nav-tooltip">绘画 Ctrl+8</span>
        </button>
        <button class="nav-button" data-view="download" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>
          <span class="nav-tooltip">下载 Ctrl+9</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button class="about-button" id="btn-about" type="button" title="关于我们">!</button>
        <div class="sidebar-footer">v0.2</div>
      </div>
    </aside>
    <div class="main">
      <header class="titlebar" id="titlebar">
        <canvas class="titlebar-wave" id="titlebar-wave" aria-hidden="true"></canvas>
        <div class="titlebar-title" id="titlebar-title">当前：<strong>首页</strong></div>
        <div class="titlebar-actions">
          <button id="btn-screenshot" type="button" title="截图（Ctrl+Alt+A）">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6.5" r="2.4"/><circle cx="6" cy="17.5" r="2.4"/><path d="M8.2 7.6 20 18.5M8.2 16.4 20 5.5"/></svg>
          </button>
          <button id="btn-settings" type="button" title="设置（Ctrl+,）">⚙</button>
          <button id="btn-min" type="button" title="最小化">─</button>
          <button id="btn-max" type="button" title="最大化">□</button>
          <button id="btn-close" class="close" type="button" title="关闭">×</button>
        </div>
      </header>
      <div class="update-banner hidden" id="update-banner">
        <span class="update-banner-icon" aria-hidden="true">↑</span>
        <div class="update-banner-text">
          <strong id="update-banner-title">发现新版本</strong>
          <span id="update-banner-sub"></span>
        </div>
        <a class="update-banner-action" id="update-banner-action" href="https://github.com/ANSEN2026/Nyxel/releases" target="_blank" rel="noreferrer">下载更新</a>
        <button type="button" id="update-banner-dismiss">稍后</button>
        <button type="button" class="update-banner-close" id="update-banner-close" aria-label="关闭更新提示">×</button>
      </div>
      <section class="workspace" id="workspace"></section>
      <footer class="statusbar">
        <span class="status-dot"></span>
        <span class="status-file" id="status-file">就绪</span>
        <span class="status-info" id="status-info"></span>
        <span class="status-log" id="status-log"></span>
      </footer>
    </div>
  </div>
  <aside class="sponsor-card" id="sponsor-card" aria-label="赞助支持 Texture map" hidden>
    <button class="sponsor-close" type="button" data-sponsor-close aria-label="关闭赞助提示">×</button>
    <div class="sponsor-top">
      <span class="sponsor-avatar" aria-hidden="true">爱</span>
      <div class="sponsor-copy">
        <strong>喜欢 Texture map？</strong>
        <p>可以请开发者喝杯咖啡，支持它继续更新。</p>
      </div>
    </div>
    <a class="sponsor-cta" href="https://ifdian.net/a/nyxelstudio" target="_blank" rel="noreferrer">
      去爱发电支持 <span aria-hidden="true">↗</span>
    </a>
  </aside>
  <div class="toast-container" id="toast-container"></div>
`;

const workspace = document.querySelector('#workspace') as HTMLElement;
const titlebarTitle = document.querySelector('#titlebar-title') as HTMLElement;
const statusFile = document.querySelector('#status-file') as HTMLElement;
const statusInfo = document.querySelector('#status-info') as HTMLElement;
const statusLog = document.querySelector('#status-log') as HTMLElement;
const toastContainer = document.querySelector('#toast-container') as HTMLElement;
const sponsorCard = document.querySelector('#sponsor-card') as HTMLElement | null;
const updateBanner = document.querySelector('#update-banner') as HTMLElement | null;
const updateBannerTitle = document.querySelector('#update-banner-title') as HTMLElement | null;
const updateBannerSub = document.querySelector('#update-banner-sub') as HTMLElement | null;
const updateBannerAction = document.querySelector('#update-banner-action') as HTMLAnchorElement | null;
const titleWaveCanvas = document.querySelector('#titlebar-wave') as HTMLCanvasElement | null;
if (titleWaveCanvas) startTitleWave(titleWaveCanvas);

let updateCheckInFlight = false;
let lastAutoUpdateCheck = 0;
let pendingUpdateVersion = '';
let dismissedUpdateVersion = '';

function showUpdateBanner(result: UpdateCheckResult): void {
  if (!updateBanner || !result.latestVersion) return;
  pendingUpdateVersion = result.latestVersion;
  if (updateBannerTitle) updateBannerTitle.textContent = `发现新版本 v${result.latestVersion}`;
  if (updateBannerSub) {
    updateBannerSub.textContent = `当前 v${result.currentVersion}${result.channel === 'beta' ? ' · 测试频道' : ''}`;
  }
  if (updateBannerAction) {
    updateBannerAction.href = result.downloadUrl || result.releaseUrl || 'https://github.com/ANSEN2026/Nyxel/releases';
  }
  updateBanner.classList.remove('hidden');
}

function dismissUpdateBanner(): void {
  updateBanner?.classList.add('hidden');
  if (pendingUpdateVersion) dismissedUpdateVersion = pendingUpdateVersion;
}

async function autoCheckForUpdates(): Promise<void> {
  if (updateCheckInFlight || !navigator.onLine) return;
  const now = Date.now();
  if (now - lastAutoUpdateCheck < 5 * 60 * 1000) return;
  lastAutoUpdateCheck = now;
  updateCheckInFlight = true;
  try {
    const result = await window.nyxel.update.check();
    if (!result.ok || !result.hasUpdate || !result.latestVersion) return;
    if (result.latestVersion === dismissedUpdateVersion) return;
    showUpdateBanner(result);
  } catch {
    // Offline or GitHub unavailable: update checks stay silent.
  } finally {
    updateCheckInFlight = false;
  }
}

document.querySelector('#update-banner-dismiss')?.addEventListener('click', dismissUpdateBanner);
document.querySelector('#update-banner-close')?.addEventListener('click', dismissUpdateBanner);

const SPONSOR_VISIBLE_MS = 12_000;
let sponsorDismissTimer: number | null = null;
let sponsorCollapseTimer: number | null = null;

function clearSponsorTimers(): void {
  if (sponsorDismissTimer !== null) {
    window.clearTimeout(sponsorDismissTimer);
    sponsorDismissTimer = null;
  }
  if (sponsorCollapseTimer !== null) {
    window.clearTimeout(sponsorCollapseTimer);
    sponsorCollapseTimer = null;
  }
}

function scheduleSponsorDismiss(): void {
  if (sponsorDismissTimer !== null) window.clearTimeout(sponsorDismissTimer);
  sponsorDismissTimer = window.setTimeout(() => dismissSponsorCard(), SPONSOR_VISIBLE_MS);
}

function dismissSponsorCard(): void {
  if (!sponsorCard) return;
  clearSponsorTimers();
  sponsorCard.classList.remove('show');
  toastContainer.classList.remove('sponsor-offset');
  sponsorCollapseTimer = window.setTimeout(() => {
    if (!sponsorCard.classList.contains('show')) sponsorCard.hidden = true;
    sponsorCollapseTimer = null;
  }, 240);
}

function showSponsorCard(): void {
  if (!sponsorCard) return;
  clearSponsorTimers();
  sponsorCard.hidden = false;
  toastContainer.classList.add('sponsor-offset');
  void sponsorCard.offsetWidth;
  sponsorCard.classList.add('show');
  scheduleSponsorDismiss();
}

if (sponsorCard) {
  sponsorCard.querySelector('[data-sponsor-close]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    dismissSponsorCard();
  });
  sponsorCard.addEventListener('pointerenter', () => {
    if (sponsorDismissTimer !== null) {
      window.clearTimeout(sponsorDismissTimer);
      sponsorDismissTimer = null;
    }
  });
  sponsorCard.addEventListener('pointerleave', () => {
    if (sponsorCard.classList.contains('show')) scheduleSponsorDismiss();
  });
  sponsorCard.addEventListener('focusin', () => {
    if (sponsorDismissTimer !== null) {
      window.clearTimeout(sponsorDismissTimer);
      sponsorDismissTimer = null;
    }
  });
  sponsorCard.addEventListener('focusout', (event) => {
    if (sponsorCard.classList.contains('show') && !sponsorCard.contains(event.relatedTarget as Node | null)) {
      scheduleSponsorDismiss();
    }
  });
}

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
let drawView: DrawView;
let downloadView: DownloadView;
let notesView: NotesView;
let settingsView: SettingsView;
let aboutView: AboutView;
let accountView: AccountView;

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

function applyAccountIndicator(user: AccountUser | null): void {
  const button = document.querySelector('#btn-account') as HTMLButtonElement | null;
  const tooltip = document.querySelector('#logo-tooltip') as HTMLElement | null;
  const signedIn = Boolean(user);
  button?.classList.toggle('signed-in', signedIn);
  if (button) {
    button.title = user ? `账号：${user.displayName}` : '登录 / 注册';
    button.setAttribute('aria-label', user ? `账号：${user.displayName}` : '登录或注册账号');
  }
  if (tooltip) tooltip.textContent = user ? user.displayName : '登录 / 注册';
}

async function applyAudioMonitor(enabled: boolean, notify = false): Promise<void> {
  titleWaveCanvas?.classList.toggle('hidden', !enabled);
  if (!enabled) {
    audioMonitor.stop();
    return;
  }
  if (audioMonitor.isActive) return;
  try {
    await audioMonitor.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('audio monitor unavailable', message);
    if (notify) toast(`系统音频监听未启动：${message}`, 'error');
  }
}

async function saveSettings(next: Settings): Promise<void> {
  const previousHotkey = settings?.screenshotHotkey;
  const previousTheme = settings?.theme;
  const previousAudio = settings?.audioVisualizer;
  settings = await window.nyxel.settings.save(next);
  if (settings.theme !== previousTheme) applyTheme(settings.theme);
  if (settings.audioVisualizer !== previousAudio) {
    void applyAudioMonitor(settings.audioVisualizer, true);
  }
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
  if (currentView === 'draw') drawView.deactivate();
  if (currentView === 'download') downloadView.deactivate();
  if (currentView === 'notes') notesView.deactivate();

  currentView = view;
  homeView.element.classList.toggle('hidden', view !== 'home');
  textureView.element.classList.toggle('hidden', view !== 'texture');
  modelView.element.classList.toggle('hidden', view !== 'model');
  colorView.element.classList.toggle('hidden', view !== 'color');
  galleryView.element.classList.toggle('hidden', view !== 'gallery');
  texturesView.element.classList.toggle('hidden', view !== 'textures');
  videoView.element.classList.toggle('hidden', view !== 'video');
  videosView.element.classList.toggle('hidden', view !== 'videos');
  drawView.element.classList.toggle('hidden', view !== 'draw');
  downloadView.element.classList.toggle('hidden', view !== 'download');
  notesView.element.classList.toggle('hidden', view !== 'notes');

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
  } else if (view === 'draw') {
    drawView.activate();
    updateTitle('绘画');
  } else if (view === 'download') {
    downloadView.activate();
    updateTitle('下载');
  } else if (view === 'notes') {
    void notesView.activate();
    updateTitle('备忘录');
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
  document.querySelector('#btn-account')?.addEventListener('click', () => void accountView.open());
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
    if (event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      showView('notes');
      return;
    }
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
    } else if (event.key === '8') {
      event.preventDefault();
      showView('draw');
    } else if (event.key === '9') {
      event.preventDefault();
      showView('download');
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
  drawView = new DrawView(callbacks);
  downloadView = new DownloadView(callbacks);
  notesView = new NotesView(callbacks);
  settingsView = new SettingsView(saveSettings, toast);
  aboutView = new AboutView(toast);
  accountView = new AccountView(toast, applyAccountIndicator);

  workspace.append(
    homeView.element,
    textureView.element,
    modelView.element,
    colorView.element,
    galleryView.element,
    texturesView.element,
    videoView.element,
    videosView.element,
    drawView.element,
    downloadView.element,
    notesView.element
  );
  textureView.element.classList.add('hidden');
  modelView.element.classList.add('hidden');
  colorView.element.classList.add('hidden');
  galleryView.element.classList.add('hidden');
  texturesView.element.classList.add('hidden');
  videoView.element.classList.add('hidden');
  videosView.element.classList.add('hidden');
  drawView.element.classList.add('hidden');
  downloadView.element.classList.add('hidden');
  notesView.element.classList.add('hidden');
  document.body.append(settingsView.element, aboutView.element, accountView.element);

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
  window.setTimeout(() => showSponsorCard(), 1000);
  window.setTimeout(() => void autoCheckForUpdates(), 3500);
  window.addEventListener('online', () => {
    lastAutoUpdateCheck = 0;
    void autoCheckForUpdates();
  });
  window.setInterval(() => {
    if (!document.hidden) void autoCheckForUpdates();
  }, 6 * 60 * 60 * 1000);
  void window.nyxel.account.status()
    .then((state) => applyAccountIndicator(state.user))
    .catch(() => applyAccountIndicator(null));
  void applyAudioMonitor(settings.audioVisualizer, false);

  if (!appInfo.hotkeyRegistered) {
    toast(`截图热键 ${settings.screenshotHotkey} 注册失败，可能已被其他程序占用`, 'error');
  }

  const maximized = await window.nyxel.window.isMaximized();
  const maximizeButton = document.querySelector('#btn-max') as HTMLButtonElement;
  maximizeButton.textContent = maximized ? '❐' : '□';
}

void bootstrap();

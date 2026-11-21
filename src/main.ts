import './styles.css';
import logoUrl from './assets/app-icon-face.png';
import { MOTION_CAPTURE_ENABLED } from './feature-flags';
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
import { MotionCaptureView } from './motion_capture/view';
import { NotesView } from './views/notes';
import { SettingsView } from './views/settings';
import { setUndoHistoryLimit } from './lib/undo-history';
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
        <button class="nav-button active" data-view="home" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.8 12 4l8 6.8"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5.5h4V20"/></svg>
          <span class="nav-tooltip">首页 Ctrl+0</span>
        </button>
        <button class="nav-button" data-view="texture" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2.2"/><circle cx="8.3" cy="8.8" r="1.4"/><path d="m4.5 16.8 4.6-4.3 3.2 2.8 3-2.7 4.2 4"/></svg>
          <span class="nav-tooltip">贴图 Ctrl+1</span>
        </button>
        <button class="nav-button" data-view="model" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.2 8.2 4.6v8.4L12 20.8l-8.2-4.6V7.8z"/><path d="m3.8 7.8 8.2 4.6 8.2-4.6M12 12.4v8.4"/></svg>
          <span class="nav-tooltip">模型 Ctrl+2</span>
        </button>
        <button class="nav-button" data-view="color" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6a8.4 8.4 0 1 0 0 16.8h1.2a1.9 1.9 0 0 0 0-3.8h-1.1a1.7 1.7 0 0 1 0-3.4h2.4a4.3 4.3 0 0 0 0-8.6z"/><circle cx="8.4" cy="9.8" r=".95" fill="currentColor" stroke="none"/><circle cx="10.4" cy="6.8" r=".95" fill="currentColor" stroke="none"/><circle cx="14.1" cy="7.5" r=".95" fill="currentColor" stroke="none"/></svg>
          <span class="nav-tooltip">配色 Ctrl+3</span>
        </button>
        <div class="nav-divider"></div>
        <div class="nav-section-title">文件</div>
        <button class="nav-button" data-view="gallery" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4"/></svg>
          <span class="nav-tooltip">图库 Ctrl+4</span>
        </button>
        <button class="nav-button" data-view="textures" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="12" height="12" rx="2"/><path d="M16.5 4H6a2 2 0 0 0-2 2v10.5"/><circle cx="11" cy="10.8" r="1.1"/><path d="m8.3 16.7 2.9-2.9 2.2 2 2-2 2.4 2.7"/></svg>
          <span class="nav-tooltip">贴图资源 Ctrl+5</span>
        </button>
        <button class="nav-button" data-view="notes" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 3.8h8.2l3.8 3.8V20H6.2z"/><path d="M14.4 3.8v3.9h3.8M9 12h6M9 15.5h6"/></svg>
          <span class="nav-tooltip">备忘录 Ctrl+Shift+N</span>
        </button>
        <div class="nav-divider"></div>
        <div class="nav-section-title">媒体</div>
        <button class="nav-button" data-view="video" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.2"/><path d="m9 9 4 2.6-4 2.6z"/><path d="M16.8 9v4.2M15.6 12l1.2 1.2 1.2-1.2"/></svg>
          <span class="nav-tooltip">视频压缩 Ctrl+6</span>
        </button>
        <button class="nav-button" data-view="videos" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17M7 5v4M17 5v4"/><path d="m10 12.2 4.2 2.4-4.2 2.4z"/></svg>
          <span class="nav-tooltip">视频作品 Ctrl+7</span>
        </button>
        <div class="nav-divider"></div>
        <div class="nav-section-title">工具</div>
        <button class="nav-button" data-view="draw" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.2 19.8 4-1 11-11a2.1 2.1 0 0 0-3-3l-11 11z"/><path d="m13.7 6.3 3.9 3.9M4.2 19.8l1-4"/></svg>
          <span class="nav-tooltip">绘画 Ctrl+8</span>
        </button>
        <button class="nav-button${MOTION_CAPTURE_ENABLED ? '' : ' hidden'}" data-view="motion" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.4" r="2"/><path d="M12 6.4v6.8M12 9.3 8.2 11.5M12 9.3l3.8 2.2M12 13.2l-3.1 6M12 13.2l3.1 6"/></svg>
          <span class="nav-tooltip">从视频生成动作 Ctrl+Shift+M</span>
        </button>
        <button class="nav-button" data-view="download" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11.8"/><path d="m7.4 10.7 4.6 4.6 4.6-4.6"/><path d="M4.5 20h15"/></svg>
          <span class="nav-tooltip">下载 Ctrl+9</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button class="about-button" id="btn-about" type="button" title="关于我们" aria-label="关于我们">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M12 11v6"/><circle cx="12" cy="7.7" r=".9" fill="currentColor" stroke="none"/></svg>
        </button>
        <div class="sidebar-footer">v1.0</div>
      </div>
    </aside>
    <div class="main">
      <header class="titlebar" id="titlebar">
        <canvas class="titlebar-wave" id="titlebar-wave" aria-hidden="true"></canvas>
        <div class="titlebar-title" id="titlebar-title">当前：<strong>首页</strong></div>
        <div class="titlebar-actions">
          <button id="btn-update" class="update-button" type="button" title="检查更新" aria-label="检查更新">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M12 16.2V7.8M8.6 11.2 12 7.8l3.4 3.4"/></svg>
          </button>
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
const sidebarFooter = document.querySelector('.sidebar-footer') as HTMLElement | null;
const toastContainer = document.querySelector('#toast-container') as HTMLElement;
const sponsorCard = document.querySelector('#sponsor-card') as HTMLElement | null;
const updateBanner = document.querySelector('#update-banner') as HTMLElement | null;
const updateBannerTitle = document.querySelector('#update-banner-title') as HTMLElement | null;
const updateBannerSub = document.querySelector('#update-banner-sub') as HTMLElement | null;
const updateBannerAction = document.querySelector('#update-banner-action') as HTMLAnchorElement | null;
const updateButton = document.querySelector('#btn-update') as HTMLButtonElement | null;
const titleWaveCanvas = document.querySelector('#titlebar-wave') as HTMLCanvasElement | null;
if (titleWaveCanvas) startTitleWave(titleWaveCanvas);

let updateCheckInFlight = false;
let lastAutoUpdateCheck = 0;
let pendingUpdate: UpdateCheckResult | null = null;

function setUpdateIndicator(result: UpdateCheckResult | null): void {
  if (!updateButton) return;
  const available = Boolean(result?.ok && result.hasUpdate && result.latestVersion);
  updateButton.classList.toggle('has-update', available);
  const title = available ? `发现新版本 v${result?.latestVersion}，点击查看` : '检查更新';
  updateButton.title = title;
  updateButton.setAttribute('aria-label', title);
}

function showUpdateBanner(result: UpdateCheckResult): void {
  if (!updateBanner || !result.latestVersion) return;
  pendingUpdate = result;
  setUpdateIndicator(result);
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
}

async function autoCheckForUpdates(): Promise<void> {
  if (updateCheckInFlight || !navigator.onLine) return;
  const now = Date.now();
  if (now - lastAutoUpdateCheck < 5 * 60 * 1000) return;
  lastAutoUpdateCheck = now;
  updateCheckInFlight = true;
  try {
    const result = await window.nyxel.update.check();
    if (!result.ok) return;
    pendingUpdate = result.hasUpdate && result.latestVersion ? result : null;
    setUpdateIndicator(pendingUpdate);
  } catch {
    // Offline or GitHub unavailable: update checks stay silent.
  } finally {
    updateCheckInFlight = false;
  }
}

async function checkForUpdatesManually(): Promise<void> {
  if (!updateButton || updateCheckInFlight) return;
  if (pendingUpdate) {
    showUpdateBanner(pendingUpdate);
    return;
  }
  updateCheckInFlight = true;
  updateButton.classList.add('checking');
  try {
    const result = await window.nyxel.update.check();
    pendingUpdate = result.ok && result.hasUpdate && result.latestVersion ? result : null;
    setUpdateIndicator(pendingUpdate);
    if (pendingUpdate) {
      showUpdateBanner(pendingUpdate);
      toast(`发现新版本 v${pendingUpdate.latestVersion}`, 'success');
    } else if (result.ok) {
      toast('当前已是最新版本', 'info');
    } else {
      toast('更新检查失败，请稍后再试', 'error');
    }
  } catch {
    toast('更新检查失败，请检查网络', 'error');
  } finally {
    updateCheckInFlight = false;
    updateButton.classList.remove('checking');
  }
}

updateButton?.addEventListener('click', () => void checkForUpdatesManually());
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
let motionView: MotionCaptureView;
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
  setUndoHistoryLimit(settings.undoHistoryLimit);
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
  if (currentView === 'motion') motionView.deactivate();
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
  motionView.element.classList.toggle('hidden', view !== 'motion');
  downloadView.element.classList.toggle('hidden', view !== 'download');
  notesView.element.classList.toggle('hidden', view !== 'notes');

  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', (button as HTMLElement).dataset.view === view);
  });

  const viewLabels: Record<ViewName, string> = {
    home: '首页',
    texture: '贴图',
    model: '模型',
    color: '配色',
    gallery: '图库',
    textures: '贴图资源',
    video: '视频压缩',
    videos: '视频作品',
    draw: '绘画',
    motion: '从视频生成动作',
    download: '下载',
    notes: '备忘录'
  };
  status.set(viewLabels[view], '', '');

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
  } else if (view === 'motion') {
    void motionView.activate();
    updateTitle('从视频生成动作');
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
    if (MOTION_CAPTURE_ENABLED && event.shiftKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      showView('motion');
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
      if (currentView === 'model') void modelView.applyExternalTextureFile(file);
      else if (currentView === 'color') void openColorFile(file);
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
  setUndoHistoryLimit(settings.undoHistoryLimit);
  appInfo = await window.nyxel.app.info();
  if (sidebarFooter) sidebarFooter.textContent = `v${appInfo.version}`;
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
  motionView = new MotionCaptureView(callbacks, { autoRefresh: MOTION_CAPTURE_ENABLED });
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
    motionView.element,
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
  motionView.element.classList.add('hidden');
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
    openMotionPath: async (path: string) => {
      if (!MOTION_CAPTURE_ENABLED) return;
      showView('motion');
      updateTitle('从视频生成动作', basename(path));
      motionView.loadPath(path);
    },
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

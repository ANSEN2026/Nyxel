import { audioMonitor } from '../lib/audio-monitor';
import type { AppInfo, Settings, Theme, ToastApi } from '../types';

export class SettingsView {
  readonly element: HTMLElement;

  private current: Settings | null = null;
  private appInfo: AppInfo | null = null;
  private saveHandler: (settings: Settings) => Promise<void>;
  private toast: ToastApi;
  private body: HTMLElement;
  private updateUrl = '';
  private audioStatus: HTMLElement | null = null;
  private audioTimer = 0;

  constructor(saveHandler: (settings: Settings) => Promise<void>, toast: ToastApi) {
    this.saveHandler = saveHandler;
    this.toast = toast;
    this.element = document.createElement('div');
    this.element.className = 'settings-overlay hidden';
    this.element.innerHTML = `
      <div class="settings-panel">
        <div class="settings-header">
          <h2>设置</h2>
          <button class="ghost" data-action="close" title="关闭">×</button>
        </div>
        <div class="settings-body">
          <section class="settings-section">
            <h3>外观</h3>
            <div class="settings-row">
              <div class="settings-label">主题</div>
              <div class="settings-control">
                <select id="set-theme">
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                  <option value="system">跟随系统</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">语言</div>
              <div class="settings-control">
                <select id="set-language">
                  <option value="system">跟随系统</option>
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3>配色</h3>
            <div class="settings-row">
              <div class="settings-label">提取色数</div>
              <div class="settings-control">
                <select id="set-color-count">
                  <option value="4">4 色</option>
                  <option value="6">6 色</option>
                  <option value="8">8 色</option>
                  <option value="12">12 色</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">占比口径</div>
              <div class="settings-control">
                <select id="set-color-ratio">
                  <option value="perceptual">感知占比</option>
                  <option value="pixel">像素占比</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">忽略接近纯黑 / 纯白</div>
              <div class="settings-control">
                <input id="set-color-ignore" class="toggle" type="checkbox">
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">透明像素阈值</div>
              <div class="settings-control">
                <input id="set-color-alpha" type="text" inputmode="decimal">
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3>通用</h3>
            <div class="settings-row">
              <div class="settings-label">默认保存与导出目录</div>
              <div class="settings-control">
                <input id="set-export-dir" type="text" spellcheck="false">
                <button data-action="browse-export">浏览…</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">截图默认保存位置</div>
              <div class="settings-control">
                <input id="set-screenshot-dir" type="text" spellcheck="false">
                <button data-action="browse-screenshot">浏览…</button>
              </div>
            </div>
            <div class="settings-hint">截图后会先打开预览窗口，可标记、批准，再选择最终保存位置；这里只是保存对话框的默认目录。</div>
          </section>

          <section class="settings-section">
            <h3>性能</h3>
            <div class="settings-row">
              <div class="settings-label">硬件加速</div>
              <div class="settings-control">
                <input id="set-hw" class="toggle" type="checkbox">
                <span class="settings-hint">修改后重启 Texture map 生效</span>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">缓存目录</div>
              <div class="settings-control">
                <span class="value" id="set-cache-dir">—</span>
                <button class="danger" data-action="clear-cache">清空缓存</button>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3>媒体</h3>
            <div class="settings-row">
              <div class="settings-label">ffmpeg 运行时</div>
              <div class="settings-control">
                <input id="set-ffmpeg" type="text" placeholder="首次压缩时自动下载" disabled>
              </div>
            </div>
            <div class="settings-hint">视频压缩工作区会在首次使用时下载 ffmpeg，并保存在本机运行时目录，之后可离线使用。</div>
            <div class="settings-row" style="margin-top:10px">
              <div class="settings-label">标题栏音乐波动</div>
              <div class="settings-control">
                <input id="set-audio-visualizer" class="toggle" type="checkbox">
              </div>
            </div>
            <div class="settings-hint" id="set-audio-status">默认开启；监听 Windows 系统输出用于标题栏波动，只分析，不录音、不上传。关闭后不会捕获音频。</div>
            <div class="settings-row" style="margin-top:10px">
              <div class="settings-label">视频记事本目录</div>
              <div class="settings-control">
                <input id="set-video-note-dir" type="text" spellcheck="false">
                <button data-action="browse-video-notes">浏览…</button>
                <button data-action="open-video-notes">打开</button>
              </div>
            </div>
            <div class="settings-hint">记事本默认关闭；只有在视频播放器里点击「开始复盘」才会在这里新建文档。</div>
          </section>

          <section class="settings-section">
            <h3>快捷键</h3>
            <div class="settings-row">
              <div class="settings-label">截图热键</div>
              <div class="settings-control">
                <input id="set-hotkey" type="text" spellcheck="false">
                <button data-action="apply-hotkey">应用</button>
              </div>
            </div>
            <div class="settings-hint">若热键被 QQ / 微信占用，注册会失败并提示。截图支持多屏框选。</div>
          </section>

          <section class="settings-section">
            <h3>更新</h3>
            <div class="settings-row">
              <div class="settings-label">更新通道</div>
              <div class="settings-control">
                <select id="set-channel">
                  <option value="stable">稳定</option>
                  <option value="beta">测试（含 Alpha）</option>
                </select>
              </div>
            </div>
            <div class="settings-hint" id="set-update-status">点击「检查更新」会访问 GitHub Releases；稳定频道只检查正式版，测试频道包含 Alpha / Beta。</div>
          </section>

          <section class="settings-section">
            <h3>关于</h3>
            <div class="about-box">
              <div><strong>Texture map</strong> <span id="set-version">v0.2</span> · v0.2 正式版</div>
              <div id="set-runtime" class="muted"></div>
              <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                <button data-action="check-update">检查更新</button>
                <button data-action="open-update" class="hidden">下载更新</button>
                <button data-action="licenses">许可清单</button>
                <button data-action="privacy">隐私说明</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;

    this.body = this.element.querySelector('.settings-body') as HTMLElement;
    this.audioStatus = this.element.querySelector('#set-audio-status');
    this.bind();
  }

  private bind(): void {
    this.element.querySelector('[data-action="close"]')?.addEventListener('click', () => this.close());
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.element.classList.contains('hidden')) this.close();
    });

    const theme = this.element.querySelector('#set-theme') as HTMLSelectElement;
    const language = this.element.querySelector('#set-language') as HTMLSelectElement;
    const exportDir = this.element.querySelector('#set-export-dir') as HTMLInputElement;
    const screenshotDir = this.element.querySelector('#set-screenshot-dir') as HTMLInputElement;
    const videoNoteDir = this.element.querySelector('#set-video-note-dir') as HTMLInputElement;
    const hardware = this.element.querySelector('#set-hw') as HTMLInputElement;
    const channel = this.element.querySelector('#set-channel') as HTMLSelectElement;
    const colorCount = this.element.querySelector('#set-color-count') as HTMLSelectElement;
    const colorRatio = this.element.querySelector('#set-color-ratio') as HTMLSelectElement;
    const colorIgnore = this.element.querySelector('#set-color-ignore') as HTMLInputElement;
    const colorAlpha = this.element.querySelector('#set-color-alpha') as HTMLInputElement;

    theme.addEventListener('change', () => {
      this.patch({ theme: theme.value as Theme });
    });
    language.addEventListener('change', () => {
      this.patch({ language: language.value as Settings['language'] });
    });
    exportDir.addEventListener('change', () => {
      this.patch({ exportDir: exportDir.value.trim() });
    });
    screenshotDir.addEventListener('change', () => {
      this.patch({ screenshotDir: screenshotDir.value.trim() });
    });
    hardware.addEventListener('change', () => {
      this.patch({ hardwareAcceleration: hardware.checked });
    });
    channel.addEventListener('change', () => {
      this.patch({ updateChannel: channel.value as Settings['updateChannel'] });
    });
    colorCount.addEventListener('change', () => {
      this.patch({ colorCount: Number(colorCount.value) || 6 });
    });
    colorRatio.addEventListener('change', () => {
      this.patch({ colorRatioMode: colorRatio.value as Settings['colorRatioMode'] });
    });
    colorIgnore.addEventListener('change', () => {
      this.patch({ colorIgnoreNearBW: colorIgnore.checked });
    });
    colorAlpha.addEventListener('change', () => {
      const value = Number(colorAlpha.value);
      this.patch({ colorAlphaThreshold: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.05 });
    });

    this.element.querySelector('[data-action="browse-export"]')?.addEventListener('click', async () => {
      const selected = await window.nyxel.dialog.openDirectory();
      if (!selected) return;
      exportDir.value = selected;
      this.patch({ exportDir: selected });
    });
    this.element.querySelector('[data-action="browse-screenshot"]')?.addEventListener('click', async () => {
      const selected = await window.nyxel.dialog.openDirectory();
      if (!selected) return;
      screenshotDir.value = selected;
      this.patch({ screenshotDir: selected });
    });
    this.element.querySelector('[data-action="browse-video-notes"]')?.addEventListener('click', async () => {
      const selected = await window.nyxel.dialog.openDirectory();
      if (!selected) return;
      videoNoteDir.value = selected;
      this.patch({ videoNoteDir: selected });
    });
    this.element.querySelector('[data-action="open-video-notes"]')?.addEventListener('click', async () => {
      const target = videoNoteDir.value.trim();
      if (!target) return;
      const error = await window.nyxel.app.openPath(target);
      if (error) this.toast(`打开记事本目录失败：${error}`, 'error');
    });

    const audioVisualizer = this.element.querySelector('#set-audio-visualizer') as HTMLInputElement;
    audioVisualizer.addEventListener('change', () => {
      this.patch({ audioVisualizer: audioVisualizer.checked });
      this.updateAudioStatus();
    });

    this.element.querySelector('[data-action="clear-cache"]')?.addEventListener('click', async () => {
      if (!window.confirm('确定清空 Texture map 缓存？不会删除你的原始文件。')) return;
      try {
        await window.nyxel.app.clearCache();
        this.toast('缓存已清空', 'success');
      } catch (error) {
        this.toast(`清空缓存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    });

    this.element.querySelector('[data-action="apply-hotkey"]')?.addEventListener('click', async () => {
      if (!this.current) return;
      const hotkey = (this.element.querySelector('#set-hotkey') as HTMLInputElement).value.trim();
      if (!hotkey) return;
      const result = await window.nyxel.screenshot.setHotkey(hotkey);
      if (result.ok) {
        this.patch({ screenshotHotkey: hotkey });
        this.toast(`截图热键已设为 ${hotkey}`, 'success');
      } else {
        this.toast(`热键 ${hotkey} 注册失败，可能已被其他程序占用`, 'error');
      }
    });

    const checkUpdateButton = this.element.querySelector('[data-action="check-update"]') as HTMLButtonElement | null;
    const openUpdateButton = this.element.querySelector('[data-action="open-update"]') as HTMLButtonElement | null;
    checkUpdateButton?.addEventListener('click', async () => {
      if (!checkUpdateButton || this.appInfo?.windowsStore) return;
      const status = this.element.querySelector('#set-update-status') as HTMLElement | null;
      checkUpdateButton.disabled = true;
      checkUpdateButton.textContent = '检查中…';
      openUpdateButton?.classList.add('hidden');
      this.updateUrl = '';
      if (status) status.textContent = '正在访问 GitHub Releases…';
      try {
        const result = await window.nyxel.update.check();
        if (!result.ok) {
          if (status) status.textContent = `检查失败：${result.error ?? '未知错误'}`;
          this.toast(`检查更新失败：${result.error ?? '未知错误'}`, 'error');
          return;
        }
        if (result.hasUpdate) {
          this.updateUrl = result.downloadUrl ?? result.releaseUrl ?? '';
          if (status) {
            status.textContent = `发现新版本 ${result.latestTag ?? result.latestVersion}（当前 v${result.currentVersion}）`;
          }
          openUpdateButton?.classList.remove('hidden');
          this.toast(`发现新版本 ${result.latestTag ?? result.latestVersion}`, 'success');
        } else {
          if (status) status.textContent = result.message ?? `已是最新版本（v${result.currentVersion}）`;
          this.toast(result.message ?? '已是最新版本', 'success');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (status) status.textContent = `检查失败：${message}`;
        this.toast(`检查更新失败：${message}`, 'error');
      } finally {
        checkUpdateButton.disabled = false;
        checkUpdateButton.textContent = '检查更新';
      }
    });
    openUpdateButton?.addEventListener('click', () => {
      if (!this.updateUrl) return;
      window.open(this.updateUrl, '_blank');
    });
    this.element.querySelector('[data-action="licenses"]')?.addEventListener('click', () => {
      this.toast('许可清单：Electron、Three.js、Vite、TypeScript；完整清单将在发布前生成', 'info');
    });
    this.element.querySelector('[data-action="privacy"]')?.addEventListener('click', () => {
      this.toast('Texture map 默认不联网；截图与文件只保存在本机。', 'info');
    });
  }

  async open(settings: Settings, appInfo: AppInfo): Promise<void> {
    this.current = { ...settings };
    this.appInfo = appInfo;
    (this.element.querySelector('#set-theme') as HTMLSelectElement).value = settings.theme;
    (this.element.querySelector('#set-language') as HTMLSelectElement).value = settings.language;
    (this.element.querySelector('#set-export-dir') as HTMLInputElement).value = settings.exportDir;
    (this.element.querySelector('#set-screenshot-dir') as HTMLInputElement).value = settings.screenshotDir;
    (this.element.querySelector('#set-video-note-dir') as HTMLInputElement).value = settings.videoNoteDir;
    (this.element.querySelector('#set-audio-visualizer') as HTMLInputElement).checked = settings.audioVisualizer;
    this.updateAudioStatus();
    if (this.audioTimer) window.clearInterval(this.audioTimer);
    this.audioTimer = window.setInterval(() => this.updateAudioStatus(), 300);
    (this.element.querySelector('#set-hw') as HTMLInputElement).checked = settings.hardwareAcceleration;
    (this.element.querySelector('#set-ffmpeg') as HTMLInputElement).value = settings.ffmpegPath;
    (this.element.querySelector('#set-hotkey') as HTMLInputElement).value = settings.screenshotHotkey;
    (this.element.querySelector('#set-channel') as HTMLSelectElement).value = settings.updateChannel;
    (this.element.querySelector('#set-color-count') as HTMLSelectElement).value = String(settings.colorCount);
    (this.element.querySelector('#set-color-ratio') as HTMLSelectElement).value = settings.colorRatioMode;
    (this.element.querySelector('#set-color-ignore') as HTMLInputElement).checked = settings.colorIgnoreNearBW;
    (this.element.querySelector('#set-color-alpha') as HTMLInputElement).value = String(settings.colorAlphaThreshold);
    (this.element.querySelector('#set-cache-dir') as HTMLElement).textContent = settings.cacheDir;
    (this.element.querySelector('#set-version') as HTMLElement).textContent = `v${appInfo.version}`;
    (this.element.querySelector('#set-runtime') as HTMLElement).textContent = `Electron ${window.nyxel.versions.electron} · Chromium ${window.nyxel.versions.chrome} · ${appInfo.platform}/${appInfo.arch}`;
    const checkButton = this.element.querySelector('[data-action="check-update"]') as HTMLButtonElement | null;
    const channelSelect = this.element.querySelector('#set-channel') as HTMLSelectElement | null;
    const updateStatus = this.element.querySelector('#set-update-status') as HTMLElement | null;
    if (checkButton && channelSelect && updateStatus) {
      if (appInfo.windowsStore) {
        checkButton.disabled = true;
        checkButton.textContent = '商店版本自动更新';
        channelSelect.disabled = true;
        updateStatus.textContent = 'Microsoft Store 版本由商店自动更新，此构建不检查 GitHub Releases。';
      } else {
        checkButton.disabled = false;
        checkButton.textContent = '检查更新';
        channelSelect.disabled = false;
        updateStatus.textContent = '点击「检查更新」会访问 GitHub Releases；稳定频道只检查正式版，测试频道包含 Alpha / Beta。';
      }
    }
    this.element.classList.remove('hidden');
  }

  close(): void {
    this.element.classList.add('hidden');
    if (this.audioTimer) {
      window.clearInterval(this.audioTimer);
      this.audioTimer = 0;
    }
  }

  private updateAudioStatus(): void {
    if (!this.audioStatus) return;
    if (this.current && !this.current.audioVisualizer) {
      this.audioStatus.textContent = '标题栏音乐波动已关闭，不会捕获系统音频。';
      return;
    }
    const state = audioMonitor.getState();
    if (state.error) {
      this.audioStatus.textContent = `系统音频监听失败：${state.error}`;
      return;
    }
    if (state.starting) {
      this.audioStatus.textContent = '正在启动系统音频监听…';
      return;
    }
    if (!state.active) {
      this.audioStatus.textContent = '等待系统音频输出；播放声音后标题栏波动会开始跳动。';
      return;
    }
    const metrics = audioMonitor.readMetrics();
    const db = (value: number) => (value <= -99 ? '-∞' : value.toFixed(1));
    this.audioStatus.textContent =
      `${state.info?.label ?? '系统音频'} · ${state.info?.sampleRate ?? 0} Hz · ` +
      `${state.info?.channels ?? 0} ch · RMS ${db(metrics.db)} dBFS · Peak ${db(metrics.peakDb)} dBFS`;
  }

  private patch(partial: Partial<Settings>): void {
    if (!this.current) return;
    this.current = { ...this.current, ...partial };
    void this.saveHandler(this.current);
  }
}

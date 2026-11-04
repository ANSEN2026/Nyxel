import type { AppInfo, Settings, Theme, ToastApi } from '../types';

export class SettingsView {
  readonly element: HTMLElement;

  private current: Settings | null = null;
  private appInfo: AppInfo | null = null;
  private saveHandler: (settings: Settings) => Promise<void>;
  private toast: ToastApi;
  private body: HTMLElement;
  private updateUrl = '';

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
            <div class="settings-row">
              <div class="settings-label">启动时恢复上次工作区</div>
              <div class="settings-control">
                <input id="set-restore" class="toggle" type="checkbox">
              </div>
            </div>
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
              <div><strong>Texture map</strong> <span id="set-version">v0.2</span> · v0.2 Alpha</div>
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
    const restore = this.element.querySelector('#set-restore') as HTMLInputElement;
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
    restore.addEventListener('change', () => {
      this.patch({ restoreWorkspace: restore.checked });
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
    (this.element.querySelector('#set-restore') as HTMLInputElement).checked = settings.restoreWorkspace;
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
  }

  private patch(partial: Partial<Settings>): void {
    if (!this.current) return;
    this.current = { ...this.current, ...partial };
    void this.saveHandler(this.current);
  }
}

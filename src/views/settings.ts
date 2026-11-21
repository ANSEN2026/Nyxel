import { MOTION_CAPTURE_ENABLED } from '../feature-flags';
import { audioMonitor } from '../lib/audio-monitor';
import { normalizeUndoHistoryLimit } from '../lib/undo-history';
import type { AppInfo, MotionCaptureConfig, MotionCaptureRuntime, Settings, Theme, ToastApi } from '../types';

export class SettingsView {
  readonly element: HTMLElement;

  private current: Settings | null = null;
  private motionConfig: MotionCaptureConfig | null = null;
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
              <div class="settings-label">撤回记录次数</div>
              <div class="settings-control">
                <input id="set-undo-limit" type="number" min="1" max="100" step="1" value="10">
                <span class="settings-hint">默认 10 步</span>
              </div>
            </div>
            <div class="settings-hint">贴图调节、颜色、选择按钮和绘画操作支持 Ctrl+Z 撤回，Ctrl+Shift+Z / Ctrl+Y 重做；超出数量的旧记录会自动丢弃。</div>
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

          <section class="settings-section${MOTION_CAPTURE_ENABLED ? '' : ' hidden'}">
            <h3>动作捕捉</h3>
            <div class="settings-row">
              <div class="settings-label">推理后端</div>
              <div class="settings-control">
                <select id="set-mocap-provider">
                  <option value="mock">Mock 预设骨架</option>
                  <option value="sidecar">Python Sidecar</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">Python 路径</div>
              <div class="settings-control">
                <input id="set-mocap-python" type="text" spellcheck="false" placeholder="python.exe">
                <button data-action="mocap-browse-python">浏览…</button>
                <button data-action="mocap-check-runtime">检测</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">运行时</div>
              <div class="settings-control">
                <span class="value" id="set-mocap-runtime">—</span>
              </div>
            </div>
            <div class="settings-hint" id="set-mocap-runtime-hint">Sidecar 需要 Python 3.12、mediapipe==0.10.21 和 opencv；Mock 后端不需要。</div>
            <div class="settings-row">
              <div class="settings-label">模型目录</div>
              <div class="settings-control">
                <input id="set-mocap-model-dir" type="text" spellcheck="false" placeholder="当前使用 MediaPipe 内置模型">
                <button data-action="mocap-browse-model">浏览…</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">计算设备</div>
              <div class="settings-control">
                <select id="set-mocap-device">
                  <option value="cpu">CPU</option>
                  <option value="cuda">CUDA</option>
                  <option value="mps">MPS</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">默认导出格式</div>
              <div class="settings-control">
                <select id="set-mocap-format">
                  <option value="bvh">BVH</option>
                  <option value="fbx">FBX（默认 UE Z-up）</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">帧率</div>
              <div class="settings-control">
                <select id="set-mocap-fps">
                  <option value="24">24 fps</option>
                  <option value="25">25 fps</option>
                  <option value="30">30 fps</option>
                  <option value="60">60 fps</option>
                </select>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">保留 root motion</div>
              <div class="settings-control">
                <input id="set-mocap-root" class="toggle" type="checkbox">
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-label">输出目录</div>
              <div class="settings-control">
                <input id="set-mocap-output-dir" type="text" spellcheck="false">
                <button data-action="mocap-browse-output">浏览…</button>
                <button data-action="mocap-open-output">打开</button>
              </div>
            </div>
            <div class="settings-hint">配置保存在独立文件 motion-capture.json。Mock 可完整跑通；Sidecar 需要本机安装 Python 3.12 + MediaPipe。任务内部先生成 BVH 供预览；导出可选 BVH、UE5 Mannequin 兼容 FBX、UE 通用 Z-up 或通用 Y-up。</div>
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
              <div><strong>Texture map</strong> <span id="set-version">v1.0</span> · 正式版</div>
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
    const undoLimit = this.element.querySelector('#set-undo-limit') as HTMLInputElement;
    const exportDir = this.element.querySelector('#set-export-dir') as HTMLInputElement;
    const screenshotDir = this.element.querySelector('#set-screenshot-dir') as HTMLInputElement;
    const videoNoteDir = this.element.querySelector('#set-video-note-dir') as HTMLInputElement;
    const hardware = this.element.querySelector('#set-hw') as HTMLInputElement;
    const channel = this.element.querySelector('#set-channel') as HTMLSelectElement;
    const colorCount = this.element.querySelector('#set-color-count') as HTMLSelectElement;
    const colorRatio = this.element.querySelector('#set-color-ratio') as HTMLSelectElement;
    const colorIgnore = this.element.querySelector('#set-color-ignore') as HTMLInputElement;
    const colorAlpha = this.element.querySelector('#set-color-alpha') as HTMLInputElement;
    const mocapProvider = this.element.querySelector('#set-mocap-provider') as HTMLSelectElement;
    const mocapPython = this.element.querySelector('#set-mocap-python') as HTMLInputElement;
    const mocapModelDir = this.element.querySelector('#set-mocap-model-dir') as HTMLInputElement;
    const mocapDevice = this.element.querySelector('#set-mocap-device') as HTMLSelectElement;
    const mocapFormat = this.element.querySelector('#set-mocap-format') as HTMLSelectElement;
    const mocapFps = this.element.querySelector('#set-mocap-fps') as HTMLSelectElement;
    const mocapRoot = this.element.querySelector('#set-mocap-root') as HTMLInputElement;
    const mocapOutputDir = this.element.querySelector('#set-mocap-output-dir') as HTMLInputElement;

    theme.addEventListener('change', () => {
      this.patch({ theme: theme.value as Theme });
    });
    language.addEventListener('change', () => {
      this.patch({ language: language.value as Settings['language'] });
    });
    undoLimit.addEventListener('change', () => {
      const value = normalizeUndoHistoryLimit(undoLimit.value);
      undoLimit.value = String(value);
      this.patch({ undoHistoryLimit: value });
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

    mocapProvider.addEventListener('change', () => {
      this.patchMotionCapture({ provider: mocapProvider.value as MotionCaptureConfig['provider'] });
      void this.checkMotionRuntime(false);
    });
    mocapPython.addEventListener('change', () => {
      this.patchMotionCapture({ pythonPath: mocapPython.value.trim() });
      const status = this.element.querySelector('#set-mocap-runtime') as HTMLElement | null;
      if (status) status.textContent = '路径已修改，等待检测';
    });
    mocapModelDir.addEventListener('change', () => {
      this.patchMotionCapture({ modelDir: mocapModelDir.value.trim() });
    });
    mocapDevice.addEventListener('change', () => {
      this.patchMotionCapture({ device: mocapDevice.value as MotionCaptureConfig['device'] });
    });
    mocapFormat.addEventListener('change', () => {
      this.patchMotionCapture({ outputFormat: mocapFormat.value as MotionCaptureConfig['outputFormat'] });
    });
    mocapFps.addEventListener('change', () => {
      this.patchMotionCapture({ fps: Number(mocapFps.value) || 30 });
    });
    mocapRoot.addEventListener('change', () => {
      this.patchMotionCapture({ keepRootMotion: mocapRoot.checked });
    });
    mocapOutputDir.addEventListener('change', () => {
      this.patchMotionCapture({ outputDir: mocapOutputDir.value.trim() });
    });
    this.element.querySelector('[data-action="mocap-browse-python"]')?.addEventListener('click', async () => {
      const selected = await window.nyxel.dialog.openExecutable();
      if (!selected) return;
      mocapPython.value = selected;
      this.patchMotionCapture({ pythonPath: selected });
      void this.checkMotionRuntime(false);
    });
    this.element.querySelector('[data-action="mocap-check-runtime"]')?.addEventListener('click', () => {
      void this.checkMotionRuntime(true);
    });
    this.element.querySelector('[data-action="mocap-browse-model"]')?.addEventListener('click', async () => {
      const selected = await window.nyxel.dialog.openDirectory();
      if (!selected) return;
      mocapModelDir.value = selected;
      this.patchMotionCapture({ modelDir: selected });
    });
    this.element.querySelector('[data-action="mocap-browse-output"]')?.addEventListener('click', async () => {
      const selected = await window.nyxel.dialog.openDirectory();
      if (!selected) return;
      mocapOutputDir.value = selected;
      this.patchMotionCapture({ outputDir: selected });
    });
    this.element.querySelector('[data-action="mocap-open-output"]')?.addEventListener('click', async () => {
      const target = mocapOutputDir.value.trim();
      if (!target) return;
      const error = await window.nyxel.app.openPath(target);
      if (error) this.toast(`打开动作捕捉目录失败：${error}`, 'error');
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
      this.toast('许可清单：Electron、Three.js、@comfyorg/fbx-exporter-three（MIT）、Vite、TypeScript；MediaPipe 由本机 Python 运行时单独安装', 'info');
    });
    this.element.querySelector('[data-action="privacy"]')?.addEventListener('click', () => {
      this.toast('Texture map 默认不联网；截图与文件只保存在本机。', 'info');
    });
  }

  async open(settings: Settings, appInfo: AppInfo): Promise<void> {
    this.current = { ...settings };
    this.appInfo = appInfo;
    if (MOTION_CAPTURE_ENABLED) {
      try {
        this.motionConfig = await window.nyxel.motionCapture.config();
        this.fillMotionConfig();
        void this.checkMotionRuntime(false);
      } catch (error) {
        this.toast(`读取动作捕捉配置失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }
    (this.element.querySelector('#set-theme') as HTMLSelectElement).value = settings.theme;
    (this.element.querySelector('#set-language') as HTMLSelectElement).value = settings.language;
    (this.element.querySelector('#set-undo-limit') as HTMLInputElement).value = String(normalizeUndoHistoryLimit(settings.undoHistoryLimit));
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

  private fillMotionConfig(): void {
    if (!this.motionConfig) return;
    (this.element.querySelector('#set-mocap-provider') as HTMLSelectElement).value = this.motionConfig.provider;
    (this.element.querySelector('#set-mocap-python') as HTMLInputElement).value = this.motionConfig.pythonPath;
    (this.element.querySelector('#set-mocap-model-dir') as HTMLInputElement).value = this.motionConfig.modelDir;
    (this.element.querySelector('#set-mocap-device') as HTMLSelectElement).value = this.motionConfig.device;
    (this.element.querySelector('#set-mocap-format') as HTMLSelectElement).value = this.motionConfig.outputFormat;
    (this.element.querySelector('#set-mocap-fps') as HTMLSelectElement).value = String(this.motionConfig.fps);
    (this.element.querySelector('#set-mocap-root') as HTMLInputElement).checked = this.motionConfig.keepRootMotion;
    (this.element.querySelector('#set-mocap-output-dir') as HTMLInputElement).value = this.motionConfig.outputDir;
  }

  private async checkMotionRuntime(notify: boolean): Promise<void> {
    const button = this.element.querySelector('[data-action="mocap-check-runtime"]') as HTMLButtonElement | null;
    const status = this.element.querySelector('#set-mocap-runtime') as HTMLElement | null;
    const hint = this.element.querySelector('#set-mocap-runtime-hint') as HTMLElement | null;
    if (button?.disabled) return;
    if (button) {
      button.disabled = true;
      button.textContent = '检测中…';
    }
    if (status) status.textContent = '检测中…';
    try {
      const runtime = await window.nyxel.motionCapture.runtime();
      this.fillMotionRuntime(runtime);
      if (notify) {
        this.toast(runtime.ok ? '动作捕捉运行时已就绪' : `运行时未就绪：${runtime.message ?? '未知错误'}`, runtime.ok ? 'success' : 'error');
      }
    } catch (error) {
      if (status) status.textContent = '检测失败';
      if (hint) hint.textContent = error instanceof Error ? error.message : String(error);
      if (notify) this.toast('动作捕捉运行时检测失败', 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '检测';
      }
    }
  }

  private fillMotionRuntime(runtime: MotionCaptureRuntime): void {
    const status = this.element.querySelector('#set-mocap-runtime') as HTMLElement | null;
    const hint = this.element.querySelector('#set-mocap-runtime-hint') as HTMLElement | null;
    if (!status || !hint) return;
    status.classList.toggle('mocap-runtime-ok', runtime.ok);
    status.classList.toggle('mocap-runtime-error', !runtime.ok);
    if (runtime.provider === 'mock') {
      status.textContent = 'Mock 预设骨架 · 不需要 Python';
      hint.textContent = '当前使用内置 Mock 骨架，不调用 MediaPipe。切换为 Python Sidecar 后才会检测 MediaPipe。';
      return;
    }
    if (runtime.ok) {
      status.textContent = `就绪 · MediaPipe ${runtime.mediapipeVersion ?? '?'} · OpenCV ${runtime.opencvVersion ?? '?'}`;
      hint.textContent = `Python ${runtime.pythonVersion ?? '?'} · 使用 MediaPipe 内置 Pose 模型，不包含 SMPL / SMPL-X 权重。`;
    } else {
      status.textContent = `未就绪 · ${runtime.message ?? '未知错误'}`;
      hint.textContent = '需要 Python 3.12 + mediapipe==0.10.21；在 Python 路径选择 python.exe 后点「检测」。安装命令：pip install mediapipe==0.10.21';
    }
  }

  private patchMotionCapture(partial: Partial<MotionCaptureConfig>): void {
    if (!this.motionConfig) return;
    this.motionConfig = { ...this.motionConfig, ...partial };
    void window.nyxel.motionCapture.saveConfig(this.motionConfig)
      .then((config) => {
        this.motionConfig = config;
        this.fillMotionConfig();
      })
      .catch((error) => {
        this.toast(`保存动作捕捉配置失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      });
  }

  private patch(partial: Partial<Settings>): void {
    if (!this.current) return;
    this.current = { ...this.current, ...partial };
    void this.saveHandler(this.current);
  }
}

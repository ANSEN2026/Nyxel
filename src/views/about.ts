import type { AppInfo, ToastApi } from '../types';
import iconUrl from '../assets/app-icon.png';

const BILIBILI_URL = 'https://space.bilibili.com/354642845?spm_id_from=333.1007.0.0';
const AFDIAN_URL = 'https://ifdian.net/a/nyxelstudio';
const GITHUB_URL = 'https://github.com/ANSEN2026/Nyxel';
const QQ_GROUP = '757979659';

export class AboutView {
  readonly element: HTMLElement;

  private toast: ToastApi;
  private version: HTMLElement;

  constructor(toast: ToastApi) {
    this.toast = toast;
    this.element = document.createElement('div');
    this.element.className = 'settings-overlay about-overlay hidden';
    this.element.innerHTML = `
      <div class="settings-panel about-panel">
        <div class="settings-header">
          <h2>关于我们</h2>
          <button class="ghost" data-action="close" title="关闭">×</button>
        </div>
        <div class="settings-body about-body">
          <div class="about-hero">
            <img src="${iconUrl}" alt="Nyxel" draggable="false">
            <div class="about-hero-text">
              <h3>Nyxel</h3>
              <p>贴图、FBX 模型与配色分析桌面工具</p>
              <span class="about-version" id="about-version">v0.2</span>
            </div>
          </div>
          <p class="about-desc">一个面向材质与 3D 工作流的 Windows 桌面小工具，希望能帮你少开几个软件。</p>

          <div class="about-links">
            <a class="about-link" href="${BILIBILI_URL}" target="_blank" rel="noreferrer">
              <span class="about-link-icon bili">B</span>
              <span class="about-link-text"><strong>哔哩哔哩</strong><small>space.bilibili.com/354642845</small></span>
              <span class="about-link-arrow">↗</span>
            </a>
            <a class="about-link" href="${AFDIAN_URL}" target="_blank" rel="noreferrer">
              <span class="about-link-icon afdian">爱</span>
              <span class="about-link-text"><strong>赞助发电</strong><small>ifdian.net/a/nyxelstudio</small></span>
              <span class="about-link-arrow">↗</span>
            </a>
            <a class="about-link" href="${GITHUB_URL}" target="_blank" rel="noreferrer">
              <span class="about-link-icon github">GH</span>
              <span class="about-link-text"><strong>GitHub</strong><small>github.com/ANSEN2026/Nyxel</small></span>
              <span class="about-link-arrow">↗</span>
            </a>
          </div>

          <div class="about-qq">
            <div class="about-qq-text">
              <strong>QQ 群</strong>
              <span>${QQ_GROUP}</span>
            </div>
            <button type="button" data-action="copy-qq">复制群号</button>
          </div>

          <div class="about-footer">遇到问题、想提建议，或者愿意支持后续开发，都欢迎来找我。</div>
        </div>
      </div>
    `;

    this.version = this.element.querySelector('#about-version') as HTMLElement;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.element.querySelector('[data-action="close"]')?.addEventListener('click', () => this.close());
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.close();
    });
    this.element.querySelector('[data-action="copy-qq"]')?.addEventListener('click', () => void this.copyQQ());
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.element.classList.contains('hidden')) {
        event.preventDefault();
        this.close();
      }
    });
  }

  open(appInfo: AppInfo): void {
    this.version.textContent = `v${appInfo.version}`;
    this.element.classList.remove('hidden');
  }

  close(): void {
    this.element.classList.add('hidden');
  }

  private async copyQQ(): Promise<void> {
    try {
      await navigator.clipboard.writeText(QQ_GROUP);
      this.toast('QQ 群号已复制：757979659', 'success');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = QQ_GROUP;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      this.toast(ok ? 'QQ 群号已复制：757979659' : '复制失败，请手动记下群号 757979659', ok ? 'success' : 'error');
    }
  }
}

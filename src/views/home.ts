import heroUrl from '../assets/app-icon.png';
import type { RecentProject, ViewCallbacks } from '../types';
import { formatTime } from '../utils';

export class HomeView {
  readonly element: HTMLElement;
  private recentGrid: HTMLElement;
  private callbacks: ViewCallbacks;
  private getRecent: () => RecentProject[];

  constructor(callbacks: ViewCallbacks, getRecent: () => RecentProject[]) {
    this.callbacks = callbacks;
    this.getRecent = getRecent;
    this.element = document.createElement('div');
    this.element.className = 'view home';
    this.element.innerHTML = `
      <div class="home-hero">
        <img class="hero-mark" src="${heroUrl}" alt="Texture map" draggable="false" />
        <h1>Texture map</h1>
        <p>贴图 · 模型 · 视频 · 绘画 · v0.2 正式版</p>
        <div class="home-actions">
          <button class="primary" data-action="open-texture">打开贴图</button>
          <button data-action="open-model">打开模型</button>
        </div>
      </div>
      <div class="dropzone" id="home-dropzone">
        把贴图或 FBX 文件拖到这里，或使用上方按钮
      </div>
      <div class="recent">
        <h2>最近项目</h2>
        <div class="recent-grid" id="recent-grid"></div>
      </div>
    `;
    this.recentGrid = this.element.querySelector('#recent-grid') as HTMLElement;

    this.element.querySelector('[data-action="open-texture"]')?.addEventListener('click', () => {
      void this.pickTexture();
    });
    this.element.querySelector('[data-action="open-model"]')?.addEventListener('click', () => {
      void this.pickModel();
    });

    const dropzone = this.element.querySelector('#home-dropzone') as HTMLElement;
    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', () => dropzone.classList.remove('drag-over'));
  }

  private async pickTexture(): Promise<void> {
    const filePath = await window.nyxel.dialog.openImage();
    if (filePath) await this.callbacks.openTexturePath(filePath);
  }

  private async pickModel(): Promise<void> {
    const filePath = await window.nyxel.dialog.openModel();
    if (filePath) await this.callbacks.openModelPath(filePath);
  }

  renderRecent(recent: RecentProject[]): void {
    const items = recent.slice(0, 8);
    if (!items.length) {
      this.recentGrid.innerHTML = '<div class="empty-hint">还没有最近项目。打开一张贴图或一个 FBX 后会出现在这里。</div>';
      return;
    }
    this.recentGrid.innerHTML = '';
    for (const item of items) {
      const card = document.createElement('button');
      card.className = 'recent-card';
      card.type = 'button';
      const icon = document.createElement('div');
      icon.className = `recent-icon ${item.type === 'model' ? 'model' : ''}`;
      icon.textContent = item.type === 'model' ? '◈' : '▤';
      const info = document.createElement('div');
      info.className = 'recent-info';
      const name = document.createElement('div');
      name.className = 'recent-name';
      name.textContent = item.name;
      const path = document.createElement('div');
      path.className = 'recent-path';
      path.textContent = item.path;
      const time = document.createElement('div');
      time.className = 'recent-time';
      time.textContent = formatTime(item.time);
      info.append(name, path, time);
      card.append(icon, info);
      card.addEventListener('click', () => {
        if (item.type === 'model') void this.callbacks.openModelPath(item.path);
        else void this.callbacks.openTexturePath(item.path);
      });
      this.recentGrid.append(card);
    }
  }

  activate(): void {
    this.renderRecent(this.getRecent());
  }

  deactivate(): void {
    // no-op
  }
}

import type { LibraryFile, LibraryFolder, ViewCallbacks } from '../types';
import { formatBytes, formatTime } from '../utils';

type FilesMode = 'gallery' | 'textures';

const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

export class FilesView {
  readonly element: HTMLElement;

  private mode: FilesMode;
  private callbacks: ViewCallbacks;
  private active = false;
  private currentFolder = '';
  private currentFiles: LibraryFile[] = [];
  private folderCount = 0;
  private searchQuery = '';
  private layoutQueued = false;
  private info: { root: string; galleryDir: string; texturesDir: string } | null = null;
  private grid: HTMLElement;
  private empty: HTMLElement;
  private count: HTMLElement;
  private folderPath: HTMLElement;
  private folderList: HTMLElement;
  private modal: HTMLElement;
  private folderInput: HTMLInputElement;
  private modalError: HTMLElement;

  constructor(mode: FilesMode, callbacks: ViewCallbacks) {
    this.mode = mode;
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = `view files-view ${mode === 'gallery' ? 'gallery-view' : 'textures-view'}`;

    if (mode === 'gallery') {
      this.element.innerHTML = `
        <div class="view-toolbar files-toolbar">
          <div class="files-heading">
            <strong class="files-title">图库</strong>
            <span class="files-sub" id="files-count">0 张截图</span>
          </div>
          <div class="files-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            <input id="files-search" type="search" placeholder="搜索截图" spellcheck="false">
          </div>
          <span class="spacer"></span>
          <button data-action="refresh">刷新</button>
          <button data-action="open-root">打开图库文件夹</button>
        </div>
        <div class="view-body files-body">
          <div class="files-empty hidden"></div>
          <div class="asset-grid" id="files-grid"></div>
        </div>
      `;
    } else {
      this.element.innerHTML = `
        <div class="view-toolbar files-toolbar">
          <div class="files-heading">
            <strong class="files-title">贴图资源</strong>
            <span class="files-sub" id="files-count">0 张贴图</span>
          </div>
          <div class="files-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            <input id="files-search" type="search" placeholder="搜索素材" spellcheck="false">
          </div>
          <span class="spacer"></span>
          <button class="primary" data-action="import">导入贴图</button>
          <button data-action="refresh">刷新</button>
          <button data-action="open-root">打开资源库</button>
        </div>
        <div class="view-body files-body textures-body">
          <aside class="folder-pane">
            <div class="folder-pane-head">
              <span>文件夹</span>
              <button data-action="new-folder" type="button" title="新建文件夹">+</button>
            </div>
            <button class="folder-row active" data-folder="" type="button">
              <span class="folder-icon">${FOLDER_ICON}</span>
              <span class="folder-label">全部贴图</span>
              <span class="folder-count" id="all-count"></span>
            </button>
            <div id="folder-list"></div>
          </aside>
          <section class="texture-pane">
            <div class="folder-path" id="folder-path">全部贴图</div>
            <div class="texture-scroll">
              <div class="files-empty hidden"></div>
              <div class="asset-grid" id="files-grid"></div>
            </div>
          </section>
        </div>
        <div class="files-modal hidden">
          <div class="files-modal-card">
            <h3>新建文件夹</h3>
            <input id="folder-name" type="text" maxlength="64" spellcheck="false" placeholder="例如：石材、金属、角色贴图">
            <div class="files-modal-error" id="folder-error"></div>
            <div class="files-modal-actions">
              <button data-modal="cancel" type="button">取消</button>
              <button class="primary" data-modal="confirm" type="button">创建</button>
            </div>
          </div>
        </div>
      `;
    }

    this.grid = this.element.querySelector('#files-grid') as HTMLElement;
    this.empty = this.element.querySelector('.files-empty') as HTMLElement;
    this.count = this.element.querySelector('#files-count') as HTMLElement;
    this.folderPath = this.element.querySelector('#folder-path') as HTMLElement;
    this.folderList = this.element.querySelector('#folder-list') as HTMLElement;
    this.modal = this.element.querySelector('.files-modal') as HTMLElement;
    this.folderInput = this.element.querySelector('#folder-name') as HTMLInputElement;
    this.modalError = this.element.querySelector('#folder-error') as HTMLElement;

    this.bindEvents();
    window.addEventListener('resize', () => this.scheduleLayout());
    window.nyxel.library.onChanged(() => {
      if (this.active) void this.load();
    });
  }

  private bindEvents(): void {
    this.element.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const actionButton = target.closest<HTMLElement>('[data-file-action]');
      const card = target.closest<HTMLElement>('[data-file-path]');
      if (actionButton && card) {
        event.stopPropagation();
        const action = actionButton.dataset.fileAction;
        const filePath = card.dataset.filePath ?? '';
        if (action === 'open') void this.callbacks.openTexturePath(filePath);
        if (action === 'show') void window.nyxel.app.showItemInFolder(filePath);
        if (action === 'delete') void this.deleteFile(filePath);
        return;
      }
      if (card && !target.closest('button')) {
        const filePath = card.dataset.filePath ?? '';
        if (filePath) void this.callbacks.openTexturePath(filePath);
      }
    });

    const search = this.element.querySelector('#files-search') as HTMLInputElement | null;
    search?.addEventListener('input', () => {
      this.searchQuery = search.value;
      this.renderFiles(this.currentFiles);
    });
    this.element.querySelector('[data-action="refresh"]')?.addEventListener('click', () => void this.load());
    this.element.querySelector('[data-action="open-root"]')?.addEventListener('click', () => void this.openRoot());

    if (this.mode === 'textures') {
      this.element.querySelector('[data-action="import"]')?.addEventListener('click', () => void this.importTextures());
      this.element.querySelector('[data-action="new-folder"]')?.addEventListener('click', () => this.openFolderModal());
      this.folderList.addEventListener('click', (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-folder]');
        if (!row) return;
        this.currentFolder = row.dataset.folder ?? '';
        this.updateFolderActive();
        void this.load();
      });
      this.element.querySelector('[data-folder]')?.addEventListener('click', (event) => {
        const row = event.currentTarget as HTMLElement;
        this.currentFolder = row.dataset.folder ?? '';
        this.updateFolderActive();
        void this.load();
      });
      this.modal.addEventListener('click', (event) => {
        if (event.target === this.modal) this.closeFolderModal();
      });
      this.element.querySelector('[data-modal="cancel"]')?.addEventListener('click', () => this.closeFolderModal());
      this.element.querySelector('[data-modal="confirm"]')?.addEventListener('click', () => void this.createFolder());
      this.folderInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.createFolder();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.closeFolderModal();
        }
      });
    }
  }

  async activate(): Promise<void> {
    this.active = true;
    await this.load();
  }

  deactivate(): void {
    this.active = false;
  }

  private async load(): Promise<void> {
    if (this.mode === 'gallery') {
      await this.loadGallery();
    } else {
      await this.loadTextures();
    }
  }

  private async loadGallery(): Promise<void> {
    try {
      const result = await window.nyxel.library.gallery();
      this.info = {
        root: result.root,
        galleryDir: result.root,
        texturesDir: ''
      };
      this.renderFiles(result.files);
      this.callbacks.status.set('图库', `${result.files.length} 张截图`, result.root);
    } catch (error) {
      this.callbacks.toast(`读取图库失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async loadTextures(): Promise<void> {
    try {
      const result = await window.nyxel.library.textures(this.currentFolder);
      this.info = {
        root: result.root,
        galleryDir: '',
        texturesDir: result.root
      };
      this.currentFolder = result.current;
      this.folderCount = result.folders.length;
      this.renderFolders(result.folders, result.total);
      this.renderFiles(result.files);
      this.folderPath.textContent = result.current ? result.current : '全部贴图';
      this.updateFolderActive();
      this.callbacks.status.set('贴图资源', `${result.files.length} 张贴图`, result.current || '全部贴图');
    } catch (error) {
      if (this.currentFolder) {
        this.currentFolder = '';
        await this.loadTextures();
        return;
      }
      this.callbacks.toast(`读取贴图资源失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private renderFiles(files: LibraryFile[]): void {
    this.currentFiles = files;
    const query = this.searchQuery.trim().toLowerCase();
    const filtered = query
      ? files.filter((file) => file.name.toLowerCase().includes(query) || file.relative.toLowerCase().includes(query))
      : files;

    this.grid.innerHTML = '';
    this.empty.classList.toggle('hidden', filtered.length > 0);
    this.empty.textContent = query
      ? '没有匹配的素材'
      : this.mode === 'gallery'
        ? '还没有截图记录。完成一次截图后会自动出现在这里。'
        : '还没有贴图。点「导入贴图」把图片复制到资源库。';
    for (const file of filtered) {
      this.grid.append(this.createFileCard(file));
    }
    this.updateCount(filtered.length, files.length, Boolean(query));
    this.scheduleLayout();
  }

  private updateCount(filtered: number, total: number, searching: boolean): void {
    const unit = this.mode === 'gallery' ? '张截图' : '张贴图';
    if (searching) {
      this.count.textContent = `${filtered} / ${total} ${unit}`;
    } else if (this.mode === 'gallery') {
      this.count.textContent = `${total} 张截图`;
    } else {
      this.count.textContent = `${total} 张贴图 · ${this.folderCount} 个文件夹`;
    }
  }

  private createFileCard(file: LibraryFile): HTMLElement {
    const card = document.createElement('article');
    card.className = 'asset-card';
    card.dataset.filePath = file.path;
    card.dataset.aspect = '1.6';

    const thumb = document.createElement('div');
    thumb.className = 'asset-thumb';

    const ext = file.name.split('.').pop()?.toUpperCase() ?? 'IMG';
    const badge = document.createElement('span');
    badge.className = 'asset-badge';
    badge.textContent = ext;
    thumb.append(badge);

    if (file.thumbnail) {
      const image = document.createElement('img');
      image.src = file.thumbnail;
      image.alt = file.name;
      image.draggable = false;
      image.loading = 'lazy';
      image.addEventListener('load', () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          card.dataset.aspect = String(image.naturalWidth / image.naturalHeight);
          this.scheduleLayout();
        }
      });
      thumb.append(image);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'asset-placeholder';
      placeholder.textContent = ext;
      thumb.append(placeholder);
    }

    const actions = document.createElement('div');
    actions.className = 'asset-actions';
    for (const [action, label] of [['open', '打开'], ['show', '定位'], ['delete', '删除']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.fileAction = action;
      button.textContent = label;
      if (action === 'delete') button.className = 'danger';
      actions.append(button);
    }
    thumb.append(actions);

    const name = document.createElement('div');
    name.className = 'asset-name';
    name.textContent = file.name;
    name.title = `${file.relative} · ${formatTime(file.mtime)} · ${formatBytes(file.size)}`;

    card.append(thumb, name);
    return card;
  }

  private scheduleLayout(): void {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.layoutAssets();
    });
  }

  private layoutAssets(): void {
    const cards = Array.from(this.grid.querySelectorAll<HTMLElement>('.asset-card'));
    if (!cards.length) return;
    const width = this.grid.clientWidth;
    if (width < 80) return;

    const gap = 8;
    const targetHeight = 142;
    const rows: HTMLElement[][] = [];
    let row: HTMLElement[] = [];
    let ratioSum = 0;

    for (const card of cards) {
      const ratio = Math.max(0.2, Number(card.dataset.aspect) || 1.6);
      row.push(card);
      ratioSum += ratio;
      if (ratioSum * targetHeight + (row.length - 1) * gap >= width) {
        rows.push(row);
        row = [];
        ratioSum = 0;
      }
    }
    if (row.length) rows.push(row);

    this.grid.innerHTML = '';
    rows.forEach((items, rowIndex) => {
      const sum = items.reduce((total, card) => total + Math.max(0.2, Number(card.dataset.aspect) || 1.6), 0);
      const available = Math.max(40, width - (items.length - 1) * gap);
      const isLast = rowIndex === rows.length - 1;
      let height = available / Math.max(0.2, sum);
      if (isLast) height = Math.min(height, targetHeight);
      height = Math.max(62, Math.min(height, 260));

      const rowElement = document.createElement('div');
      rowElement.className = 'asset-row';
      for (const card of items) {
        const ratio = Math.max(0.2, Number(card.dataset.aspect) || 1.6);
        card.style.width = `${Math.max(42, Math.round(ratio * height))}px`;
        card.style.setProperty('--thumb-h', `${Math.round(height)}px`);
        rowElement.append(card);
      }
      this.grid.append(rowElement);
    });
  }

  private renderFolders(folders: LibraryFolder[], total: number): void {
    this.folderList.innerHTML = '';
    for (const folder of folders) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'folder-row';
      row.dataset.folder = folder.relative;
      row.style.paddingLeft = `${8 + folder.depth * 14}px`;

      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.innerHTML = FOLDER_ICON;
      const label = document.createElement('span');
      label.className = 'folder-label';
      label.textContent = folder.name;
      const count = document.createElement('span');
      count.className = 'folder-count';
      count.textContent = String(folder.count);
      row.append(icon, label, count);
      this.folderList.append(row);
    }
    const allCount = this.element.querySelector('#all-count') as HTMLElement | null;
    if (allCount) allCount.textContent = String(total);
  }

  private updateFolderActive(): void {
    this.element.querySelectorAll<HTMLElement>('[data-folder]').forEach((row) => {
      row.classList.toggle('active', (row.dataset.folder ?? '') === this.currentFolder);
    });
  }

  private async openRoot(): Promise<void> {
    try {
      const target = this.mode === 'gallery' ? this.info?.galleryDir : this.info?.texturesDir;
      if (!target) {
        this.info = await window.nyxel.library.info();
      }
      const root = this.mode === 'gallery' ? this.info?.galleryDir : this.info?.texturesDir;
      if (!root) return;
      const error = await window.nyxel.app.openPath(root);
      if (error) this.callbacks.toast(`打开文件夹失败：${error}`, 'error');
    } catch (error) {
      this.callbacks.toast(`打开文件夹失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async deleteFile(filePath: string): Promise<void> {
    const name = filePath.split(/[\\/]/).pop() ?? '这个文件';
    if (!window.confirm(`将「${name}」移到回收站？`)) return;
    try {
      const result = await window.nyxel.library.delete(filePath);
      if (result.ok) {
        this.callbacks.toast('已移到回收站', 'success');
        await this.load();
      } else {
        this.callbacks.toast(`删除失败：${result.error ?? '未知错误'}`, 'error');
      }
    } catch (error) {
      this.callbacks.toast(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private openFolderModal(): void {
    this.modalError.textContent = '';
    this.folderInput.value = '';
    this.modal.classList.remove('hidden');
    this.folderInput.focus();
  }

  private closeFolderModal(): void {
    this.modal.classList.add('hidden');
    this.modalError.textContent = '';
  }

  private async createFolder(): Promise<void> {
    const name = this.folderInput.value.trim();
    if (!name) {
      this.modalError.textContent = '请输入文件夹名称';
      return;
    }
    try {
      const result = await window.nyxel.library.createFolder(this.currentFolder, name);
      if (!result.ok) {
        this.modalError.textContent = result.error ?? '创建失败';
        return;
      }
      this.closeFolderModal();
      this.callbacks.toast(`已创建文件夹：${name}`, 'success');
      this.currentFolder = result.path ?? this.currentFolder;
      await this.load();
    } catch (error) {
      this.modalError.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private async importTextures(): Promise<void> {
    try {
      const result = await window.nyxel.library.importTextures(this.currentFolder);
      if (result.cancelled) return;
      if (!result.ok) {
        this.callbacks.toast(`导入失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      this.callbacks.toast(`已导入 ${result.imported ?? 0} 张贴图`, 'success');
      await this.load();
    } catch (error) {
      this.callbacks.toast(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

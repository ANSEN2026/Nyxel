import type { LibraryFile, LibraryFolder, ViewCallbacks } from '../types';
import { formatBytes, formatTime } from '../utils';

type FilesMode = 'gallery' | 'textures';

export class FilesView {
  readonly element: HTMLElement;

  private mode: FilesMode;
  private callbacks: ViewCallbacks;
  private active = false;
  private currentFolder = '';
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
        <div class="view-toolbar">
          <strong class="files-title">图库</strong>
          <span class="files-sub" id="files-count">0 张截图</span>
          <span class="spacer"></span>
          <button data-action="refresh">刷新</button>
          <button data-action="open-root">打开图库文件夹</button>
        </div>
        <div class="view-body files-body">
          <div class="files-empty hidden">还没有截图记录。完成一次截图后会自动出现在这里。</div>
          <div class="gallery-grid" id="files-grid"></div>
        </div>
      `;
    } else {
      this.element.innerHTML = `
        <div class="view-toolbar">
          <strong class="files-title">贴图资源</strong>
          <span class="files-sub" id="files-count">0 张贴图</span>
          <span class="spacer"></span>
          <button class="primary" data-action="import">导入贴图</button>
          <button data-action="new-folder">新建文件夹</button>
          <button data-action="refresh">刷新</button>
          <button data-action="open-root">打开资源库</button>
        </div>
        <div class="view-body files-body textures-body">
          <aside class="folder-pane">
            <button class="folder-row active" data-folder="" type="button"><span>全部贴图</span><span class="folder-count" id="all-count"></span></button>
            <div id="folder-list"></div>
          </aside>
          <section class="texture-pane">
            <div class="folder-path" id="folder-path">全部贴图</div>
            <div class="texture-scroll">
              <div class="files-empty hidden">还没有贴图。点「导入贴图」把图片复制到资源库。</div>
              <div class="gallery-grid texture-grid" id="files-grid"></div>
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
      this.count.textContent = `${result.files.length} 张截图`;
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
      this.renderFolders(result.folders, result.total);
      this.renderFiles(result.files);
      this.count.textContent = `${result.files.length} 张贴图 · ${result.folders.length} 个文件夹`;
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
    this.grid.innerHTML = '';
    this.empty.classList.toggle('hidden', files.length > 0);
    for (const file of files) {
      this.grid.append(this.createFileCard(file));
    }
  }

  private createFileCard(file: LibraryFile): HTMLElement {
    const card = document.createElement('article');
    card.className = 'file-card';
    card.dataset.filePath = file.path;

    const thumb = document.createElement('div');
    thumb.className = 'file-thumb';
    if (file.thumbnail) {
      const image = document.createElement('img');
      image.src = file.thumbnail;
      image.alt = file.name;
      image.draggable = false;
      thumb.append(image);
    } else {
      thumb.append(this.createPlaceholder(file.name));
    }

    const meta = document.createElement('div');
    meta.className = 'file-meta';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.name;

    const sub = document.createElement('div');
    sub.className = 'file-sub';
    const relativeFolder = this.mode === 'textures'
      ? file.relative.split('/').slice(0, -1).join('/')
      : '';
    sub.textContent = `${formatTime(file.mtime)} · ${formatBytes(file.size)}${relativeFolder ? ` · ${relativeFolder}` : ''}`;
    sub.title = file.relative;

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    for (const [action, label] of [['open', '打开'], ['show', '定位'], ['delete', '删除']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.fileAction = action;
      button.textContent = label;
      if (action === 'delete') button.className = 'danger';
      actions.append(button);
    }

    meta.append(name, sub, actions);
    card.append(thumb, meta);
    return card;
  }

  private createPlaceholder(fileName: string): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'file-placeholder';
    const ext = fileName.split('.').pop()?.toUpperCase() ?? 'IMG';
    placeholder.textContent = ext;
    return placeholder;
  }

  private renderFolders(folders: LibraryFolder[], total: number): void {
    this.folderList.innerHTML = '';
    for (const folder of folders) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'folder-row';
      row.dataset.folder = folder.relative;
      row.style.paddingLeft = `${10 + folder.depth * 14}px`;
      const label = document.createElement('span');
      label.textContent = folder.name;
      const count = document.createElement('span');
      count.className = 'folder-count';
      count.textContent = String(folder.count);
      row.append(label, count);
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

import type { MemoDocument, MemoMeta, ViewCallbacks } from '../types';

const LAST_NOTE_KEY = 'texturemap.memo.last';
const SAVE_DELAY = 600;

export class NotesView {
  readonly element: HTMLElement;

  private callbacks: ViewCallbacks;
  private active = false;
  private dir = '';
  private notes: MemoMeta[] = [];
  private currentPath = '';
  private currentNote: MemoDocument | null = null;
  private searchQuery = '';
  private saveTimer: number | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private loading = false;

  private countEl: HTMLElement;
  private searchInput: HTMLInputElement;
  private listEl: HTMLElement;
  private listEmpty: HTMLElement;
  private editorEmpty: HTMLElement;
  private editorPane: HTMLElement;
  private titleInput: HTMLInputElement;
  private body: HTMLElement;
  private updatedEl: HTMLElement;
  private saveStateEl: HTMLElement;
  private imageInput: HTMLInputElement;
  private savedRange: Range | null = null;

  constructor(callbacks: ViewCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'view notes-view';
    this.element.innerHTML = `
      <div class="view-toolbar notes-toolbar">
        <strong class="files-title">备忘录</strong>
        <span class="files-sub" id="memo-count">0 条</span>
        <div class="memo-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
          <input id="memo-search" type="search" placeholder="搜索备忘录" spellcheck="false">
        </div>
        <span class="spacer"></span>
        <button data-memo-action="open-dir">打开文件夹</button>
        <button data-memo-action="import">导入</button>
        <button class="primary" data-memo-action="new">新建备忘录</button>
      </div>
      <div class="view-body notes-body">
        <aside class="memo-sidebar">
          <div class="memo-sidebar-head">
            <strong>所有备忘录</strong>
            <span id="memo-sidebar-count">0</span>
          </div>
          <div class="memo-list" id="memo-list"></div>
          <div class="memo-list-empty hidden" id="memo-list-empty">没有找到备忘录</div>
        </aside>
        <section class="memo-editor">
          <div class="memo-editor-empty" id="memo-editor-empty">
            <div class="memo-empty-icon">✎</div>
            <strong>选择或新建一条备忘录</strong>
            <p>内容会自动保存在本机，也可以导出后发送到其他安装了 Texture map 的设备。</p>
          </div>
          <div class="memo-editor-pane hidden" id="memo-editor-pane">
            <header class="memo-editor-head">
              <input id="memo-title" class="memo-title-input" type="text" maxlength="200" placeholder="标题" spellcheck="false">
              <div class="memo-editor-meta">
                <span id="memo-updated"></span>
                <span id="memo-save-state">已保存</span>
              </div>
              <div class="memo-editor-actions">
                <button type="button" data-memo-action="share">导出 / 分享</button>
                <button type="button" class="danger" data-memo-action="delete">删除</button>
              </div>
            </header>
            <div class="memo-formatbar" role="toolbar" aria-label="备忘录格式">
              <button type="button" data-memo-format="bold" title="加粗 Ctrl+B"><strong>B</strong></button>
              <button type="button" data-memo-format="italic" title="斜体 Ctrl+I"><em>I</em></button>
              <button type="button" data-memo-format="underline" title="下划线 Ctrl+U"><u>U</u></button>
              <span class="memo-format-sep"></span>
              <button type="button" data-memo-block="h1" title="大标题">标题</button>
              <button type="button" data-memo-block="h2" title="小标题">小标题</button>
              <span class="memo-format-sep"></span>
              <button type="button" data-memo-format="insertUnorderedList" title="无序列表">• 列表</button>
              <button type="button" data-memo-format="insertOrderedList" title="有序列表">1. 列表</button>
              <button type="button" data-memo-action="checklist" title="待办清单">☑ 待办</button>
              <button type="button" data-memo-action="image" title="插入图片">▧ 图片</button>
              <span class="memo-format-sep"></span>
              <button type="button" data-memo-format="removeFormat" title="清除格式">清除格式</button>
            </div>
            <div class="memo-scroll">
              <div id="memo-body" class="memo-editor-body" contenteditable="true" spellcheck="false" data-placeholder="开始输入…"></div>
              <div class="memo-share-hint">可以点「图片」或直接粘贴 / 拖入图片。导出的 .tmnote 可发送到其他设备；也可以导入 iPad 备忘录导出的 PDF、文本或 HTML。</div>
            </div>
          </div>
        </section>
      </div>
      <input id="memo-image-input" type="file" accept="image/*" multiple hidden>
    `;

    this.countEl = this.query('#memo-count');
    this.searchInput = this.query('#memo-search');
    this.listEl = this.query('#memo-list');
    this.listEmpty = this.query('#memo-list-empty');
    this.editorEmpty = this.query('#memo-editor-empty');
    this.editorPane = this.query('#memo-editor-pane');
    this.titleInput = this.query('#memo-title');
    this.body = this.query('#memo-body');
    this.updatedEl = this.query('#memo-updated');
    this.saveStateEl = this.query('#memo-save-state');
    this.imageInput = this.query('#memo-image-input');

    this.bindEvents();
    document.execCommand('styleWithCSS', false, 'false');
  }

  async activate(): Promise<void> {
    this.active = true;
    await this.loadList();
    if (this.currentPath && !this.notes.some((note) => note.path === this.currentPath)) {
      this.clearEditor();
    }
    if (!this.currentPath && this.notes.length) {
      const saved = localStorage.getItem(LAST_NOTE_KEY) ?? '';
      const path = this.notes.some((note) => note.path === saved) ? saved : this.notes[0].path;
      await this.openNote(path);
    }
  }

  deactivate(): void {
    this.active = false;
    void this.flushSave();
  }

  private query<T extends Element>(selector: string): T {
    return this.element.querySelector(selector) as T;
  }

  private bindEvents(): void {
    this.element.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-memo-action]')?.dataset.memoAction;
      if (action === 'new') { void this.createNote(); return; }
      if (action === 'import') { void this.importNote(); return; }
      if (action === 'open-dir') { void this.openDir(); return; }
      if (action === 'share') { void this.shareNote(); return; }
      if (action === 'delete') { void this.deleteNote(); return; }
      if (action === 'checklist') { this.insertChecklist(); return; }
      if (action === 'image') { this.pickImage(); return; }

      const format = target.closest<HTMLElement>('[data-memo-format]')?.dataset.memoFormat;
      if (format) {
        this.applyFormat(format);
        return;
      }
      const block = target.closest<HTMLElement>('[data-memo-block]')?.dataset.memoBlock;
      if (block) {
        this.applyFormat('formatBlock', block.toUpperCase());
        return;
      }

      const item = target.closest<HTMLElement>('[data-memo-path]');
      if (item?.dataset.memoPath) void this.openNote(item.dataset.memoPath);
    });

    this.element.querySelectorAll<HTMLElement>('[data-memo-format], [data-memo-block], [data-memo-action="checklist"], [data-memo-action="image"]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
    });

    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value;
      this.renderList();
    });

    this.titleInput.addEventListener('input', () => this.scheduleSave());
    this.titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.body.focus();
      }
    });

    this.body.addEventListener('input', () => this.scheduleSave());
    this.body.addEventListener('keyup', () => this.captureSelection());
    this.body.addEventListener('mouseup', () => this.captureSelection());
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (this.body.contains(range.commonAncestorContainer)) this.savedRange = range.cloneRange();
    });
    this.body.addEventListener('paste', (event) => {
      const imageItem = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith('image/'));
      if (imageItem) {
        const imageFile = imageItem.getAsFile();
        if (imageFile) {
          event.preventDefault();
          void this.insertImageFiles([imageFile]);
          return;
        }
      }
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, text);
    });
    this.imageInput.addEventListener('change', () => {
      const files = Array.from(this.imageInput.files ?? []);
      this.imageInput.value = '';
      void this.insertImageFiles(files);
    });
    this.body.addEventListener('click', (event) => {
      const box = (event.target as HTMLElement).closest<HTMLElement>('.memo-check-box');
      if (!box) return;
      const item = box.closest<HTMLElement>('.memo-check');
      if (!item) return;
      const checked = item.dataset.checked === 'true';
      item.dataset.checked = String(!checked);
      box.textContent = checked ? '☐' : '☑';
      this.scheduleSave();
    });

    this.element.addEventListener('keydown', (event) => {
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.flushSave();
      }
    });

    this.element.addEventListener('dragover', (event) => {
      const types = event.dataTransfer?.types;
      if (!types || !Array.from(types).includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      this.element.classList.add('memo-drop-active');
    });
    this.element.addEventListener('dragleave', (event) => {
      if (!this.element.contains(event.relatedTarget as Node | null)) {
        this.element.classList.remove('memo-drop-active');
      }
    });
    this.element.addEventListener('drop', (event) => void this.onDrop(event));
  }

  private async loadList(): Promise<void> {
    try {
      const result = await window.nyxel.memo.list();
      this.dir = result.dir;
      this.notes = result.notes;
      this.countEl.textContent = `${this.notes.length} 条`;
      const sidebarCount = this.query('#memo-sidebar-count');
      sidebarCount.textContent = String(this.notes.length);
      this.renderList();
    } catch (error) {
      this.callbacks.toast(`读取备忘录失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private renderList(): void {
    const query = this.searchQuery.trim().toLowerCase();
    const filtered = query
      ? this.notes.filter((note) => `${note.title} ${note.preview}`.toLowerCase().includes(query))
      : this.notes;
    this.listEl.innerHTML = '';
    this.listEmpty.classList.toggle('hidden', filtered.length > 0);
    for (const note of filtered) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'memo-list-item';
      item.dataset.memoPath = note.path;
      item.classList.toggle('active', note.path === this.currentPath);

      const title = document.createElement('strong');
      title.textContent = note.title.trim() || '新建备忘录';
      const preview = document.createElement('span');
      preview.textContent = note.preview || '暂无内容';
      const time = document.createElement('time');
      time.textContent = formatMemoTime(note.updatedAt);
      item.append(title, preview, time);
      this.listEl.append(item);
    }
  }

  private async openNote(path: string): Promise<void> {
    if (!path || path === this.currentPath && this.currentNote) return;
    await this.flushSave();
    try {
      const result = await window.nyxel.memo.read(path);
      if (!result.ok || !result.note || !result.path) {
        this.callbacks.toast(`打开备忘录失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      this.currentPath = result.path;
      this.currentNote = result.note;
      localStorage.setItem(LAST_NOTE_KEY, result.path);
      this.loading = true;
      this.titleInput.value = result.note.title;
      this.body.innerHTML = result.note.html
        ? sanitizeMemoHtml(result.note.html)
        : plainTextToHtml(result.note.text);
      this.loading = false;
      this.dirty = false;
      this.clearSaveTimer();
      this.editorEmpty.classList.add('hidden');
      this.editorPane.classList.remove('hidden');
      this.updateMeta(result.note);
      this.setSaveState('已保存');
      this.renderList();
    } catch (error) {
      this.callbacks.toast(`打开备忘录失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async createNote(): Promise<void> {
    await this.flushSave();
    try {
      const result = await window.nyxel.memo.create();
      if (!result.ok || !result.path) {
        this.callbacks.toast(`新建备忘录失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      await this.loadList();
      this.currentPath = '';
      this.currentNote = null;
      await this.openNote(result.path);
      this.titleInput.focus();
    } catch (error) {
      this.callbacks.toast(`新建备忘录失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private clearEditor(): void {
    this.currentPath = '';
    this.currentNote = null;
    this.titleInput.value = '';
    this.body.innerHTML = '';
    this.editorPane.classList.add('hidden');
    this.editorEmpty.classList.remove('hidden');
    this.renderList();
  }

  private updateMeta(note: MemoDocument): void {
    this.updatedEl.textContent = `编辑于 ${formatMemoTime(note.updatedAt)}`;
  }

  private setSaveState(text: string): void {
    this.saveStateEl.textContent = text;
  }

  private scheduleSave(): void {
    if (this.loading || !this.currentPath) return;
    this.dirty = true;
    this.setSaveState('未保存…');
    this.clearSaveTimer();
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DELAY);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private saveNow(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      if (!this.currentPath || this.loading || !this.dirty) return;
      const path = this.currentPath;
      const title = this.titleInput.value.trim();
      const html = sanitizeMemoHtml(this.body.innerHTML);
      const text = this.body.innerText.trim();
      this.dirty = false;
      this.setSaveState('保存中…');
      try {
        const result = await window.nyxel.memo.save(path, { title, html, text });
        if (!result.ok || !result.note) {
          this.dirty = true;
          this.setSaveState('保存失败');
          this.callbacks.toast(`保存备忘录失败：${result.error ?? '未知错误'}`, 'error');
          return;
        }
        if (this.currentPath === path) {
          this.currentNote = result.note;
          this.updateMeta(result.note);
          this.setSaveState('已保存');
        }
        await this.loadList();
      } catch (error) {
        this.dirty = true;
        this.setSaveState('保存失败');
        this.callbacks.toast(`保存备忘录失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    });
    return this.saveChain;
  }

  private async flushSave(): Promise<void> {
    this.clearSaveTimer();
    if (!this.dirty && !this.currentPath) return;
    await this.saveNow();
    if (this.dirty) await this.saveNow();
  }

  private applyFormat(command: string, value?: string): void {
    this.body.focus();
    document.execCommand(command, false, value);
    this.scheduleSave();
  }

  private captureSelection(): void {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (this.body.contains(range.commonAncestorContainer)) {
      this.savedRange = range.cloneRange();
    }
  }

  private pickImage(): void {
    this.captureSelection();
    this.imageInput.value = '';
    this.imageInput.click();
  }

  private async insertImageFiles(files: File[]): Promise<void> {
    const images = files.filter(isMemoImageFile);
    if (!images.length) return;
    if (!this.currentPath) await this.createNote();
    if (!this.currentPath) return;
    this.captureSelection();
    let inserted = 0;
    for (const file of images) {
      try {
        const source = await optimizeMemoImage(file);
        this.insertHtmlAtSavedRange(`<img src="${source}" alt="">`);
        inserted += 1;
      } catch { /* skip unreadable image */ }
    }
    if (inserted) {
      this.scheduleSave();
      this.callbacks.toast(`已插入 ${inserted} 张图片`, 'success');
    }
  }

  private insertHtmlAtSavedRange(html: string): void {
    this.body.focus();
    const selection = window.getSelection();
    if (!selection) return;
    let range = this.savedRange;
    if (!range || !this.body.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(this.body);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertHTML', false, html);
    this.captureSelection();
  }

  private insertChecklist(): void {
    this.body.focus();
    const selection = window.getSelection();
    let range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !this.body.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(this.body);
      range.collapse(false);
    }

    const item = document.createElement('span');
    item.className = 'memo-check';
    item.dataset.checked = 'false';
    const box = document.createElement('span');
    box.className = 'memo-check-box';
    box.textContent = '☐';
    const text = document.createElement('span');
    text.className = 'memo-check-text';
    text.textContent = '待办事项';
    item.append(box, document.createTextNode(' '), text);

    range.deleteContents();
    range.insertNode(item);
    const after = document.createRange();
    after.setStartAfter(item);
    after.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(after);
    this.scheduleSave();
  }

  private async shareNote(): Promise<void> {
    if (!this.currentPath) return;
    await this.flushSave();
    try {
      const result = await window.nyxel.memo.exportNote(this.currentPath);
      if (result.cancelled) return;
      if (!result.ok) {
        this.callbacks.toast(`导出失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      this.callbacks.toast('已导出，可发送到其他安装 Texture map 的设备，再用「导入」打开', 'success');
    } catch (error) {
      this.callbacks.toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async importNote(): Promise<void> {
    await this.flushSave();
    try {
      const result = await window.nyxel.memo.importNote();
      if (result.cancelled) return;
      if (!result.ok) {
        this.callbacks.toast(`导入失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      await this.loadList();
      if (result.path) await this.openNote(result.path);
      this.callbacks.toast(`已导入 ${result.imported ?? 1} 条备忘录`, 'success');
    } catch (error) {
      this.callbacks.toast(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async onDrop(event: DragEvent): Promise<void> {
    this.element.classList.remove('memo-drop-active');
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    const imageFiles = files.filter(isMemoImageFile);
    if (imageFiles.length) await this.insertImageFiles(imageFiles);
    const otherFiles = files.filter((file) => !isMemoImageFile(file));
    if (!otherFiles.length) return;
    const paths = otherFiles.map((file) => {
      try { return window.nyxel.library.getPathForFile(file); } catch { return ''; }
    }).filter(Boolean);
    if (!paths.length) {
      this.callbacks.toast('无法读取拖入的文件路径', 'error');
      return;
    }
    await this.flushSave();
    try {
      const result = await window.nyxel.memo.importPaths(paths);
      if (!result.ok) {
        this.callbacks.toast(`导入失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      await this.loadList();
      if (result.path) await this.openNote(result.path);
      this.callbacks.toast(`已导入 ${result.imported ?? 1} 条备忘录`, 'success');
    } catch (error) {
      this.callbacks.toast(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async deleteNote(): Promise<void> {
    if (!this.currentPath) return;
    const title = this.titleInput.value.trim() || '这条备忘录';
    if (!window.confirm(`将「${title}」移到回收站？`)) return;
    try {
      const result = await window.nyxel.memo.delete(this.currentPath);
      if (!result.ok) {
        this.callbacks.toast(`删除失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      this.clearEditor();
      await this.loadList();
      this.callbacks.toast('备忘录已移到回收站', 'success');
    } catch (error) {
      this.callbacks.toast(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async openDir(): Promise<void> {
    try {
      const result = await window.nyxel.memo.openDir();
      if (!result.ok) this.callbacks.toast(`打开文件夹失败：${result.error ?? '未知错误'}`, 'error');
    } catch (error) {
      this.callbacks.toast(`打开文件夹失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

function isMemoImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function loadMemoImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解析图片'));
    image.src = source;
  });
}

async function optimizeMemoImage(file: File): Promise<string> {
  if (file.size > 30 * 1024 * 1024) throw new Error('图片过大');
  const original = await readFileAsDataUrl(file);
  if (!original.startsWith('data:image/')) throw new Error('不是图片文件');
  try {
    const image = await loadMemoImage(original);
    const maxSide = 1400;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建图片画布');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    let output = canvas.toDataURL('image/webp', 0.82);
    if (output.length > 2_800_000) output = canvas.toDataURL('image/webp', 0.68);
    if (output.length > 5_500_000) throw new Error('图片压缩后仍然过大');
    return output;
  } catch (error) {
    if (original.length <= 4_000_000) return original;
    throw error;
  }
}

function formatMemoTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function plainTextToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => escapeHtml(line))
    .join('<br>');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MEMO_TAGS = new Set([
  'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'a', 'img'
]);
const MEMO_CLASSES = new Set(['memo-check', 'memo-check-box', 'memo-check-text']);

function sanitizeMemoHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walk = (root: Node): void => {
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as HTMLElement;
      const tag = element.tagName.toLowerCase();
      if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'].includes(tag)) {
        element.remove();
        continue;
      }
      if (!MEMO_TAGS.has(tag)) {
        element.replaceWith(document.createTextNode(element.textContent ?? ''));
        continue;
      }
      if (tag === 'img') {
        const source = element.getAttribute('src') ?? '';
        if (!/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(source) || source.length > 6_000_000) {
          element.remove();
          continue;
        }
        for (const attribute of Array.from(element.attributes)) {
          if (attribute.name.toLowerCase() !== 'src') element.removeAttribute(attribute.name);
        }
        continue;
      }
      walk(element);
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name === 'class') {
          const classes = attribute.value.split(/\s+/).filter((item) => MEMO_CLASSES.has(item));
          if (classes.length) element.className = classes.join(' ');
          else element.removeAttribute('class');
        } else if (name === 'data-checked' && element.classList.contains('memo-check')) {
          element.dataset.checked = attribute.value === 'true' ? 'true' : 'false';
        } else {
          element.removeAttribute(attribute.name);
        }
      }
    }
  };
  walk(template.content);
  return template.innerHTML;
}

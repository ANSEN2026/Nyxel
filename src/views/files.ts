import type { LibraryFile, LibraryFolder, ViewCallbacks } from '../types';
import { formatBytes, formatTime } from '../utils';

type FilesMode = 'gallery' | 'textures' | 'videos';

const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const CALENDAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
const FOLDER_COLORS = ['#a6d0b5', '#7dd3fc', '#a78bfa', '#fbbf24', '#fb7185', '#f97316', '#5eead4', '#cbd5e1'];
const ZOOM_KEY = 'nyxel.files.thumbHeight';
const MIN_THUMB = 64;
const MAX_THUMB = 320;

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
  private thumbHeight = Number(localStorage.getItem(ZOOM_KEY)) || 142;
  private info: { root: string; galleryDir: string; texturesDir: string; videosDir?: string } | null = null;
  private grid: HTMLElement;
  private empty: HTMLElement;
  private count: HTMLElement;
  private folderPath: HTMLElement | null;
  private folderList: HTMLElement | null;
  private modal: HTMLElement | null;
  private folderInput: HTMLInputElement | null;
  private modalError: HTMLElement | null;
  private colorPop: HTMLElement | null = null;
  private colorFolder = '';
  private dragFolder = '';
  private player: HTMLElement | null = null;
  private playerVideo: HTMLVideoElement | null = null;
  private playerTitle: HTMLElement | null = null;
  private playerMeta: HTMLElement | null = null;
  private playerStage: HTMLElement | null = null;
  private playerResolution: HTMLElement | null = null;
  private playerZoomLabel: HTMLElement | null = null;
  private playerSeek: HTMLInputElement | null = null;
  private playerCurrentTime: HTMLElement | null = null;
  private playerDurationTime: HTMLElement | null = null;
  private playerPlayButton: HTMLButtonElement | null = null;
  private playerMuteButton: HTMLButtonElement | null = null;
  private playerSeeking = false;
  private playerSeekFrame = 0;
  private playerPath = '';
  private playerZoom = 1;
  private playerOffsetX = 0;
  private playerOffsetY = 0;
  private playerPanning = false;
  private playerPanStart = { x: 0, y: 0, ox: 0, oy: 0 };
  private contextMenu!: HTMLElement;
  private contextActions = new Map<string, () => void>();
  private moveModal: HTMLElement | null = null;
  private moveTarget: HTMLSelectElement | null = null;
  private moveError: HTMLElement | null = null;
  private moveSource = '';

  constructor(mode: FilesMode, callbacks: ViewCallbacks) {
    this.mode = mode;
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = `view files-view ${mode === 'gallery' ? 'gallery-view' : mode === 'textures' ? 'textures-view' : 'videos-view'}`;

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
          <span class="zoom-hint" data-zoom-hint>Ctrl + 滚轮缩放</span>
          <span class="spacer"></span>
          <button data-action="refresh">刷新</button>
          <button data-action="open-root">打开图库文件夹</button>
        </div>
        <div class="view-body files-body">
          <div class="files-empty hidden"></div>
          <div class="asset-grid" id="files-grid"></div>
        </div>
      `;
    } else if (mode === 'textures') {
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
          <span class="zoom-hint" data-zoom-hint>Ctrl + 滚轮缩放</span>
          <span class="spacer"></span>
          <button class="primary" data-action="import">导入贴图</button>
          <button data-action="refresh">刷新</button>
          <button data-action="open-root">打开资源库</button>
        </div>
        <div class="view-body files-body textures-body">
          <aside class="folder-pane">
            <div class="folder-pane-head">
              <div class="folder-pane-title">
                <button class="folder-up" data-action="up" type="button" title="上一级文件夹" disabled>▴</button>
                <span>文件夹</span>
              </div>
              <button data-action="new-folder" type="button" title="新建文件夹">+</button>
            </div>
            <div class="folder-row folder-row-root active" data-folder="" role="button" tabindex="0">
              <span class="folder-icon">${FOLDER_ICON}</span>
              <span class="folder-label">全部贴图</span>
              <span class="folder-count" id="all-count"></span>
            </div>
            <div id="folder-list" class="folder-tree"></div>
          </aside>
          <section class="texture-pane">
            <div class="folder-path" id="folder-path">
              <button class="path-up" data-action="up" type="button" title="上一级" disabled>▴</button>
              <span class="folder-path-crumbs"></span>
            </div>
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
        <div class="folder-color-pop hidden" id="folder-color-pop">
          <div class="folder-color-head">文件夹图标颜色</div>
          <div class="folder-color-grid">
            ${FOLDER_COLORS.map((color) => `<button type="button" class="folder-color-swatch" data-color="${color}" style="--swatch:${color}" title="${color}"></button>`).join('')}
          </div>
          <button type="button" class="folder-color-reset" data-color="reset">恢复默认颜色</button>
        </div>
        <div class="files-modal hidden" id="move-modal">
          <div class="files-modal-card move-modal-card">
            <h3>迁移文件夹</h3>
            <p class="move-desc" id="move-desc"></p>
            <select id="move-target"></select>
            <div class="files-modal-error" id="move-error"></div>
            <div class="files-modal-actions">
              <button data-move="cancel" type="button">取消</button>
              <button class="primary" data-move="confirm" type="button">迁移</button>
            </div>
          </div>
        </div>
      `;
    } else {
      this.element.innerHTML = `
        <div class="view-toolbar files-toolbar">
          <div class="files-heading">
            <strong class="files-title">视频作品</strong>
            <span class="files-sub" id="files-count">0 个视频</span>
          </div>
          <div class="files-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            <input id="files-search" type="search" placeholder="搜索视频作品" spellcheck="false">
          </div>
          <span class="spacer"></span>
          <button class="primary" data-action="import-video">上传视频</button>
          <button data-action="refresh">刷新</button>
          <button data-action="open-root">打开作品文件夹</button>
        </div>
        <div class="view-body files-body videos-body">
          <div class="files-empty hidden"></div>
          <div class="video-grid" id="files-grid"></div>
        </div>
        <div class="video-player hidden" id="video-player">
          <div class="video-player-card">
            <header class="video-player-head">
              <div class="video-player-title">
                <strong id="video-player-title"></strong>
                <span id="video-player-meta"></span>
              </div>
              <button type="button" data-player-close title="关闭">×</button>
            </header>
            <div class="video-player-stage" id="video-player-stage">
              <video id="video-player-el" playsinline preload="auto"></video>
              <div class="video-zoom-bar">
                <button type="button" data-video-zoom="out" title="缩小">−</button>
                <span id="video-zoom-label">适应</span>
                <button type="button" data-video-zoom="in" title="放大">＋</button>
                <button type="button" data-video-zoom="fit">适应</button>
                <button type="button" data-video-zoom="native">1:1</button>
              </div>
              <div class="video-resolution" id="video-player-resolution"></div>
            </div>
            <div class="video-player-controls">
              <button type="button" data-player-play title="播放 / 暂停">▶</button>
              <span id="video-current-time">0:00</span>
              <input id="video-seek" type="range" min="0" max="1000" step="1" value="0">
              <span id="video-duration-time">0:00</span>
              <button type="button" data-player-mute title="静音">静音</button>
              <button type="button" data-player-fullscreen title="全屏">全屏</button>
            </div>
            <footer class="video-player-foot">
              <span id="video-player-note"></span>
              <span class="video-zoom-hint">滚轮缩放 · 拖动平移 · 双击适应</span>
              <span class="spacer"></span>
              <button type="button" data-player-show>在文件夹中显示</button>
            </footer>
          </div>
        </div>
      `;
    }

    this.grid = this.element.querySelector('#files-grid') as HTMLElement;
    this.empty = this.element.querySelector('.files-empty') as HTMLElement;
    this.count = this.element.querySelector('#files-count') as HTMLElement;
    this.folderPath = this.element.querySelector('#folder-path');
    this.folderList = this.element.querySelector('#folder-list');
    this.modal = this.element.querySelector('.files-modal');
    this.folderInput = this.element.querySelector('#folder-name');
    this.modalError = this.element.querySelector('#folder-error');
    this.colorPop = this.element.querySelector('#folder-color-pop');
    this.player = this.element.querySelector('#video-player');
    this.playerVideo = this.element.querySelector('#video-player-el');
    this.playerTitle = this.element.querySelector('#video-player-title');
    this.playerMeta = this.element.querySelector('#video-player-meta');
    this.playerStage = this.element.querySelector('#video-player-stage');
    this.playerResolution = this.element.querySelector('#video-player-resolution');
    this.playerZoomLabel = this.element.querySelector('#video-zoom-label');
    this.playerSeek = this.element.querySelector('#video-seek');
    this.playerCurrentTime = this.element.querySelector('#video-current-time');
    this.playerDurationTime = this.element.querySelector('#video-duration-time');
    this.playerPlayButton = this.element.querySelector('[data-player-play]');
    this.playerMuteButton = this.element.querySelector('[data-player-mute]');
    this.moveModal = this.element.querySelector('#move-modal');
    this.moveTarget = this.element.querySelector('#move-target');
    this.moveError = this.element.querySelector('#move-error');

    this.contextMenu = document.createElement('div');
    this.contextMenu.className = 'context-menu hidden';
    document.body.append(this.contextMenu);
    this.contextMenu.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-context-action]');
      if (!button) return;
      const action = this.contextActions.get(button.dataset.contextAction ?? '');
      this.hideContextMenu();
      action?.();
    });

    this.updateZoomHint();
    this.bindEvents();
    window.addEventListener('resize', () => {
      this.scheduleLayout();
      this.hideContextMenu();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (this.player && !this.player.classList.contains('hidden')) this.closePlayer();
        this.hideColorPop();
        this.hideContextMenu();
        this.closeMoveModal();
      }
    });
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (this.colorPop && !this.colorPop.classList.contains('hidden')) {
        if (
          !this.colorPop.contains(target) &&
          !target.closest('[data-folder-color]') &&
          !target.closest('[data-context-action]')
        ) {
          this.hideColorPop();
        }
      }
      if (!this.contextMenu.contains(target)) this.hideContextMenu();
    });
    window.nyxel.library.onChanged(() => {
      if (this.active) void this.load();
    });
  }

  private bindEvents(): void {
    this.element.addEventListener('scroll', () => this.hideContextMenu(), true);
    this.element.addEventListener('contextmenu', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, select, textarea')) return;
      const folderRow = target.closest<HTMLElement>('.folder-row[data-folder]');
      const videoCard = target.closest<HTMLElement>('[data-video-path]');
      const fileCard = target.closest<HTMLElement>('[data-file-path]');
      if (!folderRow && !videoCard && !fileCard) return;
      event.preventDefault();
      event.stopPropagation();
      if (folderRow) {
        this.showFolderContext(folderRow, event.clientX, event.clientY);
      } else if (videoCard) {
        this.showVideoContext(videoCard, event.clientX, event.clientY);
      } else if (fileCard) {
        this.showFileContext(fileCard, event.clientX, event.clientY);
      }
    });

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

    this.bindZoom();

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
      this.element.querySelectorAll('[data-action="up"]').forEach((button) => {
        button.addEventListener('click', () => void this.navigateUp());
      });
      this.folderList?.addEventListener('click', (event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-folder]');
        if (!row) return;
        if ((event.target as HTMLElement).closest('[data-folder-color]')) return;
        this.currentFolder = row.dataset.folder ?? '';
        this.updateFolderActive();
        void this.load();
      });
      const rootRow = this.element.querySelector<HTMLElement>('.folder-row-root');
      rootRow?.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('[data-folder-color]')) return;
        this.currentFolder = '';
        this.updateFolderActive();
        void this.load();
      });
      rootRow?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.currentFolder = '';
          this.updateFolderActive();
          void this.load();
        }
      });
      if (rootRow) this.bindFolderDragTarget(rootRow);
      this.folderPath?.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-crumb]');
        if (!button) return;
        this.currentFolder = button.dataset.crumb ?? '';
        this.updateFolderActive();
        void this.load();
      });
      this.modal?.addEventListener('click', (event) => {
        if (event.target === this.modal) this.closeFolderModal();
      });
      this.element.querySelector('[data-modal="cancel"]')?.addEventListener('click', () => this.closeFolderModal());
      this.element.querySelector('[data-modal="confirm"]')?.addEventListener('click', () => void this.createFolder());
      this.folderInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.createFolder();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.closeFolderModal();
        }
      });
      this.colorPop?.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-color]');
        if (!button) return;
        const value = button.dataset.color === 'reset' ? null : button.dataset.color ?? null;
        void this.saveFolderColor(value);
      });
      this.moveModal?.addEventListener('click', (event) => {
        if (event.target === this.moveModal) this.closeMoveModal();
      });
      this.element.querySelector('[data-move="cancel"]')?.addEventListener('click', () => this.closeMoveModal());
      this.element.querySelector('[data-move="confirm"]')?.addEventListener('click', () => void this.confirmMoveFolder());
    }

    if (this.mode === 'videos') {
      this.element.querySelector('[data-action="import-video"]')?.addEventListener('click', () => void this.importVideos());
      this.player?.addEventListener('click', (event) => {
        if (event.target === this.player) this.closePlayer();
      });
      this.player?.querySelectorAll<HTMLElement>('[data-video-zoom]').forEach((button) => {
        button.addEventListener('click', () => {
          const action = button.dataset.videoZoom;
          if (action === 'in') this.zoomPlayer(1.25);
          else if (action === 'out') this.zoomPlayer(0.8);
          else if (action === 'native') this.zoomPlayerToNative();
          else this.resetPlayerZoom();
        });
      });
      this.playerStage?.addEventListener('wheel', (event) => {
        if (!this.player || this.player.classList.contains('hidden')) return;
        event.preventDefault();
        this.zoomPlayer(event.deltaY < 0 ? 1.18 : 1 / 1.18);
      }, { passive: false });
      this.playerVideo?.addEventListener('loadedmetadata', () => {
        if (!this.playerVideo) return;
        const width = this.playerVideo.videoWidth;
        const height = this.playerVideo.videoHeight;
        if (this.playerResolution) {
          this.playerResolution.textContent = width && height ? `原始 ${width} × ${height}` : '';
        }
        this.syncPlayerTimeline();
        this.resetPlayerZoom();
      });
      this.playerVideo?.addEventListener('dblclick', () => this.resetPlayerZoom());
      this.playerVideo?.addEventListener('pointerdown', (event) => {
        if (!this.playerVideo || this.playerZoom <= 1.01 || event.button !== 0) return;
        const rect = this.playerVideo.getBoundingClientRect();
        if (event.clientY > rect.bottom - 42) return;
        this.playerPanning = true;
        this.playerPanStart = {
          x: event.clientX,
          y: event.clientY,
          ox: this.playerOffsetX,
          oy: this.playerOffsetY
        };
        this.playerVideo.setPointerCapture(event.pointerId);
        this.applyPlayerZoom();
        event.preventDefault();
      });
      this.playerVideo?.addEventListener('pointermove', (event) => {
        if (!this.playerPanning) return;
        this.playerOffsetX = this.playerPanStart.ox + (event.clientX - this.playerPanStart.x);
        this.playerOffsetY = this.playerPanStart.oy + (event.clientY - this.playerPanStart.y);
        this.applyPlayerZoom();
      });
      const endPan = () => {
        this.playerPanning = false;
        this.applyPlayerZoom();
      };
      this.playerVideo?.addEventListener('pointerup', endPan);
      this.playerVideo?.addEventListener('pointercancel', endPan);
      this.player?.querySelector('[data-player-close]')?.addEventListener('click', () => this.closePlayer());
      this.player?.querySelector('[data-player-show]')?.addEventListener('click', () => {
        if (this.playerPath) void window.nyxel.app.showItemInFolder(this.playerPath);
      });
      this.player?.querySelector('[data-player-play]')?.addEventListener('click', () => {
        if (!this.playerVideo) return;
        if (this.playerVideo.paused) {
          if (this.playerVideo.ended) this.playerVideo.currentTime = 0;
          void this.playerVideo.play().catch(() => {});
        } else {
          this.playerVideo.pause();
        }
      });
      this.player?.querySelector('[data-player-mute]')?.addEventListener('click', () => {
        if (!this.playerVideo || !this.playerMuteButton) return;
        this.playerVideo.muted = !this.playerVideo.muted;
        this.playerMuteButton.textContent = this.playerVideo.muted ? '取消静音' : '静音';
      });
      this.player?.querySelector('[data-player-fullscreen]')?.addEventListener('click', () => {
        const card = this.player?.querySelector('.video-player-card') as HTMLElement | null;
        void card?.requestFullscreen?.().catch(() => {});
      });
      this.playerSeek?.addEventListener('input', () => {
        if (!this.playerVideo || !this.playerSeek) return;
        this.playerSeeking = true;
        const duration = this.playerVideo.duration || 0;
        const target = (Number(this.playerSeek.value) / 1000) * duration;
        if (this.playerCurrentTime) this.playerCurrentTime.textContent = this.formatMediaTime(target);
        if (this.playerSeekFrame) cancelAnimationFrame(this.playerSeekFrame);
        this.playerSeekFrame = requestAnimationFrame(() => {
          this.playerSeekFrame = 0;
          if (this.playerVideo && Number.isFinite(duration) && duration > 0) {
            this.playerVideo.currentTime = target;
          }
        });
      });
      this.playerSeek?.addEventListener('change', () => {
        if (!this.playerVideo || !this.playerSeek) return;
        const duration = this.playerVideo.duration;
        if (Number.isFinite(duration) && duration > 0) {
          this.playerVideo.currentTime = (Number(this.playerSeek.value) / 1000) * duration;
        }
        this.playerSeeking = false;
      });
      this.playerVideo?.addEventListener('timeupdate', () => this.syncPlayerTimeline());
      this.playerVideo?.addEventListener('durationchange', () => this.syncPlayerTimeline());
      this.playerVideo?.addEventListener('seeked', () => this.syncPlayerTimeline());
      this.playerVideo?.addEventListener('play', () => {
        if (this.playerPlayButton) this.playerPlayButton.textContent = '❚❚';
      });
      this.playerVideo?.addEventListener('pause', () => {
        if (this.playerPlayButton) this.playerPlayButton.textContent = '▶';
      });
      this.playerVideo?.addEventListener('ended', () => {
        if (this.playerPlayButton) this.playerPlayButton.textContent = '▶';
      });
      this.grid.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const card = target.closest<HTMLElement>('[data-video-path]');
        if (!card) return;
        const action = target.closest<HTMLElement>('[data-video-action]')?.dataset.videoAction;
        const filePath = card.dataset.videoPath ?? '';
        if (action === 'show') {
          event.stopPropagation();
          void window.nyxel.app.showItemInFolder(filePath);
          return;
        }
        if (action === 'delete') {
          event.stopPropagation();
          void this.deleteFile(filePath);
          return;
        }
        if (action === 'play' || !target.closest('button')) {
          this.openPlayer(card);
        }
      });
    }
  }

  private bindZoom(): void {
    if (this.mode === 'videos') return;
    this.element.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.22 : 1 / 1.22;
      const next = Math.round(
        Math.max(MIN_THUMB, Math.min(MAX_THUMB, this.thumbHeight * factor)) / 2
      ) * 2;
      if (next === this.thumbHeight) return;
      this.thumbHeight = next;
      localStorage.setItem(ZOOM_KEY, String(next));
      this.updateZoomHint();
      this.scheduleLayout();
    }, { passive: false });
  }

  private updateZoomHint(): void {
    this.element.querySelectorAll<HTMLElement>('[data-zoom-hint]').forEach((hint) => {
      hint.textContent = `Ctrl + 滚轮缩放 · ${Math.round(this.thumbHeight)}px`;
    });
  }

  async activate(): Promise<void> {
    this.active = true;
    await this.load();
  }

  deactivate(): void {
    this.active = false;
    this.closePlayer();
    this.hideColorPop();
    this.hideContextMenu();
    this.closeMoveModal();
  }

  private async load(): Promise<void> {
    if (this.mode === 'gallery') {
      await this.loadGallery();
    } else if (this.mode === 'textures') {
      await this.loadTextures();
    } else {
      await this.loadVideos();
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
      this.renderFolderPath();
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

  private async loadVideos(): Promise<void> {
    try {
      const result = await window.nyxel.library.videos();
      this.info = {
        root: result.root,
        galleryDir: '',
        texturesDir: '',
        videosDir: result.root
      };
      this.renderFiles(result.files);
      this.callbacks.status.set('视频作品', `${result.files.length} 个视频`, result.root);
    } catch (error) {
      this.callbacks.toast(`读取视频作品失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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
      ? '没有匹配的内容'
      : this.mode === 'gallery'
        ? '还没有截图记录。完成一次截图后会自动出现在这里。'
        : this.mode === 'textures'
          ? '还没有贴图。点「导入贴图」把图片复制到资源库。'
          : '还没有视频作品。点「上传视频」把视频放进作品区。';
    if (this.mode === 'videos') {
      for (const file of filtered) {
        this.grid.append(this.createVideoCard(file));
      }
    } else {
      for (const file of filtered) {
        this.grid.append(this.createFileCard(file));
      }
    }
    this.updateCount(filtered.length, files.length, Boolean(query));
    this.scheduleLayout();
  }

  private updateCount(filtered: number, total: number, searching: boolean): void {
    const unit = this.mode === 'gallery' ? '张截图' : this.mode === 'videos' ? '个视频' : '张贴图';
    if (searching) {
      this.count.textContent = `${filtered} / ${total} ${unit}`;
    } else if (this.mode === 'gallery' || this.mode === 'videos') {
      this.count.textContent = `${total} ${unit}`;
    } else {
      this.count.textContent = `${total} ${unit} · ${this.folderCount} 个文件夹`;
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

  private createVideoCard(file: LibraryFile): HTMLElement {
    const card = document.createElement('article');
    card.className = 'video-card';
    card.dataset.videoPath = file.path;

    const thumb = document.createElement('div');
    thumb.className = 'video-card-thumb';

    const preview = document.createElement('video');
    preview.src = `${window.nyxel.library.mediaUrl(file.path)}#t=0.5`;
    preview.preload = 'metadata';
    preview.muted = true;
    preview.playsInline = true;
    preview.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(preview.duration) && preview.duration > 0.8) {
        preview.currentTime = Math.min(0.8, preview.duration / 3);
      }
    });
    thumb.append(preview);

    const date = document.createElement('span');
    date.className = 'video-date-badge';
    const dateText = new Date(file.mtime);
    const pad = (value: number) => String(value).padStart(2, '0');
    date.innerHTML = CALENDAR_ICON;
    date.append(document.createTextNode(`${dateText.getFullYear()}-${pad(dateText.getMonth() + 1)}-${pad(dateText.getDate())}`));
    date.title = `上传于 ${formatTime(file.mtime)}`;
    thumb.append(date);

    const play = document.createElement('span');
    play.className = 'video-play-badge';
    play.innerHTML = PLAY_ICON;
    thumb.append(play);

    const actions = document.createElement('div');
    actions.className = 'asset-actions video-actions';
    for (const [action, label] of [['play', '播放'], ['show', '定位'], ['delete', '删除']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.videoAction = action;
      button.textContent = label;
      if (action === 'delete') button.className = 'danger';
      actions.append(button);
    }
    thumb.append(actions);

    const name = document.createElement('div');
    name.className = 'asset-name video-name';
    name.textContent = file.name;
    name.title = file.relative;

    const meta = document.createElement('div');
    meta.className = 'video-card-meta';
    const ext = file.name.split('.').pop()?.toUpperCase() ?? 'VIDEO';
    meta.textContent = `${ext} · ${formatBytes(file.size)} · 上传于 ${formatTime(file.mtime)}`;

    card.append(thumb, name, meta);
    return card;
  }

  private scheduleLayout(): void {
    if (this.mode === 'videos' || this.layoutQueued) return;
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
    const targetHeight = this.thumbHeight;
    const rows: HTMLElement[][] = [];
    let row: HTMLElement[] = [];
    let ratioSum = 0;

    for (const card of cards) {
      const ratio = Math.max(0.2, Number(card.dataset.aspect) || 1.6);
      if (row.length && (ratioSum + ratio) * targetHeight + row.length * gap > width) {
        rows.push(row);
        row = [];
        ratioSum = 0;
      }
      row.push(card);
      ratioSum += ratio;
    }
    if (row.length) rows.push(row);

    this.grid.innerHTML = '';
    rows.forEach((items, rowIndex) => {
      const sum = items.reduce((total, card) => total + Math.max(0.2, Number(card.dataset.aspect) || 1.6), 0);
      const available = Math.max(40, width - (items.length - 1) * gap);
      const isLast = rowIndex === rows.length - 1;
      let height = available / Math.max(0.2, sum);
      if (isLast) height = Math.min(height, targetHeight);
      const maxHeight = Math.max(180, Math.min(420, targetHeight * 2.2));
      height = Math.max(Math.min(62, targetHeight), Math.min(height, maxHeight));

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
    if (!this.folderList) return;
    this.folderList.innerHTML = '';
    for (const folder of folders) {
      const row = document.createElement('div');
      row.className = 'folder-row folder-tree-row';
      row.dataset.folder = folder.relative;
      row.dataset.depth = String(folder.depth);
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.draggable = true;

      for (let index = 0; index < folder.depth; index += 1) {
        const guide = document.createElement('span');
        guide.className = 'folder-guide';
        if (index === folder.depth - 1) guide.classList.add('elbow');
        row.append(guide);
      }

      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      if (folder.color) {
        icon.classList.add('colored');
        icon.style.color = folder.color;
      }
      icon.innerHTML = FOLDER_ICON;

      const label = document.createElement('span');
      label.className = 'folder-label';
      label.textContent = folder.name;
      label.title = folder.relative;

      const count = document.createElement('span');
      count.className = 'folder-count';
      count.textContent = String(folder.count);

      const colorButton = document.createElement('button');
      colorButton.type = 'button';
      colorButton.className = 'folder-color-button';
      colorButton.dataset.folderColor = folder.relative;
      colorButton.title = '文件夹图标颜色';
      colorButton.innerHTML = '<span></span>';

      row.append(icon, label, count, colorButton);
      this.bindFolderRow(row, folder.relative);
      this.bindFolderDragTarget(row);
      this.folderList.append(row);
    }
    const allCount = this.element.querySelector('#all-count') as HTMLElement | null;
    if (allCount) allCount.textContent = String(total);
  }

  private bindFolderRow(row: HTMLElement, relative: string): void {
    row.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-folder-color]')) return;
      this.currentFolder = relative;
      this.updateFolderActive();
      void this.load();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.currentFolder = relative;
        this.updateFolderActive();
        void this.load();
      }
    });
    row.addEventListener('dragstart', (event) => {
      this.dragFolder = relative;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', relative);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      this.dragFolder = '';
      row.classList.remove('dragging');
      this.element.querySelectorAll('.folder-drop-target').forEach((node) => node.classList.remove('folder-drop-target'));
    });
    const colorButton = row.querySelector<HTMLElement>('[data-folder-color]');
    colorButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      this.openColorPop(colorButton.dataset.folderColor ?? '', colorButton);
    });
  }

  private bindFolderDragTarget(row: HTMLElement): void {
    row.addEventListener('dragover', (event) => {
      if (!this.dragFolder) return;
      const target = row.dataset.folder ?? '';
      if (target === this.dragFolder) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      row.classList.add('folder-drop-target');
    });
    row.addEventListener('dragleave', (event) => {
      if (row.contains(event.relatedTarget as Node | null)) return;
      row.classList.remove('folder-drop-target');
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('folder-drop-target');
      const source = this.dragFolder || event.dataTransfer?.getData('text/plain') || '';
      const target = row.dataset.folder ?? '';
      if (!source || source === target) return;
      void this.moveFolder(source, target);
    });
  }

  private async moveFolder(source: string, targetParent: string): Promise<void> {
    try {
      const result = await window.nyxel.library.moveFolder(source, targetParent);
      if (!result.ok) {
        this.callbacks.toast(`移动失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      this.callbacks.toast('文件夹已移动', 'success');
      if (this.currentFolder === source) {
        this.currentFolder = result.path ?? targetParent;
      } else if (this.currentFolder.startsWith(`${source}/`)) {
        this.currentFolder = `${result.path ?? targetParent}${this.currentFolder.slice(source.length)}`;
      }
      await this.load();
    } catch (error) {
      this.callbacks.toast(`移动失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private showFolderContext(row: HTMLElement, x: number, y: number): void {
    const folder = row.dataset.folder ?? '';
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [];
    if (folder) {
      items.push(
        { label: '打开', action: () => { this.currentFolder = folder; this.updateFolderActive(); void this.load(); } },
        { label: '迁移到…', action: () => this.openMoveFolderModal(folder) },
        { label: '图标颜色', action: () => this.openColorPopAt(folder, x, y) },
        { label: '打开本地资源库', action: () => void this.openRoot() },
        { label: '在资源管理器中显示', action: () => void window.nyxel.library.showFolder(folder) },
        { label: '删除文件夹', danger: true, action: () => void this.deleteFolder(folder) }
      );
    } else {
      items.push({ label: '打开本地资源库', action: () => void this.openRoot() });
    }
    this.openContextMenu(x, y, items);
  }

  private showVideoContext(card: HTMLElement, x: number, y: number): void {
    const filePath = card.dataset.videoPath ?? '';
    if (!filePath) return;
    this.openContextMenu(x, y, [
      { label: '播放', action: () => this.openPlayer(card) },
      { label: '迁移到文件夹…', action: () => void this.migrateVideo(filePath) },
      { label: '在文件夹中显示', action: () => void window.nyxel.app.showItemInFolder(filePath) },
      { label: '打开本地资源库', action: () => void this.openRoot() },
      { label: '删除视频', danger: true, action: () => void this.deleteFile(filePath) }
    ]);
  }

  private showFileContext(card: HTMLElement, x: number, y: number): void {
    const filePath = card.dataset.filePath ?? '';
    if (!filePath) return;
    this.openContextMenu(x, y, [
      { label: '打开', action: () => void this.callbacks.openTexturePath(filePath) },
      { label: '在文件夹中显示', action: () => void window.nyxel.app.showItemInFolder(filePath) },
      { label: '打开本地资源库', action: () => void this.openRoot() },
      { label: '删除文件', danger: true, action: () => void this.deleteFile(filePath) }
    ]);
  }

  private openContextMenu(
    x: number,
    y: number,
    items: Array<{ label: string; danger?: boolean; action: () => void }>
  ): void {
    this.contextActions.clear();
    this.contextMenu.innerHTML = '';
    items.forEach((item, index) => {
      const key = String(index);
      this.contextActions.set(key, item.action);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.contextAction = key;
      button.textContent = item.label;
      if (item.danger) button.classList.add('danger');
      this.contextMenu.append(button);
    });
    this.contextMenu.classList.remove('hidden');
    const rect = this.contextMenu.getBoundingClientRect();
    this.contextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    this.contextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }

  private hideContextMenu(): void {
    this.contextMenu?.classList.add('hidden');
    this.contextActions.clear();
  }

  private openMoveFolderModal(source: string): void {
    if (!this.moveModal || !this.moveTarget) return;
    this.moveSource = source;
    const desc = this.moveModal.querySelector('#move-desc');
    if (desc) desc.textContent = `把「${source.split('/').pop() ?? source}」移动到：`;
    this.moveTarget.innerHTML = '';
    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = '全部贴图（根目录）';
    this.moveTarget.append(rootOption);
    this.element.querySelectorAll<HTMLElement>('.folder-row[data-folder]').forEach((row) => {
      const value = row.dataset.folder ?? '';
      if (!value) return;
      if (value === source || value.startsWith(`${source}/`)) return;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value.split('/').join(' / ');
      this.moveTarget?.append(option);
    });
    if (this.moveError) this.moveError.textContent = '';
    this.moveModal.classList.remove('hidden');
  }

  private closeMoveModal(): void {
    this.moveModal?.classList.add('hidden');
    if (this.moveError) this.moveError.textContent = '';
    this.moveSource = '';
  }

  private async confirmMoveFolder(): Promise<void> {
    if (!this.moveTarget || !this.moveSource) return;
    const target = this.moveTarget.value;
    const source = this.moveSource;
    this.closeMoveModal();
    await this.moveFolder(source, target);
  }

  private async deleteFolder(folder: string): Promise<void> {
    const name = folder.split('/').pop() ?? folder;
    if (!window.confirm(`将文件夹「${name}」及其中所有文件移到回收站？`)) return;
    try {
      const result = await window.nyxel.library.deleteFolder(folder);
      if (!result.ok) {
        this.callbacks.toast(`删除失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      if (this.currentFolder === folder || this.currentFolder.startsWith(`${folder}/`)) {
        this.currentFolder = '';
      }
      this.callbacks.toast('文件夹已移到回收站', 'success');
      await this.load();
    } catch (error) {
      this.callbacks.toast(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async migrateVideo(filePath: string): Promise<void> {
    const destination = await window.nyxel.dialog.openDirectory();
    if (!destination) return;
    try {
      const result = await window.nyxel.library.moveVideo(filePath, destination);
      if (!result.ok) {
        this.callbacks.toast(`迁移失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      if (this.playerPath === filePath) this.closePlayer();
      this.callbacks.toast(`视频已迁移到：${destination}`, 'success');
      await this.load();
    } catch (error) {
      this.callbacks.toast(`迁移失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private openColorPop(relative: string, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    this.openColorPopAt(relative, rect.left - 8, rect.bottom + 6);
  }

  private openColorPopAt(relative: string, x: number, y: number): void {
    if (!this.colorPop) return;
    this.colorFolder = relative;
    this.colorPop.classList.remove('hidden');
    const popRect = this.colorPop.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - popRect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - popRect.height - 8));
    this.colorPop.style.left = `${left}px`;
    this.colorPop.style.top = `${top}px`;
  }

  private hideColorPop(): void {
    this.colorPop?.classList.add('hidden');
    this.colorFolder = '';
  }

  private async saveFolderColor(color: string | null): Promise<void> {
    if (!this.colorFolder) return;
    const folder = this.colorFolder;
    this.hideColorPop();
    try {
      const result = await window.nyxel.library.setFolderColor(folder, color);
      if (!result.ok) {
        this.callbacks.toast(`改色失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      await this.load();
    } catch (error) {
      this.callbacks.toast(`改色失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private renderFolderPath(): void {
    if (!this.folderPath) return;
    const crumbs = this.folderPath.querySelector('.folder-path-crumbs');
    if (!crumbs) return;
    crumbs.innerHTML = '';
    const parts = this.currentFolder.split('/').filter(Boolean);
    const makeCrumb = (label: string, value: string, current: boolean): HTMLElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `path-crumb${current ? ' active' : ''}`;
      button.dataset.crumb = value;
      button.textContent = label;
      return button;
    };
    crumbs.append(makeCrumb('全部贴图', '', parts.length === 0));
    parts.forEach((part, index) => {
      const separator = document.createElement('span');
      separator.className = 'path-sep';
      separator.textContent = '/';
      crumbs.append(separator);
      crumbs.append(makeCrumb(part, parts.slice(0, index + 1).join('/'), index === parts.length - 1));
    });
    this.element.querySelectorAll<HTMLButtonElement>('[data-action="up"]').forEach((button) => {
      button.disabled = parts.length === 0;
    });
  }

  private updateFolderActive(): void {
    this.element.querySelectorAll<HTMLElement>('[data-folder]').forEach((row) => {
      row.classList.toggle('active', (row.dataset.folder ?? '') === this.currentFolder);
    });
  }

  private async navigateUp(): Promise<void> {
    if (!this.currentFolder) return;
    const parts = this.currentFolder.split('/').filter(Boolean);
    parts.pop();
    this.currentFolder = parts.join('/');
    this.updateFolderActive();
    await this.load();
  }

  private async openRoot(): Promise<void> {
    try {
      const target = this.mode === 'gallery'
        ? this.info?.galleryDir
        : this.mode === 'videos'
          ? this.info?.videosDir
          : this.info?.texturesDir;
      if (!target) {
        this.info = await window.nyxel.library.info();
      }
      const root = this.mode === 'gallery'
        ? this.info?.galleryDir
        : this.mode === 'videos'
          ? this.info?.videosDir
          : this.info?.texturesDir;
      if (!root) return;
      const error = await window.nyxel.app.openPath(root);
      if (error) this.callbacks.toast(`打开文件夹失败：${error}`, 'error');
    } catch (error) {
      this.callbacks.toast(`打开文件夹失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private openPlayer(card: HTMLElement): void {
    if (!this.player || !this.playerVideo) return;
    const filePath = card.dataset.videoPath ?? '';
    if (!filePath) return;
    const name = card.querySelector('.video-name')?.textContent ?? '视频作品';
    const meta = card.querySelector('.video-card-meta')?.textContent ?? '';
    this.playerPath = filePath;
    if (this.playerTitle) this.playerTitle.textContent = name;
    if (this.playerMeta) this.playerMeta.textContent = meta;
    const note = this.player.querySelector('#video-player-note');
    if (note) note.textContent = filePath;
    if (this.playerResolution) this.playerResolution.textContent = '';
    if (this.playerCurrentTime) this.playerCurrentTime.textContent = '0:00';
    if (this.playerDurationTime) this.playerDurationTime.textContent = '0:00';
    if (this.playerSeek) this.playerSeek.value = '0';
    if (this.playerPlayButton) this.playerPlayButton.textContent = '▶';
    this.playerSeeking = false;
    if (this.playerSeekFrame) {
      cancelAnimationFrame(this.playerSeekFrame);
      this.playerSeekFrame = 0;
    }
    this.resetPlayerZoom();
    this.playerVideo.src = window.nyxel.library.mediaUrl(filePath);
    this.player.classList.remove('hidden');
    void this.playerVideo.play().catch(() => {
      // Autoplay may be blocked; the native controls remain available.
    });
  }

  private closePlayer(): void {
    if (!this.player || !this.playerVideo) return;
    this.playerVideo.pause();
    this.playerVideo.removeAttribute('src');
    this.playerVideo.load();
    this.player.classList.add('hidden');
    this.playerPath = '';
    this.playerSeeking = false;
    if (this.playerSeekFrame) {
      cancelAnimationFrame(this.playerSeekFrame);
      this.playerSeekFrame = 0;
    }
    if (this.playerPlayButton) this.playerPlayButton.textContent = '▶';
    this.resetPlayerZoom();
  }

  private resetPlayerZoom(): void {
    this.playerZoom = 1;
    this.playerOffsetX = 0;
    this.playerOffsetY = 0;
    this.playerPanning = false;
    this.applyPlayerZoom();
  }

  private zoomPlayer(factor: number): void {
    this.playerZoom = Math.max(0.25, Math.min(8, this.playerZoom * factor));
    if (this.playerZoom <= 1.001) {
      this.playerOffsetX = 0;
      this.playerOffsetY = 0;
    }
    this.applyPlayerZoom();
  }

  private zoomPlayerToNative(): void {
    if (!this.playerVideo) return;
    const width = this.playerVideo.videoWidth;
    const height = this.playerVideo.videoHeight;
    const baseWidth = this.playerVideo.offsetWidth;
    const baseHeight = this.playerVideo.offsetHeight;
    if (!width || !height || !baseWidth || !baseHeight) return;
    this.playerZoom = Math.max(1, Math.min(8, Math.max(width / baseWidth, height / baseHeight)));
    this.playerOffsetX = 0;
    this.playerOffsetY = 0;
    this.applyPlayerZoom();
  }

  private formatMediaTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value: number) => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  private syncPlayerTimeline(): void {
    if (!this.playerVideo) return;
    const duration = Number.isFinite(this.playerVideo.duration) ? this.playerVideo.duration : 0;
    if (!this.playerSeeking && this.playerSeek) {
      const ratio = duration > 0 ? Math.max(0, Math.min(1, this.playerVideo.currentTime / duration)) : 0;
      this.playerSeek.value = String(Math.round(ratio * 1000));
    }
    if (this.playerCurrentTime) this.playerCurrentTime.textContent = this.formatMediaTime(this.playerVideo.currentTime);
    if (this.playerDurationTime) this.playerDurationTime.textContent = this.formatMediaTime(duration);
  }

  private applyPlayerZoom(): void {
    if (!this.playerVideo || !this.playerZoomLabel) return;
    this.playerVideo.style.transform = `translate(${this.playerOffsetX}px, ${this.playerOffsetY}px) scale(${this.playerZoom})`;
    this.playerVideo.style.cursor = this.playerZoom > 1.01
      ? (this.playerPanning ? 'grabbing' : 'grab')
      : 'default';
    this.playerZoomLabel.textContent = this.playerZoom <= 1.001
      ? '适应'
      : `${Math.round(this.playerZoom * 100)}%`;
  }

  private async deleteFile(filePath: string): Promise<void> {
    const name = filePath.split(/[\\/]/).pop() ?? '这个文件';
    if (!window.confirm(`将「${name}」移到回收站？`)) return;
    try {
      const result = await window.nyxel.library.delete(filePath);
      if (result.ok) {
        if (this.playerPath === filePath) this.closePlayer();
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
    if (!this.modal || !this.folderInput || !this.modalError) return;
    this.modalError.textContent = '';
    this.folderInput.value = '';
    this.modal.classList.remove('hidden');
    this.folderInput.focus();
  }

  private closeFolderModal(): void {
    this.modal?.classList.add('hidden');
    if (this.modalError) this.modalError.textContent = '';
  }

  private async createFolder(): Promise<void> {
    if (!this.folderInput || !this.modalError) return;
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

  private async importVideos(): Promise<void> {
    try {
      const result = await window.nyxel.library.importVideos();
      if (result.cancelled) return;
      if (!result.ok) {
        this.callbacks.toast(`上传失败：${result.error ?? '未知错误'}`, 'error');
        return;
      }
      this.callbacks.toast(`已上传 ${result.imported ?? 0} 个视频作品`, 'success');
      await this.load();
    } catch (error) {
      this.callbacks.toast(`上传失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

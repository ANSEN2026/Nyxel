import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nyxel', {
  platform: process.platform,
  test: {
    noRestoreWorkspace: process.env.NYXEL_TEST_NO_RESTORE === '1'
  },
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    close: () => ipcRenderer.invoke('window:close')
  },
  dialog: {
    openImage: () => ipcRenderer.invoke('dialog:openImage'),
    openModel: () => ipcRenderer.invoke('dialog:openModel'),
    openVideo: () => ipcRenderer.invoke('dialog:openVideo'),
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory')
  },
  file: {
    read: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
    savePng: (data: Uint8Array, suggestedName: string) => ipcRenderer.invoke('file:savePng', data, suggestedName)
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings: unknown) => ipcRenderer.invoke('settings:save', settings)
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openPath: (target: string) => ipcRenderer.invoke('app:openPath', target),
    showItemInFolder: (target: string) => ipcRenderer.invoke('app:showItemInFolder', target),
    clearCache: () => ipcRenderer.invoke('app:clearCache')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check')
  },
  video: {
    status: () => ipcRenderer.invoke('video:status'),
    download: () => ipcRenderer.invoke('video:download'),
    probe: (filePath: string) => ipcRenderer.invoke('video:probe', filePath),
    compress: (options: unknown) => ipcRenderer.invoke('video:compress', options),
    cancel: () => ipcRenderer.invoke('video:cancel'),
    onProgress: (callback: (progress: unknown) => void) => {
      const listener = (_event: unknown, progress: unknown) => callback(progress);
      ipcRenderer.on('video:progress', listener);
      return () => ipcRenderer.removeListener('video:progress', listener);
    }
  },
  screenshot: {
    capture: () => ipcRenderer.invoke('screenshot:capture'),
    setHotkey: (accelerator: string) => ipcRenderer.invoke('screenshot:setHotkey', accelerator),
    onDone: (callback: (data: { ok: boolean; path?: string; copied?: boolean; error?: string; cancelled?: boolean }) => void) => {
      const listener = (_event: unknown, data: { ok: boolean; path?: string; copied?: boolean; error?: string; cancelled?: boolean }) => callback(data);
      ipcRenderer.on('screenshot:done', listener);
      return () => ipcRenderer.removeListener('screenshot:done', listener);
    }
  },
  ai: {
    status: (engine: string, model?: string) => ipcRenderer.invoke('ai:status', engine, model),
    download: (engine: string, model?: string) => ipcRenderer.invoke('ai:download', engine, model),
    upscale: (data: Uint8Array, scale: number, engine: string, model?: string) =>
      ipcRenderer.invoke('ai:upscale', data, scale, engine, model),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    onProgress: (callback: (progress: unknown) => void) => {
      const listener = (_event: unknown, progress: unknown) => callback(progress);
      ipcRenderer.on('ai:progress', listener);
      return () => ipcRenderer.removeListener('ai:progress', listener);
    }
  },
  library: {
    info: () => ipcRenderer.invoke('library:info'),
    gallery: () => ipcRenderer.invoke('library:gallery'),
    textures: (folder: string) => ipcRenderer.invoke('library:textures', folder),
    createFolder: (parent: string, name: string) => ipcRenderer.invoke('library:createFolder', parent, name),
    importTextures: (folder: string) => ipcRenderer.invoke('library:importTextures', folder),
    videos: () => ipcRenderer.invoke('library:videos'),
    importVideos: () => ipcRenderer.invoke('library:importVideos'),
    moveFolder: (source: string, targetParent: string) => ipcRenderer.invoke('library:moveFolder', source, targetParent),
    setFolderColor: (folder: string, color: string | null) => ipcRenderer.invoke('library:setFolderColor', folder, color),
    deleteFolder: (folder: string) => ipcRenderer.invoke('library:deleteFolder', folder),
    openFolder: (folder: string) => ipcRenderer.invoke('library:openFolder', folder),
    showFolder: (folder: string) => ipcRenderer.invoke('library:showFolder', folder),
    moveVideo: (filePath: string, destinationDir: string) => ipcRenderer.invoke('library:moveVideo', filePath, destinationDir),
    mediaUrl: (filePath: string) => `nyxel-media://local/?path=${encodeURIComponent(filePath)}`,
    delete: (target: string) => ipcRenderer.invoke('library:delete', target),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('library:changed', listener);
      return () => ipcRenderer.removeListener('library:changed', listener);
    }
  }
});

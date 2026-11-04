import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nyxel', {
  platform: process.platform,
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
    delete: (target: string) => ipcRenderer.invoke('library:delete', target),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('library:changed', listener);
      return () => ipcRenderer.removeListener('library:changed', listener);
    }
  }
});

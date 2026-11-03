import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('editor', {
  onImage: (callback: (payload: { dataUrl: string; width: number; height: number }) => void) => {
    const listener = (_event: unknown, payload: { dataUrl: string; width: number; height: number }) => callback(payload);
    ipcRenderer.on('editor:image', listener);
    return () => ipcRenderer.removeListener('editor:image', listener);
  },
  save: (dataUrl: string) => ipcRenderer.invoke('editor:save', dataUrl),
  copy: (dataUrl: string) => ipcRenderer.invoke('editor:copy', dataUrl),
  cancel: () => ipcRenderer.send('editor:cancel'),
  minimize: () => ipcRenderer.send('editor:minimize')
});

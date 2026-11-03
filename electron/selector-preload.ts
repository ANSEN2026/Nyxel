import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('selector', {
  onImage: (callback: (dataUrl: string) => void) => {
    const listener = (_event: unknown, dataUrl: string) => callback(dataUrl);
    ipcRenderer.on('selector:image', listener);
    return () => ipcRenderer.removeListener('selector:image', listener);
  },
  confirm: (rect: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('selector:confirm', rect);
  },
  cancel: () => {
    ipcRenderer.send('selector:cancel');
  }
});

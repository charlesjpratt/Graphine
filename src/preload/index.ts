import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  saveRecording: (json: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save', json, defaultName),

  openRecording: (): Promise<{ content: string; filePath: string } | null> =>
    ipcRenderer.invoke('dialog:open'),

  writeToPath: (filePath: string, json: string): Promise<void> =>
    ipcRenderer.invoke('file:write', filePath, json),

  exportPdf: (html: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:export-pdf', html, defaultName),

  onMenuAction: (callback: (action: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on('menu:action', handler)
    return () => ipcRenderer.removeListener('menu:action', handler)
  },

  onFullscreenChange: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, isFullscreen: boolean) => callback(isFullscreen)
    ipcRenderer.on('window:fullscreen', handler)
    return () => ipcRenderer.removeListener('window:fullscreen', handler)
  },
})

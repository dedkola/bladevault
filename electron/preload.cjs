const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bladevaultDesktop', {
  selectDirectory: () => ipcRenderer.invoke('bladevault:select-directory'),
  saveBackupFile: (defaultName) =>
    ipcRenderer.invoke('bladevault:save-backup-file', defaultName),
  getUpdateStatus: () => ipcRenderer.invoke('bladevault:get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('bladevault:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('bladevault:download-update'),
  installUpdate: () => ipcRenderer.invoke('bladevault:install-update'),
  errorReporting: {
    get: () => ipcRenderer.invoke('bladevault:get-error-reporting'),
    set: (enabled, usageMetrics) =>
      ipcRenderer.invoke(
        'bladevault:set-error-reporting',
        enabled === true,
        usageMetrics !== false,
      ),
    restart: () => ipcRenderer.invoke('bladevault:restart-app'),
  },
  scrapeBrowser: {
    open: (url) => ipcRenderer.invoke('bladevault:scrape-browser-open', url),
    capture: () => ipcRenderer.invoke('bladevault:scrape-browser-capture'),
    cancel: () => ipcRenderer.invoke('bladevault:scrape-browser-cancel'),
    fetchImages: (urls) =>
      ipcRenderer.invoke('bladevault:scrape-browser-fetch-images', urls),
  },
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('bladevault:update-status', listener)
    return () =>
      ipcRenderer.removeListener('bladevault:update-status', listener)
  },
})

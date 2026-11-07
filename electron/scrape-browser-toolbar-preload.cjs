const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('scrapeBrowserToolbar', {
  action: (name) => ipcRenderer.send('bladevault:scrape-browser-action', name),
  onState: (callback) => {
    ipcRenderer.on('bladevault:scrape-browser-state', (_event, state) =>
      callback(state),
    )
  },
})

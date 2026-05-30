const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Scraper controls
  startScrape: (url, outputDir, options) => ipcRenderer.send('scraper:start', url, outputDir, options),
  pauseScrape: () => ipcRenderer.send('scraper:pause'),
  resumeScrape: () => ipcRenderer.send('scraper:resume'),
  cancelScrape: () => ipcRenderer.send('scraper:cancel'),
  
  // Scraper events
  onScraperLog: (callback) => ipcRenderer.on('scraper:log', (event, data) => callback(data)),
  onScraperProgress: (callback) => ipcRenderer.on('scraper:progress', (event, data) => callback(data)),
  onScraperFinished: (callback) => ipcRenderer.on('scraper:finished', (event, data) => callback(data)),
  
  // File operations
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  openDirectory: (dirPath) => ipcRenderer.send('shell:openDirectory', dirPath),
  getScrapeHistory: () => ipcRenderer.invoke('history:get'),
  zipDirectory: (dirPath) => ipcRenderer.invoke('export:zip', dirPath),
  
  // Built-in preview server
  startPreviewServer: (dirPath) => ipcRenderer.invoke('server:start', dirPath),
  stopPreviewServer: () => ipcRenderer.invoke('server:stop'),
  onServerStatus: (callback) => ipcRenderer.on('server:status', (event, data) => callback(data))
});

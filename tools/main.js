const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const http = require('http');
const archiver = require('archiver');
const ScraperEngine = require('./scraperEngine');

let mainWindow = null;
let activeScraper = null;
let previewServer = null;
let previewPort = null;

const historyFilePath = path.join(app.getPath('userData'), 'scraper_history.json');

// --- Helper: Read/Write History ---
async function readHistory() {
  try {
    if (!fs.existsSync(historyFilePath)) {
      return [];
    }
    const data = await fsPromises.readFile(historyFilePath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Failed to read history:', e);
    return [];
  }
}

async function writeHistory(history) {
  try {
    await fsPromises.writeFile(historyFilePath, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write history:', e);
  }
}

async function getFolderSize(dir) {
  let totalSize = 0;
  try {
    const files = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        totalSize += await getFolderSize(filePath);
      } else if (file.isFile()) {
        const stats = await fsPromises.stat(filePath);
        totalSize += stats.size;
      }
    }
  } catch (e) {
    console.error(`Error sizing directory ${dir}:`, e);
  }
  return totalSize;
}

// --- Native Static HTTP Server for Previewing ---
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf'
};

function startStaticServer(rootDirectory) {
  return new Promise((resolve, reject) => {
    if (previewServer) {
      previewServer.close();
    }
    
    previewServer = http.createServer(async (req, res) => {
      // Decode and sanitize URL request path
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') {
        reqPath = '/index.html';
      }
      
      let filePath = path.join(rootDirectory, reqPath);
      
      // Directory protection check
      if (!filePath.startsWith(rootDirectory)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Access Denied');
        return;
      }
      
      try {
        const stats = await fsPromises.stat(filePath);
        if (stats.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
        }
        
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        
        const stream = fs.createReadStream(filePath);
        stream.on('error', (err) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`Internal Server Error: ${err.message}`);
        });
        stream.pipe(res);
      } catch (err) {
        // Fallback search: if file.html exists
        if (err.code === 'ENOENT') {
          try {
            const htmlFilePath = filePath + '.html';
            await fsPromises.access(htmlFilePath);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            fs.createReadStream(htmlFilePath).pipe(res);
            return;
          } catch (_) {}
          
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`File Not Found: ${reqPath}`);
        } else {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`Internal Server Error: ${err.message}`);
        }
      }
    });
    
    // Bind to arbitrary open port
    previewServer.listen(0, '127.0.0.1', () => {
      previewPort = previewServer.address().port;
      console.log(`Preview server running at http://127.0.0.1:${previewPort}`);
      resolve(`http://127.0.0.1:${previewPort}`);
    });
    
    previewServer.on('error', (e) => {
      reject(e);
    });
  });
}

function stopStaticServer() {
  if (previewServer) {
    previewServer.close();
    previewServer = null;
    previewPort = null;
    console.log('Preview server stopped.');
  }
}

// --- Window Creation ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 1000,
    minHeight: 700,
    title: 'Web Scraper Desktop',
    backgroundColor: '#0c0f17',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'), // will create placeholder/icon later
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // Allow previewing in webview
    }
  });

  // Load index.html
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  
  // Set menu null to give custom design feel
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopStaticServer();
  });
}

// --- IPC Communication setup ---
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 1. Directory Dialog Selection
ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

// 2. Open directory in explorer
ipcMain.on('shell:openDirectory', (event, dirPath) => {
  if (fs.existsSync(dirPath)) {
    shell.openPath(dirPath);
  }
});

// 3. Start static preview server
ipcMain.handle('server:start', async (event, dirPath) => {
  try {
    const url = await startStaticServer(dirPath);
    mainWindow.webContents.send('server:status', { running: true, url });
    return url;
  } catch (e) {
    console.error('Server start error:', e);
    return null;
  }
});

// 4. Stop static preview server
ipcMain.handle('server:stop', async () => {
  stopStaticServer();
  mainWindow.webContents.send('server:status', { running: false, url: null });
  return true;
});

// 5. Scraper operations
ipcMain.on('scraper:start', async (event, startUrl, outputDir, options) => {
  if (activeScraper) {
    activeScraper.cancel();
  }
  
  try {
    activeScraper = new ScraperEngine(startUrl, outputDir, options);
    
    // Relay logs
    activeScraper.on('log', (logData) => {
      if (mainWindow) {
        mainWindow.webContents.send('scraper:log', logData);
      }
    });
    
    // Relay progress updates
    activeScraper.on('progress', (progressData) => {
      if (mainWindow) {
        mainWindow.webContents.send('scraper:progress', progressData);
      }
    });
    
    // Handle finished state
    activeScraper.on('finished', async (result) => {
      activeScraper = null;
      
      // Save item to history if not cancelled
      if (!result.cancelled && result.stats.pagesScraped > 0) {
        const history = await readHistory();
        const size = await getFolderSize(result.outputDir);
        
        // Add new record
        history.unshift({
          id: crypto.randomBytes(8).toString('hex'),
          url: startUrl,
          outputDir: result.outputDir,
          date: new Date().toLocaleString(),
          pagesScraped: result.stats.pagesScraped,
          assetsDownloaded: result.stats.assetsDownloaded,
          sizeBytes: size
        });
        
        // Cap history at 50 entries
        if (history.length > 50) {
          history.pop();
        }
        
        await writeHistory(history);
      }
      
      if (mainWindow) {
        mainWindow.webContents.send('scraper:finished', result);
      }
    });
    
    activeScraper.run();
  } catch (err) {
    mainWindow.webContents.send('scraper:log', {
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      level: 'error',
      message: `Failed to initialize scraper: ${err.message}`
    });
    mainWindow.webContents.send('scraper:finished', { cancelled: false, error: err.message });
  }
});

ipcMain.on('scraper:pause', () => {
  if (activeScraper) {
    activeScraper.pause();
  }
});

ipcMain.on('scraper:resume', () => {
  if (activeScraper) {
    activeScraper.resume();
  }
});

ipcMain.on('scraper:cancel', () => {
  if (activeScraper) {
    activeScraper.cancel();
  }
});

// 6. History fetch
ipcMain.handle('history:get', async () => {
  return await readHistory();
});

// 7. Zip Export folder
ipcMain.handle('export:zip', async (event, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory does not exist: ${dirPath}`);
    }
    
    const parentDir = path.dirname(dirPath);
    const folderName = path.basename(dirPath);
    const zipPath = path.join(parentDir, `${folderName}.zip`);
    
    // Check if zip already exists and delete it
    if (fs.existsSync(zipPath)) {
      await fsPromises.unlink(zipPath);
    }
    
    const outputStream = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    return new Promise((resolve, reject) => {
      outputStream.on('close', () => {
        resolve(zipPath);
      });
      
      archive.on('error', (err) => {
        reject(err);
      });
      
      archive.pipe(outputStream);
      archive.directory(dirPath, false); // false maps folder contents to zip root
      archive.finalize();
    });
  } catch (e) {
    console.error('Error zipping folder:', e);
    return null;
  }
});

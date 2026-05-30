// DOM Selectors
const navItems = document.querySelectorAll('.nav-item');
const panels = document.querySelectorAll('.panel');
const tabTitle = document.getElementById('tab-title');
const globalRunningIndicator = document.getElementById('global-running-indicator');

// Scraper Inputs & Controls
const inputUrl = document.getElementById('input-url');
const inputOutputDir = document.getElementById('input-output-dir');
const btnSelectDir = document.getElementById('btn-select-dir');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnResume = document.getElementById('btn-resume');
const btnStop = document.getElementById('btn-stop');

// Stats Displays
const statPagesScraped = document.getElementById('stat-pages-scraped');
const statAssetsDownloaded = document.getElementById('stat-assets-downloaded');
const statQueueSize = document.getElementById('stat-queue-size');
const statFailedDownloads = document.getElementById('stat-failed-downloads');

// Progress Indicator
const progressWrapper = document.getElementById('progress-wrapper');
const progressStatusText = document.getElementById('progress-status-text');
const progressPercentage = document.getElementById('progress-percentage');
const progressBarFill = document.getElementById('progress-bar-fill');

// Console Terminal Logs
const logTerminal = document.getElementById('log-terminal');
const logFilter = document.getElementById('log-filter');
const btnClearLogs = document.getElementById('btn-clear-logs');
const terminalPulse = document.getElementById('terminal-pulse');

// Settings Inputs
const setMaxDepth = document.getElementById('set-max-depth');
const setWorkers = document.getElementById('set-workers');
const setTimeoutVal = document.getElementById('set-timeout');
const setDelay = document.getElementById('set-delay');
const setCss = document.getElementById('set-css');
const setJs = document.getElementById('set-js');
const setImages = document.getElementById('set-images');
const setMedia = document.getElementById('set-media');
const setUaPreset = document.getElementById('set-ua-preset');
const uaCustomGroup = document.getElementById('ua-custom-group');
const setUaCustom = document.getElementById('set-ua-custom');
const setCookies = document.getElementById('set-cookies');
const setHeaders = document.getElementById('set-headers');

// History Displays
const historyList = document.getElementById('history-list');
const btnRefreshHistory = document.getElementById('btn-refresh-history');

// Previewer Elements
const previewStatusPill = document.getElementById('preview-status-pill');
const previewStatusLabel = document.getElementById('preview-status-label');
const previewUrlDisplay = document.getElementById('preview-url-display');
const btnPreviewRefresh = document.getElementById('btn-preview-refresh');
const btnPreviewExternal = document.getElementById('btn-preview-external');
const btnStopPreview = document.getElementById('btn-stop-preview');
const previewPlaceholder = document.getElementById('preview-placeholder');
const previewWebview = document.getElementById('preview-webview');

// --- Tab Navigation Management ---
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const tabName = item.getAttribute('data-tab');
    
    // Update active nav item
    navItems.forEach(nav => nav.classList.remove('active'));
    item.classList.add('active');
    
    // Update active panel
    panels.forEach(panel => panel.classList.remove('active'));
    document.getElementById(`tab-content-${tabName}`).classList.add('active');
    
    // Update page title
    switch (tabName) {
      case 'scraper':
        tabTitle.textContent = 'Web Scraper Dashboard';
        break;
      case 'settings':
        tabTitle.textContent = 'Scraper Configuration';
        break;
      case 'history':
        tabTitle.textContent = 'History & Archive';
        loadHistory();
        break;
      case 'preview':
        tabTitle.textContent = 'Live Site Previewer';
        break;
    }
  });
});

// --- Settings Page Event Logic ---
setUaPreset.addEventListener('change', () => {
  if (setUaPreset.value === 'custom') {
    uaCustomGroup.classList.remove('hidden');
  } else {
    uaCustomGroup.classList.add('hidden');
  }
});

function getSelectedUserAgent() {
  const preset = setUaPreset.value;
  switch (preset) {
    case 'chrome':
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    case 'firefox':
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0';
    case 'safari':
      return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    case 'mobile':
      return 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1';
    case 'custom':
      return setUaCustom.value;
    default:
      return '';
  }
}

// --- Terminal Log Management ---
function appendLog(message, level = 'info') {
  const line = document.createElement('div');
  line.classList.add('log-line', `${level}-line`);
  
  const timeSpan = document.createElement('span');
  timeSpan.classList.add('time');
  const now = new Date();
  timeSpan.textContent = `[${now.toTimeString().split(' ')[0]}]`;
  
  const contentSpan = document.createElement('span');
  contentSpan.textContent = message;
  
  line.appendChild(timeSpan);
  line.appendChild(contentSpan);
  
  // Tag line text for searching
  line.dataset.text = message.toLowerCase();
  
  logTerminal.appendChild(line);
  
  // Auto scroll
  logTerminal.scrollTop = logTerminal.scrollHeight;
}

btnClearLogs.addEventListener('click', () => {
  logTerminal.innerHTML = '<div class="log-line system-line">[SYSTEM] Console logs cleared.</div>';
});

logFilter.addEventListener('input', () => {
  const query = logFilter.value.toLowerCase().trim();
  const lines = logTerminal.querySelectorAll('.log-line');
  
  lines.forEach(line => {
    if (!query || (line.dataset.text && line.dataset.text.includes(query))) {
      line.style.display = 'block';
    } else {
      line.style.display = 'none';
    }
  });
});

// --- Folder Dialog Picker Trigger ---
btnSelectDir.addEventListener('click', async () => {
  const selectedPath = await window.electronAPI.selectDirectory();
  if (selectedPath) {
    inputOutputDir.value = selectedPath;
  }
});

// --- Scraper Control Buttons Logic ---
btnStart.addEventListener('click', () => {
  const url = inputUrl.value.trim();
  const outputDir = inputOutputDir.value.trim();
  
  if (!url) {
    appendLog('Error: Target website URL cannot be empty!', 'error');
    alert('Please enter a target URL.');
    return;
  }
  
  if (!outputDir) {
    appendLog('Error: Destination directory must be specified!', 'error');
    alert('Please select a destination folder.');
    return;
  }
  
  // Parse Headers
  let customHeaders = {};
  if (setHeaders.value.trim()) {
    try {
      customHeaders = JSON.parse(setHeaders.value.trim());
    } catch (e) {
      appendLog(`Error: Custom JSON headers are invalid: ${e.message}`, 'error');
      alert('Invalid JSON structure in Custom Headers!');
      return;
    }
  }
  
  const options = {
    maxDepth: setMaxDepth.value,
    numWorkers: setWorkers.value,
    timeout: setTimeoutVal.value,
    delay: setDelay.value,
    downloadCss: setCss.checked,
    downloadJs: setJs.checked,
    downloadImages: setImages.checked,
    downloadMedia: setMedia.checked,
    userAgent: getSelectedUserAgent(),
    cookies: setCookies.value.trim(),
    customHeaders
  };
  
  // Reset Stats & Logs
  statPagesScraped.textContent = '0';
  statAssetsDownloaded.textContent = '0';
  statQueueSize.textContent = '0';
  statFailedDownloads.textContent = '0';
  
  progressWrapper.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressPercentage.textContent = '0%';
  progressStatusText.textContent = 'Initializing Crawler Engine...';
  
  appendLog(`Starting Scrape Engine process for: ${url}`, 'system');
  
  // Disable fields during scrape
  inputUrl.disabled = true;
  btnSelectDir.disabled = true;
  
  // Trigger Scrape Start
  window.electronAPI.startScrape(url, outputDir, options);
  
  // Toggle UI buttons
  btnStart.classList.add('hidden');
  btnPause.classList.remove('hidden');
  btnStop.classList.remove('hidden');
  
  terminalPulse.classList.add('active');
  globalRunningIndicator.classList.remove('hidden');
});

btnPause.addEventListener('click', () => {
  window.electronAPI.pauseScrape();
  btnPause.classList.add('hidden');
  btnResume.classList.remove('hidden');
});

btnResume.addEventListener('click', () => {
  window.electronAPI.resumeScrape();
  btnResume.classList.add('hidden');
  btnPause.classList.remove('hidden');
});

btnStop.addEventListener('click', () => {
  if (confirm('Are you sure you want to stop the scraping process? Collected files will be saved.')) {
    window.electronAPI.cancelScrape();
    btnStop.disabled = true;
    appendLog('Stopping crawl... saving current progress...', 'system');
  }
});

// --- Scraper IPC Update Receivers ---
window.electronAPI.onScraperLog((data) => {
  appendLog(data.message, data.level);
});

window.electronAPI.onScraperProgress((data) => {
  // Update numbers
  statPagesScraped.textContent = data.pagesScraped;
  statAssetsDownloaded.textContent = data.assetsDownloaded;
  statQueueSize.textContent = data.queueSize;
  statFailedDownloads.textContent = data.failedDownloads;
  
  // Estimate Progress
  const totalProcessed = data.pagesScraped + data.assetsDownloaded;
  const grandTotal = totalProcessed + data.queueSize;
  
  let percent = 0;
  if (grandTotal > 0) {
    // Math cap at 99% until crawler fully terminates and saves index files
    percent = Math.min(Math.round((totalProcessed / grandTotal) * 100), 99);
  }
  
  progressBarFill.style.width = `${percent}%`;
  progressPercentage.textContent = `${percent}%`;
  
  if (data.isPaused) {
    progressStatusText.textContent = 'Crawler engine paused.';
    btnPause.classList.add('hidden');
    btnResume.classList.remove('hidden');
  } else if (data.isCancelled) {
    progressStatusText.textContent = 'Cancelling scraper...';
  } else {
    progressStatusText.textContent = `Scraping: ${data.activeCrawls} active thread workers. Queue size: ${data.queueSize}.`;
    btnResume.classList.add('hidden');
    btnPause.classList.remove('hidden');
  }
});

window.electronAPI.onScraperFinished((data) => {
  // Restore Inputs
  inputUrl.disabled = false;
  btnSelectDir.disabled = false;
  btnStop.disabled = false;
  
  // Restore Button Defaults
  btnStart.classList.remove('hidden');
  btnPause.classList.add('hidden');
  btnResume.classList.add('hidden');
  btnStop.classList.add('hidden');
  
  globalRunningIndicator.classList.add('hidden');
  terminalPulse.classList.remove('active');
  
  // Set final progress
  progressBarFill.style.width = '100%';
  progressPercentage.textContent = '100%';
  
  if (data.cancelled) {
    progressStatusText.textContent = 'Scraping stopped by user.';
    appendLog('Crawl stopped. Output folder preserved.', 'warn');
  } else if (data.error) {
    progressStatusText.textContent = `Scrape Error: ${data.error}`;
    appendLog(`Crawler stopped with error: ${data.error}`, 'error');
  } else {
    progressStatusText.textContent = 'Scraping task completed!';
    appendLog('Process completed successfully. Local mirror ready.', 'system');
  }
  
  loadHistory();
});

// --- Scraped History List Generator ---
async function loadHistory() {
  historyList.innerHTML = '<div class="no-history">Querying history archive...</div>';
  
  try {
    const list = await window.electronAPI.getScrapeHistory();
    
    if (!list || list.length === 0) {
      historyList.innerHTML = '<div class="no-history">No sites scraped yet. Start a crawl in the Dashboard!</div>';
      return;
    }
    
    historyList.innerHTML = '';
    list.forEach(item => {
      const card = document.createElement('div');
      card.classList.add('card', 'history-card');
      
      const sizeMB = (item.sizeBytes / (1024 * 1024)).toFixed(2);
      
      card.innerHTML = `
        <div class="history-details">
          <div class="history-url" title="${item.url}">${item.url}</div>
          <div class="history-meta">
            <div class="meta-item">
              <svg class="meta-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
              <span>${item.date}</span>
            </div>
            <div class="meta-item">
              <svg class="meta-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
              <span>${item.pagesScraped} Pages</span>
            </div>
            <div class="meta-item">
              <svg class="meta-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>
              <span>${item.assetsDownloaded} Assets</span>
            </div>
            <div class="meta-item">
              <svg class="meta-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              <span>${sizeMB} MB</span>
            </div>
          </div>
        </div>
        <div class="history-actions">
          <button class="btn btn-secondary btn-sm btn-open-folder" data-dir="${item.outputDir.replace(/\\/g, '\\\\')}">Open Folder</button>
          <button class="btn btn-primary btn-sm btn-preview" data-dir="${item.outputDir.replace(/\\/g, '\\\\')}">Preview Site</button>
          <button class="btn btn-success btn-sm btn-zip" data-dir="${item.outputDir.replace(/\\/g, '\\\\')}">Export ZIP</button>
        </div>
      `;
      
      // Bind actions
      card.querySelector('.btn-open-folder').addEventListener('click', () => {
        window.electronAPI.openDirectory(item.outputDir);
      });
      
      card.querySelector('.btn-preview').addEventListener('click', async () => {
        appendLog(`Initializing site preview server for folder: ${item.outputDir}`, 'system');
        
        // Show indicator on the preview panel
        previewStatusLabel.textContent = 'Launching Local Server...';
        
        // Call preview server start
        const url = await window.electronAPI.startPreviewServer(item.outputDir);
        
        if (url) {
          // Switch to preview tab
          navItems.forEach(nav => {
            if (nav.getAttribute('data-tab') === 'preview') nav.click();
          });
        } else {
          alert('Failed to launch the local preview server.');
        }
      });
      
      card.querySelector('.btn-zip').addEventListener('click', async (e) => {
        const btn = e.target;
        const originalText = btn.textContent;
        btn.textContent = 'Compressing...';
        btn.disabled = true;
        
        try {
          const zipPath = await window.electronAPI.zipDirectory(item.outputDir);
          if (zipPath) {
            alert(`Site compressed successfully!\nArchive saved to: ${zipPath}`);
          } else {
            alert('Failed to create ZIP package.');
          }
        } catch (e) {
          alert(`Zip error: ${e.message}`);
        } finally {
          btn.textContent = originalText;
          btn.disabled = false;
        }
      });
      
      historyList.appendChild(card);
    });
  } catch (e) {
    historyList.innerHTML = `<div class="no-history">Error fetching history archive: ${e.message}</div>`;
  }
}

btnRefreshHistory.addEventListener('click', loadHistory);

// --- Preview Server Event & Panel Controls Logic ---
window.electronAPI.onServerStatus((data) => {
  if (data.running) {
    previewStatusPill.classList.remove('offline');
    previewStatusPill.classList.add('online');
    previewStatusLabel.textContent = 'Server Online';
    previewUrlDisplay.value = data.url;
    
    previewPlaceholder.classList.add('hidden');
    previewWebview.classList.remove('hidden');
    previewWebview.src = data.url;
  } else {
    previewStatusPill.classList.remove('online');
    previewStatusPill.classList.add('offline');
    previewStatusLabel.textContent = 'Server Offline';
    previewUrlDisplay.value = '';
    
    previewPlaceholder.classList.remove('hidden');
    previewWebview.classList.add('hidden');
    previewWebview.src = 'about:blank';
  }
});

btnPreviewRefresh.addEventListener('click', () => {
  if (previewWebview && previewWebview.src !== 'about:blank') {
    previewWebview.reload();
  }
});

btnPreviewExternal.addEventListener('click', () => {
  const url = previewUrlDisplay.value;
  if (url) {
    // Webview url is opened in system browser using default shell handler
    // We can do this in main, or directly open url
    window.open(url, '_blank');
  }
});

btnStopPreview.addEventListener('click', () => {
  window.electronAPI.stopPreviewServer();
});

// --- Initial Setup and Defaults ---
// Attempt to generate a default output path when directories are loading
document.addEventListener('DOMContentLoaded', () => {
  // Load initial history
  loadHistory();
});

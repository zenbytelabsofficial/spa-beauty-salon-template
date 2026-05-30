const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const EventEmitter = require('events');

class ScraperEngine extends EventEmitter {
  constructor(startUrl, outputDir, options = {}) {
    super();
    
    // Normalize starting URL
    let normalizedUrl = startUrl.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }
    
    this.startUrl = normalizedUrl;
    this.outputDir = path.resolve(outputDir);
    
    // Options with defaults
    this.maxDepth = options.maxDepth !== undefined ? parseInt(options.maxDepth) : 5;
    this.numWorkers = options.numWorkers !== undefined ? parseInt(options.numWorkers) : 5;
    this.timeout = options.timeout !== undefined ? parseInt(options.timeout) * 1000 : 10000; // ms
    this.delay = options.delay !== undefined ? parseFloat(options.delay) * 1000 : 100; // ms
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    this.cookies = options.cookies || '';
    this.customHeaders = options.customHeaders || {};
    
    // Asset filters (default to true/download)
    this.downloadCss = options.downloadCss !== false;
    this.downloadJs = options.downloadJs !== false;
    this.downloadImages = options.downloadImages !== false;
    this.downloadMedia = options.downloadMedia !== false;
    
    try {
      const parsed = new URL(this.startUrl);
      this.startDomain = parsed.hostname;
      this.scheme = parsed.protocol;
    } catch (e) {
      throw new Error(`Invalid starting URL: ${this.startUrl}`);
    }
    
    // Axios instance config
    const headers = {
      'User-Agent': this.userAgent,
      ...this.customHeaders
    };
    if (this.cookies) {
      headers['Cookie'] = this.cookies;
    }
    this.client = axios.create({
      headers,
      timeout: this.timeout,
      responseType: 'arraybuffer', // binary-safe
      validateStatus: () => true // Resolve promise for all status codes
    });
    
    // State tracking
    this.visitedPages = new Set();      // Crawled page URLs (without fragments)
    this.pageDepths = new Map([[this.startUrl, 0]]);
    this.pageLocalPaths = new Map();    // URL -> absolute file path
    this.downloadedAssets = new Map();  // URL -> absolute file path or 'downloading' or null
    
    this.toCrawlQueue = [];             // BFS queue: array of { url, depth }
    
    // Control variables
    this.isPaused = false;
    this.isCancelled = false;
    this.activeWorkers = 0;
    this.stats = {
      pagesScraped: 0,
      assetsDownloaded: 0,
      failedDownloads: 0,
      activeCrawls: 0
    };
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    this.emit('log', { timestamp, level, message });
  }

  isInternal(url) {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.toLowerCase();
      const startDomain = this.startDomain.toLowerCase();
      
      if (domain === startDomain) return true;
      if (startDomain.startsWith('www.') && domain === startDomain.substring(4)) return true;
      if (domain.startsWith('www.') && domain.substring(4) === startDomain) return true;
      
      return false;
    } catch (e) {
      // Relative URLs are internal
      return true;
    }
  }

  getLocalPath(url, isHtml = false) {
    try {
      const parsed = new URL(url);
      let pathname = decodeURIComponent(parsed.pathname);
      
      // Default file for directory/empty paths
      if (!pathname || pathname === '/') {
        pathname = '/index.html';
      } else if (pathname.endsWith('/')) {
        pathname += 'index.html';
      }
      
      let ext = path.extname(pathname);
      let base = pathname.substring(0, pathname.length - ext.length);
      
      // Enforce .html for pages
      if (isHtml && !['.html', '.htm', '.php', '.asp', '.aspx', '.jsp'].includes(ext.toLowerCase())) {
        pathname = base + '.html';
        ext = '.html';
        base = pathname.substring(0, pathname.length - ext.length);
      }
      
      // Support dynamic pages by appending sanitized query parameters
      if (parsed.search) {
        let querySanitized = parsed.search.replace(/[^a-zA-Z0-9_\-]/g, '_');
        if (querySanitized.length > 60) {
          querySanitized = crypto.createHash('md5').update(parsed.search).digest('hex');
        }
        pathname = `${base}_${querySanitized}${ext || '.html'}`;
        ext = path.extname(pathname);
      }
      
      if (!ext) {
        pathname = pathname + (isHtml ? '.html' : '');
        ext = path.extname(pathname);
      }
      
      // Sanitize path parts for Windows compatibility
      const parts = pathname.split(/[/\\]+/).filter(Boolean);
      const sanitizedParts = parts.map(part => {
        // Windows invalid characters: < > : " / \ | ? *
        return part.replace(/[<>:"|?*]/g, '_');
      });
      
      const localRelPath = sanitizedParts.length ? path.join(...sanitizedParts) : 'index.html';
      let localAbsPath = path.resolve(path.join(this.outputDir, localRelPath));
      
      // Directory traversal check
      if (!localAbsPath.startsWith(this.outputDir)) {
        const safeName = crypto.createHash('md5').update(url).digest('hex');
        localAbsPath = path.join(this.outputDir, `safe_${safeName}${ext || '.html'}`);
      }
      
      return localAbsPath;
    } catch (e) {
      const safeName = crypto.createHash('md5').update(url).digest('hex');
      return path.join(this.outputDir, `safe_${safeName}${isHtml ? '.html' : ''}`);
    }
  }

  async downloadAsset(url, referrerUrl = null) {
    let resolvedUrl;
    try {
      resolvedUrl = new URL(url, referrerUrl || this.startUrl).toString();
    } catch (e) {
      return null;
    }
    
    // Remove fragment
    const parsed = new URL(resolvedUrl);
    parsed.hash = '';
    const urlNoFrag = parsed.toString();
    
    // Check download rules / filters
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (!this.downloadCss && ext === '.css') return null;
    if (!this.downloadJs && ext === '.js') return null;
    if (!this.downloadImages && ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) return null;
    if (!this.downloadMedia && ['.mp4', '.mp3', '.webm', '.ogg', '.wav'].includes(ext)) return null;
    
    // Thread-safe-like check of asset cache
    while (true) {
      if (this.downloadedAssets.has(urlNoFrag)) {
        const status = this.downloadedAssets.get(urlNoFrag);
        if (status === 'downloading') {
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        return status; // absolute path or null
      }
      this.downloadedAssets.set(urlNoFrag, 'downloading');
      break;
    }
    
    const localPath = this.getLocalPath(urlNoFrag, false);
    
    try {
      this.log(`Downloading asset: ${urlNoFrag}`);
      if (this.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.delay));
      }
      
      if (this.isCancelled) {
        this.downloadedAssets.set(urlNoFrag, null);
        return null;
      }
      
      const response = await this.client.get(urlNoFrag);
      if (response.status === 200) {
        await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
        
        const contentType = (response.headers['content-type'] || '').toLowerCase();
        const isCss = contentType.includes('text/css') || urlNoFrag.endsWith('.css');
        
        if (isCss) {
          // Process CSS imports
          let cssText = response.data.toString('utf8');
          cssText = await this.processCssContent(cssText, urlNoFrag, localPath);
          await fsPromises.writeFile(localPath, cssText, 'utf8');
        } else {
          // Write binary buffer
          await fsPromises.writeFile(localPath, response.data);
        }
        
        this.downloadedAssets.set(urlNoFrag, localPath);
        this.stats.assetsDownloaded++;
        this.emitProgress();
        return localPath;
      } else {
        this.log(`Failed asset: HTTP ${response.status} - ${urlNoFrag}`, 'warn');
        this.downloadedAssets.set(urlNoFrag, null);
        this.stats.failedDownloads++;
        this.emitProgress();
        return null;
      }
    } catch (e) {
      this.log(`Error asset ${urlNoFrag}: ${e.message}`, 'error');
      this.downloadedAssets.set(urlNoFrag, null);
      this.stats.failedDownloads++;
      this.emitProgress();
      return null;
    }
  }

  async processCssContent(cssData, cssUrl, cssLocalPath) {
    const urlPattern = /url\s*\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi;
    const matches = [];
    let match;
    
    while ((match = urlPattern.exec(cssData)) !== null) {
      matches.push({
        full: match[0],
        url: match[1].trim()
      });
    }
    
    for (const item of matches) {
      if (item.url.startsWith('data:') || item.url.startsWith('#') || item.url.startsWith('javascript:') || item.url.startsWith('mailto:') || item.url.startsWith('tel:')) {
        continue;
      }
      
      let resolved;
      try {
        resolved = new URL(item.url, cssUrl).toString();
      } catch (e) {
        continue;
      }
      
      const assetLocalPath = await this.downloadAsset(resolved, cssUrl);
      if (assetLocalPath) {
        const relPath = path.relative(path.dirname(cssLocalPath), assetLocalPath);
        const relPathUrl = relPath.replace(/\\/g, '/');
        cssData = cssData.replace(item.full, `url('${relPathUrl}')`);
      }
    }
    
    return cssData;
  }

  queuePage(url, depth) {
    if (depth > this.maxDepth) return;
    
    // Normalize URL
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return;
    }
    parsed.hash = '';
    const urlNoFrag = parsed.toString();
    
    if (this.visitedPages.has(urlNoFrag) || this.pageDepths.has(urlNoFrag)) {
      return;
    }
    
    this.pageDepths.set(urlNoFrag, depth);
    this.toCrawlQueue.push({ url: urlNoFrag, depth });
    this.emitProgress();
  }

  async crawlPage(url, depth) {
    const parsed = new URL(url);
    parsed.hash = '';
    const urlNoFrag = parsed.toString();
    
    if (this.visitedPages.has(urlNoFrag)) return;
    this.visitedPages.add(urlNoFrag);
    
    this.log(`Crawling page (depth ${depth}): ${urlNoFrag}`);
    this.stats.activeCrawls++;
    this.emitProgress();
    
    try {
      if (this.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, this.delay));
      }
      
      if (this.isCancelled) {
        this.stats.activeCrawls--;
        this.emitProgress();
        return;
      }
      
      const response = await this.client.get(urlNoFrag);
      if (response.status !== 200) {
        this.log(`Failed page: HTTP ${response.status} - ${urlNoFrag}`, 'warn');
        this.stats.failedDownloads++;
        this.stats.activeCrawls--;
        this.emitProgress();
        return;
      }
      
      const contentType = (response.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('text/html')) {
        this.log(`Page is non-HTML (${contentType}), downloading as asset: ${urlNoFrag}`);
        await this.downloadAsset(urlNoFrag);
        this.stats.activeCrawls--;
        this.emitProgress();
        return;
      }
      
      const htmlText = response.data.toString('utf8');
      const $ = cheerio.load(htmlText);
      const localPath = this.getLocalPath(urlNoFrag, true);
      
      this.pageLocalPaths.set(urlNoFrag, localPath);
      
      await this.processPageElements($, urlNoFrag, localPath, depth);
      
      // Write rewritten HTML
      await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
      await fsPromises.writeFile(localPath, $.html(), 'utf8');
      
      this.log(`Scraped: ${urlNoFrag} -> ${path.relative(this.outputDir, localPath)}`);
      this.stats.pagesScraped++;
    } catch (e) {
      this.log(`Error crawling page ${urlNoFrag}: ${e.message}`, 'error');
      this.stats.failedDownloads++;
    } finally {
      this.stats.activeCrawls--;
      this.emitProgress();
    }
  }

  async processPageElements($, pageUrl, pageLocalPath, depth) {
    const getRelativeUrl = (targetLocalPath) => {
      if (!targetLocalPath) return null;
      const rel = path.relative(path.dirname(pageLocalPath), targetLocalPath);
      return rel.replace(/\\/g, '/');
    };
    
    // 1. Stylesheets & Favicons (<link href="..." rel="...">)
    const links = $('link[href]').get();
    for (const el of links) {
      const href = $(el).attr('href').trim();
      if (!href || href.startsWith('data:') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
        continue;
      }
      
      const relAttr = ($(el).attr('rel') || '').toLowerCase();
      const isStylesheet = relAttr.includes('stylesheet');
      const isIcon = relAttr.includes('icon') || relAttr.includes('shortcut') || relAttr.includes('apple-touch-icon');
      
      let resolvedUrl;
      try {
        resolvedUrl = new URL(href, pageUrl).toString();
      } catch (e) {
        continue;
      }
      
      if (isStylesheet || isIcon) {
        const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
        if (assetPath) {
          $(el).attr('href', getRelativeUrl(assetPath));
        }
      } else {
        if (this.isInternal(resolvedUrl)) {
          const targetPath = this.getLocalPath(resolvedUrl, true);
          $(el).attr('href', getRelativeUrl(targetPath));
        }
      }
    }

    // 2. Scripts (<script src="...">)
    const scripts = $('script[src]').get();
    for (const el of scripts) {
      const src = $(el).attr('src').trim();
      if (!src || src.startsWith('data:') || src.startsWith('javascript:')) {
        continue;
      }
      
      let resolvedUrl;
      try {
        resolvedUrl = new URL(src, pageUrl).toString();
      } catch (e) {
        continue;
      }
      
      const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
      if (assetPath) {
        $(el).attr('src', getRelativeUrl(assetPath));
      }
    }

    // 3. Images (<img> src, lazy loading src, srcset)
    const imgs = $('img').get();
    for (const el of imgs) {
      const src = $(el).attr('src');
      if (src) {
        const trimmedSrc = src.trim();
        if (trimmedSrc && !trimmedSrc.startsWith('data:') && !trimmedSrc.startsWith('javascript:')) {
          let resolvedUrl;
          try {
            resolvedUrl = new URL(trimmedSrc, pageUrl).toString();
          } catch (e) {}
          
          if (resolvedUrl) {
            const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
            if (assetPath) {
              $(el).attr('src', getRelativeUrl(assetPath));
            }
          }
        }
      }
      
      // Lazy loaded images
      for (const attr of ['data-src', 'data-original', 'lazy-src']) {
        const lazySrc = $(el).attr(attr);
        if (lazySrc) {
          const trimmedLazy = lazySrc.trim();
          if (trimmedLazy && !trimmedLazy.startsWith('data:') && !trimmedLazy.startsWith('javascript:')) {
            let resolvedUrl;
            try {
              resolvedUrl = new URL(trimmedLazy, pageUrl).toString();
            } catch (e) {}
            
            if (resolvedUrl) {
              const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
              if (assetPath) {
                $(el).attr(attr, getRelativeUrl(assetPath));
              }
            }
          }
        }
      }
      
      // Srcset attribute
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const parts = srcset.split(',');
        const newParts = [];
        for (let part of parts) {
          part = part.trim();
          if (!part) continue;
          const tokens = part.split(/\s+/);
          if (!tokens.length) continue;
          const imgUrl = tokens[0];
          const extra = tokens.slice(1).join(' ');
          
          if (!imgUrl.startsWith('data:') && !imgUrl.startsWith('javascript:')) {
            let resolvedUrl;
            try {
              resolvedUrl = new URL(imgUrl, pageUrl).toString();
            } catch (e) {}
            
            if (resolvedUrl) {
              const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
              if (assetPath) {
                const relUrl = getRelativeUrl(assetPath);
                newParts.push(`${relUrl} ${extra}`.trim());
              } else {
                newParts.push(part);
              }
            } else {
              newParts.push(part);
            }
          } else {
            newParts.push(part);
          }
        }
        if (newParts.length) {
          $(el).attr('srcset', newParts.join(', '));
        }
      }
    }

    // 4. Sources (<source src="..." srcset="...">)
    const sources = $('source').get();
    for (const el of sources) {
      const src = $(el).attr('src');
      if (src) {
        const trimmedSrc = src.trim();
        if (!trimmedSrc.startsWith('data:') && !trimmedSrc.startsWith('javascript:')) {
          let resolvedUrl;
          try {
            resolvedUrl = new URL(trimmedSrc, pageUrl).toString();
          } catch (e) {}
          
          if (resolvedUrl) {
            const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
            if (assetPath) {
              $(el).attr('src', getRelativeUrl(assetPath));
            }
          }
        }
      }
      
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const parts = srcset.split(',');
        const newParts = [];
        for (let part of parts) {
          part = part.trim();
          if (!part) continue;
          const tokens = part.split(/\s+/);
          if (!tokens.length) continue;
          const imgUrl = tokens[0];
          const extra = tokens.slice(1).join(' ');
          
          if (!imgUrl.startsWith('data:') && !imgUrl.startsWith('javascript:')) {
            let resolvedUrl;
            try {
              resolvedUrl = new URL(imgUrl, pageUrl).toString();
            } catch (e) {}
            
            if (resolvedUrl) {
              const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
              if (assetPath) {
                const relUrl = getRelativeUrl(assetPath);
                newParts.push(`${relUrl} ${extra}`.trim());
              } else {
                newParts.push(part);
              }
            } else {
              newParts.push(part);
            }
          } else {
            newParts.push(part);
          }
        }
        if (newParts.length) {
          $(el).attr('srcset', newParts.join(', '));
        }
      }
    }

    // 5. Media & Iframes (<video src="...">, <iframe src="...">, etc.)
    const mediaTags = $('video, audio, embed, iframe').get();
    for (const el of mediaTags) {
      const src = $(el).attr('src');
      if (src) {
        const trimmedSrc = src.trim();
        if (!trimmedSrc.startsWith('data:') && !trimmedSrc.startsWith('javascript:')) {
          let resolvedUrl;
          try {
            resolvedUrl = new URL(trimmedSrc, pageUrl).toString();
          } catch (e) {}
          
          if (resolvedUrl) {
            if (el.tagName === 'iframe' && this.isInternal(resolvedUrl)) {
              const targetPath = this.getLocalPath(resolvedUrl, true);
              $(el).attr('src', getRelativeUrl(targetPath));
              this.queuePage(resolvedUrl, depth + 1);
            } else {
              const assetPath = await this.downloadAsset(resolvedUrl, pageUrl);
              if (assetPath) {
                $(el).attr('src', getRelativeUrl(assetPath));
              }
            }
          }
        }
      }
    }

    // 6. Hyperlinks (<a> href)
    const anchors = $('a[href]').get();
    for (const el of anchors) {
      const href = $(el).attr('href').trim();
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
        continue;
      }
      
      let resolvedUrl;
      try {
        resolvedUrl = new URL(href, pageUrl).toString();
      } catch (e) {
        continue;
      }
      
      const parsedResolved = new URL(resolvedUrl);
      const fragment = parsedResolved.hash;
      parsedResolved.hash = '';
      const urlNoFrag = parsedResolved.toString();
      
      if (this.isInternal(urlNoFrag)) {
        const targetPath = this.getLocalPath(urlNoFrag, true);
        let relUrl = getRelativeUrl(targetPath);
        if (fragment) {
          relUrl = `${relUrl}${fragment}`;
        }
        $(el).attr('href', relUrl);
        this.queuePage(urlNoFrag, depth + 1);
      } else {
        $(el).attr('href', resolvedUrl);
      }
    }
  }

  emitProgress() {
    this.emit('progress', {
      pagesScraped: this.stats.pagesScraped,
      assetsDownloaded: this.stats.assetsDownloaded,
      failedDownloads: this.stats.failedDownloads,
      activeCrawls: this.stats.activeCrawls,
      queueSize: this.toCrawlQueue.length,
      visitedSize: this.visitedPages.size,
      isPaused: this.isPaused,
      isCancelled: this.isCancelled
    });
  }

  pause() {
    if (this.isCancelled) return;
    this.isPaused = true;
    this.log('Scraper PAUSED');
    this.emitProgress();
  }

  resume() {
    if (this.isCancelled) return;
    this.isPaused = false;
    this.log('Scraper RESUMED');
    this.emitProgress();
  }

  cancel() {
    this.isCancelled = true;
    this.isPaused = false;
    this.log('Scraper CANCELLATION REQUESTED');
    this.emitProgress();
  }

  async run() {
    this.log(`Starting crawl for: ${this.startUrl}`);
    this.log(`Output folder: ${this.outputDir}`);
    await fsPromises.mkdir(this.outputDir, { recursive: true });
    
    this.toCrawlQueue = [{ url: this.startUrl, depth: 0 }];
    this.emitProgress();
    
    while (this.toCrawlQueue.length > 0 && !this.isCancelled) {
      // Manage Pause
      while (this.isPaused && !this.isCancelled) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      if (this.isCancelled) break;
      
      // Get all pages at current BFS level
      const currentLevel = [...this.toCrawlQueue];
      this.toCrawlQueue = [];
      const currentDepth = currentLevel[0].depth;
      
      this.log(`Starting BFS Depth Level ${currentDepth} (${currentLevel.length} pages to process)`);
      
      // Process level pages with a concurrency limit
      const chunks = [];
      for (let i = 0; i < currentLevel.length; i += this.numWorkers) {
        chunks.push(currentLevel.slice(i, i + this.numWorkers));
      }
      
      for (const chunk of chunks) {
        if (this.isCancelled) break;
        
        while (this.isPaused && !this.isCancelled) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (this.isCancelled) break;
        
        // Execute chunk concurrently
        await Promise.all(chunk.map(async (item) => {
          await this.crawlPage(item.url, item.depth);
        }));
      }
    }
    
    this.log('========================================');
    if (this.isCancelled) {
      this.log('Scrape CANCELLED by user!');
    } else {
      this.log('Scrape FINISHED successfully!');
    }
    this.log(`Saved to: ${this.outputDir}`);
    this.log(`Total Pages Crawled: ${this.stats.pagesScraped}`);
    this.log(`Total Assets Downloaded: ${this.stats.assetsDownloaded}`);
    this.log(`Failed Downloads: ${this.stats.failedDownloads}`);
    this.log('========================================');
    
    this.emit('finished', {
      cancelled: this.isCancelled,
      stats: this.stats,
      outputDir: this.outputDir
    });
  }
}

module.exports = ScraperEngine;

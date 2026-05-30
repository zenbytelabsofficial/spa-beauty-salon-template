#!/usr/bin/env python3
import os
import sys
import re
import time
import argparse
import logging
import hashlib
import threading
from urllib.parse import urlparse, urljoin, unquote
from concurrent.futures import ThreadPoolExecutor
from bs4 import BeautifulSoup
import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("scraper")

class WebsiteScraper:
    def __init__(self, start_url, output_dir, max_depth=5, num_workers=5, timeout=10, delay=0.1, user_agent=None):
        # Normalize starting URL
        if not urlparse(start_url).scheme:
            start_url = "https://" + start_url
            
        self.start_url = start_url
        self.output_dir = os.path.abspath(output_dir)
        self.max_depth = max_depth
        self.num_workers = num_workers
        self.timeout = timeout
        self.delay = delay
        
        parsed_start = urlparse(start_url)
        self.start_domain = parsed_start.netloc
        self.scheme = parsed_start.scheme
        
        self.session = requests.Session()
        ua = user_agent or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
        self.session.headers.update({"User-Agent": ua})
        
        # Crawl state tracking
        self.visited_pages = set()      # Crawled page URLs (without fragments)
        self.page_depths = {self.start_url: 0}
        self.page_local_paths = {}     # URL -> local absolute path
        self.downloaded_assets = {}    # URL -> local absolute path or "downloading" or None
        
        self.to_crawl = []             # List of (url, depth) for the next BFS level
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=self.num_workers)

    def is_internal(self, url):
        """Check if the URL belongs to the target domain or its subdomains."""
        parsed = urlparse(url)
        if not parsed.netloc:
            return True
            
        domain = parsed.netloc.lower()
        start_domain = self.start_domain.lower()
        
        if domain == start_domain:
            return True
        if start_domain.startswith("www.") and domain == start_domain[4:]:
            return True
        if domain.startswith("www.") and domain[4:] == start_domain:
            return True
        return False

    def get_local_path(self, url, is_html=False):
        """
        Determines the local absolute filesystem path for a given URL.
        Sanitizes path components to be valid on Windows/Linux and ensures
        all output files reside strictly inside the output directory.
        """
        parsed = urlparse(url)
        path = parsed.path
        
        # Decode URL-encoded characters (e.g. %20 -> space)
        path = unquote(path)
        
        # Handle index files for directories
        if not path or path == '/':
            path = '/index.html'
        elif path.endswith('/'):
            path += 'index.html'
            
        base, ext = os.path.splitext(path)
        
        # If it's a web page, ensure it gets a .html extension
        if is_html and ext.lower() not in ['.html', '.htm', '.php', '.asp', '.aspx', '.jsp']:
            path = base + '.html'
            base, ext = os.path.splitext(path)
            
        # Append query params to filename if they exist to support dynamic pages
        if parsed.query:
            query_sanitized = re.sub(r'[^a-zA-Z0-9_\-]', '_', parsed.query)
            if len(query_sanitized) > 60:
                query_sanitized = hashlib.md5(parsed.query.encode('utf-8')).hexdigest()
            path = f"{base}_{query_sanitized}{ext if ext else '.html'}"
            
        # Fallback default extension if missing
        base, ext = os.path.splitext(path)
        if not ext:
            path = path + ('.html' if is_html else '')

        # Split and sanitize directory/file parts
        parts = path.lstrip('/').replace('\\', '/').split('/')
        sanitized_parts = []
        for part in parts:
            if not part or part == '.' or part == '..':
                continue
            # Windows invalid filename chars: < > : " / \ | ? *
            clean_part = re.sub(r'[<>:"|?*]', '_', part)
            sanitized_parts.append(clean_part)
            
        local_rel_path = os.path.join(*sanitized_parts) if sanitized_parts else 'index.html'
        local_abs_path = os.path.abspath(os.path.join(self.output_dir, local_rel_path))
        
        # Security check: prevent escaping the output directory
        if not local_abs_path.startswith(self.output_dir):
            safe_name = hashlib.md5(url.encode('utf-8')).hexdigest()
            local_abs_path = os.path.join(self.output_dir, f"safe_{safe_name}{ext or '.html'}")
            
        return local_abs_path

    def download_asset(self, url, referrer_url=None):
        """
        Downloads a static asset (image, stylesheet, script, font, etc.)
        and returns its local absolute path.
        """
        # Resolve relative URLs
        url = urljoin(referrer_url or self.start_url, url)
        
        # Remove fragment
        parsed = urlparse(url)
        url_no_frag = parsed._replace(fragment='').geturl()
        
        # Thread-safe check/reserve of downloading asset
        while True:
            with self.lock:
                if url_no_frag not in self.downloaded_assets:
                    self.downloaded_assets[url_no_frag] = "downloading"
                    break
                status = self.downloaded_assets[url_no_frag]
                if status == "downloading":
                    # Release lock and wait for other thread to finish downloading
                    pass
                elif status is None:
                    return None
                else:
                    return status
            time.sleep(0.05)
            
        local_path = self.get_local_path(url_no_frag, is_html=False)
        
        try:
            logger.info(f"Downloading asset: {url_no_frag}")
            if self.delay > 0:
                time.sleep(self.delay)
                
            response = self.session.get(url_no_frag, timeout=self.timeout, stream=True)
            if response.status_code == 200:
                os.makedirs(os.path.dirname(local_path), exist_ok=True)
                
                content_type = response.headers.get('Content-Type', '').lower()
                is_css = 'text/css' in content_type or url_no_frag.endswith('.css')
                
                if is_css:
                    # Download whole content as string to parse nested url() imports
                    css_data = response.text
                    css_data = self.process_css_content(css_data, url_no_frag, local_path)
                    with open(local_path, 'w', encoding='utf-8', errors='ignore') as f:
                        f.write(css_data)
                else:
                    # Binary write
                    with open(local_path, 'wb') as f:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)
                                
                with self.lock:
                    self.downloaded_assets[url_no_frag] = local_path
                return local_path
            else:
                logger.warning(f"Failed asset: HTTP {response.status_code} - {url_no_frag}")
                with self.lock:
                    self.downloaded_assets[url_no_frag] = None
                return None
        except Exception as e:
            logger.error(f"Error asset {url_no_frag}: {e}")
            with self.lock:
                self.downloaded_assets[url_no_frag] = None
            return None

    def process_css_content(self, css_data, css_url, css_local_path):
        """Parses CSS content and downloads nested url(...) assets recursively."""
        url_pattern = re.compile(r'url\s*\(\s*[\'"]?([^\'"\)]+)[\'"]?\s*\)', re.IGNORECASE)
        
        def replace_url(match):
            original_ref = match.group(1).strip()
            
            # Skip schemas
            if original_ref.startswith(('data:', '#', 'javascript:', 'mailto:', 'tel:')):
                return match.group(0)
                
            resolved_url = urljoin(css_url, original_ref)
            asset_local_path = self.download_asset(resolved_url, referrer_url=css_url)
            
            if asset_local_path:
                rel_path = os.path.relpath(asset_local_path, os.path.dirname(css_local_path))
                rel_path_url = rel_path.replace('\\', '/')
                return f"url('{rel_path_url}')"
            else:
                return match.group(0)
                
        return url_pattern.sub(replace_url, css_data)

    def queue_page(self, url, depth):
        """Enqueues an internal HTML page for crawling if depth is acceptable."""
        if depth > self.max_depth:
            return
            
        with self.lock:
            if url in self.visited_pages or url in self.page_depths:
                return
            self.page_depths[url] = depth
            self.to_crawl.append((url, depth))

    def crawl_page(self, url, depth):
        """Downloads a page, extracts links/assets, rewrites references, and saves to file."""
        parsed = urlparse(url)
        url_no_frag = parsed._replace(fragment='').geturl()
        
        with self.lock:
            if url_no_frag in self.visited_pages:
                return
            self.visited_pages.add(url_no_frag)
            
        logger.info(f"Crawling page (depth {depth}): {url_no_frag}")
        
        try:
            if self.delay > 0:
                time.sleep(self.delay)
                
            response = self.session.get(url_no_frag, timeout=self.timeout)
            if response.status_code != 200:
                logger.warning(f"Failed to fetch page: HTTP {response.status_code} - {url_no_frag}")
                return
                
            content_type = response.headers.get('Content-Type', '').lower()
            if 'text/html' not in content_type:
                logger.info(f"Page is non-HTML ({content_type}), downloading as asset: {url_no_frag}")
                self.download_asset(url_no_frag)
                return
                
            soup = BeautifulSoup(response.text, 'html.parser')
            local_path = self.get_local_path(url_no_frag, is_html=True)
            
            with self.lock:
                self.page_local_paths[url_no_frag] = local_path
                
            self.process_page_elements(soup, url_no_frag, local_path, depth)
            
            # Save final rewritten HTML
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            with open(local_path, 'w', encoding='utf-8', errors='ignore') as f:
                # Use prettify() to clean up formatting, or write as-is
                f.write(soup.prettify())
                
            logger.info(f"Successfully scraped: {url_no_frag} -> {local_path}")
            
        except Exception as e:
            logger.error(f"Error crawling page {url_no_frag}: {e}")

    def process_page_elements(self, soup, page_url, page_local_path, depth):
        """Locates and downloads stylesheets, scripts, images, sources, and queues internal pages."""
        def get_relative_url(target_local_path):
            if not target_local_path:
                return None
            rel = os.path.relpath(target_local_path, os.path.dirname(page_local_path))
            return rel.replace('\\', '/')
            
        # 1. Stylesheets & Favicons (<link href="..." rel="...">)
        for tag in soup.find_all('link', href=True):
            href = tag['href'].strip()
            if not href or href.startswith(('data:', 'javascript:', 'mailto:', 'tel:')):
                continue
                
            rel = [r.lower() for r in tag.get('rel', [])]
            is_stylesheet = 'stylesheet' in rel
            is_icon = any(x in rel for x in ['icon', 'shortcut', 'apple-touch-icon'])
            resolved_url = urljoin(page_url, href)
            
            if is_stylesheet or is_icon:
                asset_path = self.download_asset(resolved_url, referrer_url=page_url)
                if asset_path:
                    tag['href'] = get_relative_url(asset_path)
            else:
                if self.is_internal(resolved_url):
                    target_path = self.get_local_path(resolved_url, is_html=True)
                    tag['href'] = get_relative_url(target_path)

        # 2. Scripts (<script src="...">)
        for tag in soup.find_all('script', src=True):
            src = tag['src'].strip()
            if not src or src.startswith(('data:', 'javascript:')):
                continue
                
            resolved_url = urljoin(page_url, src)
            asset_path = self.download_asset(resolved_url, referrer_url=page_url)
            if asset_path:
                tag['src'] = get_relative_url(asset_path)

        # 3. Images (<img> src, lazy loading src, srcset)
        for tag in soup.find_all('img'):
            src = tag.get('src')
            if src:
                src = src.strip()
                if src and not src.startswith(('data:', 'javascript:')):
                    resolved_url = urljoin(page_url, src)
                    asset_path = self.download_asset(resolved_url, referrer_url=page_url)
                    if asset_path:
                        tag['src'] = get_relative_url(asset_path)
                        
            # Dynamic / Lazy images
            for attr in ['data-src', 'data-original', 'lazy-src']:
                lazy_src = tag.get(attr)
                if lazy_src:
                    lazy_src = lazy_src.strip()
                    if lazy_src and not lazy_src.startswith(('data:', 'javascript:')):
                        resolved_url = urljoin(page_url, lazy_src)
                        asset_path = self.download_asset(resolved_url, referrer_url=page_url)
                        if asset_path:
                            tag[attr] = get_relative_url(asset_path)
                            
            # srcset attribute (images at various resolutions)
            srcset = tag.get('srcset')
            if srcset:
                new_parts = []
                for part in srcset.split(','):
                    part = part.strip()
                    if not part:
                        continue
                    tokens = part.split()
                    if not tokens:
                        continue
                    img_url = tokens[0]
                    extra = " ".join(tokens[1:]) if len(tokens) > 1 else ""
                    
                    if not img_url.startswith(('data:', 'javascript:')):
                        resolved_url = urljoin(page_url, img_url)
                        asset_path = self.download_asset(resolved_url, referrer_url=page_url)
                        if asset_path:
                            rel_url = get_relative_url(asset_path)
                            new_parts.append(f"{rel_url} {extra}".strip())
                        else:
                            new_parts.append(part)
                    else:
                        new_parts.append(part)
                if new_parts:
                    tag['srcset'] = ", ".join(new_parts)

        # 4. Sources (<source src="..." srcset="...">)
        for tag in soup.find_all('source'):
            src = tag.get('src')
            if src:
                src = src.strip()
                if not src.startswith(('data:', 'javascript:')):
                    resolved_url = urljoin(page_url, src)
                    asset_path = self.download_asset(resolved_url, referrer_url=page_url)
                    if asset_path:
                        tag['src'] = get_relative_url(asset_path)
                        
            srcset = tag.get('srcset')
            if srcset:
                new_parts = []
                for part in srcset.split(','):
                    part = part.strip()
                    if not part:
                        continue
                    tokens = part.split()
                    if not tokens:
                        continue
                    img_url = tokens[0]
                    extra = " ".join(tokens[1:]) if len(tokens) > 1 else ""
                    
                    if not img_url.startswith(('data:', 'javascript:')):
                        resolved_url = urljoin(page_url, img_url)
                        asset_path = self.download_asset(resolved_url, referrer_url=page_url)
                        if asset_path:
                            rel_url = get_relative_url(asset_path)
                            new_parts.append(f"{rel_url} {extra}".strip())
                        else:
                            new_parts.append(part)
                    else:
                        new_parts.append(part)
                if new_parts:
                    tag['srcset'] = ", ".join(new_parts)

        # 5. Media & Iframes (<video src="...">, <iframe src="...">, etc.)
        for tag in soup.find_all(['video', 'audio', 'embed', 'iframe']):
            src = tag.get('src')
            if src:
                src = src.strip()
                if not src.startswith(('data:', 'javascript:')):
                    resolved_url = urljoin(page_url, src)
                    if tag.name == 'iframe' and self.is_internal(resolved_url):
                        target_path = self.get_local_path(resolved_url, is_html=True)
                        tag['src'] = get_relative_url(target_path)
                        self.queue_page(resolved_url, depth + 1)
                    else:
                        asset_path = self.download_asset(resolved_url, referrer_url=page_url)
                        if asset_path:
                            tag['src'] = get_relative_url(asset_path)

        # 6. Hyperlinks (<a> href)
        for tag in soup.find_all('a', href=True):
            href = tag['href'].strip()
            if not href or href.startswith(('javascript:', 'mailto:', 'tel:', '#')):
                continue
                
            resolved_url = urljoin(page_url, href)
            parsed_resolved = urlparse(resolved_url)
            url_no_frag = parsed_resolved._replace(fragment='').geturl()
            fragment = parsed_resolved.fragment
            
            if self.is_internal(url_no_frag):
                target_path = self.get_local_path(url_no_frag, is_html=True)
                rel_url = get_relative_url(target_path)
                if fragment:
                    rel_url = f"{rel_url}#{fragment}"
                tag['href'] = rel_url
                
                # Queue internal HTML pages
                self.queue_page(url_no_frag, depth + 1)
            else:
                tag['href'] = resolved_url

    def run(self):
        """Runs the crawler using a level-by-level BFS approach with multithreading."""
        logger.info(f"Starting crawl for target: {self.start_url}")
        logger.info(f"Output directory: {self.output_dir}")
        os.makedirs(self.output_dir, exist_ok=True)
        
        self.to_crawl = [(self.start_url, 0)]
        
        while self.to_crawl:
            # Snapshot of pages to crawl at this BFS level
            current_level = self.to_crawl.copy()
            self.to_crawl.clear()
            
            logger.info(f"Processing Level (depth={current_level[0][1]}): {len(current_level)} pages...")
            
            futures = []
            for url, depth in current_level:
                futures.append(self.executor.submit(self.crawl_page, url, depth))
                
            # Wait for all pages in this level to finish parsing
            for fut in futures:
                try:
                    fut.result()
                except Exception as e:
                    logger.error(f"Error executing crawl task: {e}")
                    
        self.executor.shutdown(wait=True)
        logger.info("========================================")
        logger.info("Scrape finished successfully!")
        logger.info(f"Saved to: {self.output_dir}")
        logger.info(f"Pages crawled: {len(self.visited_pages)}")
        logger.info(f"Assets downloaded: {len([p for p in self.downloaded_assets.values() if p is not None])}")
        logger.info("========================================")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fully recursive website scraper and offline mirror creator.")
    parser.add_argument("url", help="The starting URL of the website to scrape.")
    parser.add_argument("-o", "--output", default="scraped_site", help="Local folder directory to save files.")
    parser.add_argument("-d", "--depth", type=int, default=5, help="Maximum recursion depth limit.")
    parser.add_argument("-w", "--workers", type=int, default=5, help="Number of concurrent thread workers.")
    parser.add_argument("-t", "--timeout", type=int, default=10, help="Timeout in seconds for HTTP requests.")
    parser.add_argument("--delay", type=float, default=0.1, help="Delay in seconds between requests.")
    parser.add_argument("--user-agent", default=None, help="Custom User-Agent header.")
    
    args = parser.parse_args()
    
    scraper = WebsiteScraper(
        start_url=args.url,
        output_dir=args.output,
        max_depth=args.depth,
        num_workers=args.workers,
        timeout=args.timeout,
        delay=args.delay,
        user_agent=args.user_agent
    )
    
    try:
        scraper.run()
    except KeyboardInterrupt:
        logger.info("Process interrupted by user. Shutting down...")
        sys.exit(0)

# Offline Website Scraper

A robust, full-featured Python command-line utility that crawls a website recursively, downloads all assets (HTML, CSS, JS, images, media, fonts), maps them to a local folder, and rewrites URLs relative to each page so you can browse the website completely offline.

## Key Features

- **Deep Level recursion**: BFS (Breadth-First Search) level-by-level crawling of all internal links up to a user-defined depth.
- **Concurrent Asset Downloads**: Uses a `ThreadPoolExecutor` to speed up asset downloads (images, scripts, styles).
- **Responsive Images Support**: Parses and downloads images listed under modern `srcset` and `source` tags.
- **Lazy Load Support**: Automatically downloads files listed in `data-src`, `data-original`, and `lazy-src`.
- **CSS Asset Extraction**: Parses CSS files for `url(...)` and downloads font and background assets recursively, updating the local CSS files relative to the asset locations.
- **URL Parameter Collisions Prevention**: Encodes page query parameters into filenames (e.g., `index_page_about.html` vs `index_page_contact.html`) to ensure dynamic content isn't overwritten.
- **Platform Agnostic & Secure**: Cleans invalid filename characters (such as `< > : " / \ | ? *` on Windows) and prevents directory traversal attacks.

## Installation

Ensure you have Python 3.8+ installed. Install the requirements with:

```bash
pip install -r requirements.txt
```

## Usage

Run the script by providing the target starting URL:

```bash
python scraper.py https://example.com -o scraped_site
```

### CLI Arguments

```text
positional arguments:
  url                   The starting URL of the website to scrape.

options:
  -h, --help            show this help message and exit
  -o OUTPUT, --output OUTPUT
                        Local folder directory to save files. (default: scraped_site)
  -d DEPTH, --depth DEPTH
                        Maximum recursion depth limit. (default: 5)
  -w WORKERS, --workers WORKERS
                        Number of concurrent thread workers. (default: 5)
  -t TIMEOUT, --timeout TIMEOUT
                        Timeout in seconds for HTTP requests. (default: 10)
  --delay DELAY         Delay in seconds between requests. (default: 0.1)
  --user-agent USER_AGENT
                        Custom User-Agent header.
```

### Verification & Offline Browsing

Once finished, navigate to the output folder (e.g., `scraped_site/`) and double-click `index.html` to open it in any web browser. You can browse the entire captured website without an active internet connection.

"""Tiny polite HTTP helper shared by the scrapers (stdlib only)."""
import time
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
DELAY = 1.5  # seconds between requests
_last = 0.0


def get(url, accept="*/*", retries=3):
    """GET a URL with a browser UA, waiting DELAY seconds between requests."""
    global _last
    for attempt in range(retries):
        wait = DELAY - (time.time() - _last)
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            print(f"  retry {attempt + 1} for {url}: {e}")
            time.sleep(3 * (attempt + 1))

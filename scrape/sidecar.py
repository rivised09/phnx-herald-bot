"""Network sidecar for the Phoenix Herald roster crawler.

The Node bot speaks JSON lines over stdin/stdout; this process owns every
byte that leaves the machine. Requests go out through Scrapling's curl_cffi
transport with browser TLS impersonation, so the client fingerprint is a real
Chrome instead of undici's - which is what the source was fingerprinting when
it started refusing sessions and forcing a login rotation on every pass.

Protocol (one JSON object per line, both directions):

    -> {"id":1,"op":"fetch","args":{"url":"https://...","cookie":"a=b"}}
    <- {"id":1,"ok":true,"result":{"status":200,"url":"...","html":"..."}}
    <- {"id":1,"ok":false,"error":{"code":"FETCH_ERROR","message":"..."}}
    <- {"event":"ready","python":"3.13.0","scrapling":"0.4.15"}   # at start

Operations:
    ping   - liveness and version info.
    fetch  - GET a page with TLS impersonation, following redirects.
    login  - fill the callofstats login form in a stealth browser and hand
             the resulting cookies back in Playwright storageState shape.

Only stdout carries protocol output; every log line goes to stderr.
"""

import json
import logging
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

logging.basicConfig(
    stream=sys.stderr,
    level=logging.WARNING,
    format="[sidecar] %(levelname)s %(message)s",
)

# Windows defaults stdout/stderr to the locale codec (cp1252), which cannot
# represent most page content; one stray arrow would abort a response write.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", newline="\n")
    except Exception:  # noqa: BLE001 - already UTF-8, or an odd terminal
        pass

# Scrapling attaches its own INFO handler to the root logger on import; the
# protocol owns stdout and the bot owns the log stream, so request chatter
# stays out unless it fails.
logging.disable(logging.INFO)

WORKERS = 6
_executor = ThreadPoolExecutor(max_workers=WORKERS)
_write_lock = threading.Lock()

# Cloudflare's interstitial is neither content nor, by itself, an account
# refusal: it means the clearance cookie was not accepted for this request.
# "challenge-platform" is deliberately absent - the cdn-cgi detection snippet
# carrying that string sits on every normal page.
CHALLENGE_RE = re.compile(
    r"cf-chl-|_cf_chl_|challenge-form|Checking your browser before|Just a moment|Enable JavaScript and cookies",
    re.I,
)
CHALLENGE_STATUSES = (403, 429, 503)


def emit(obj):
    with _write_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def version_info():
    try:
        import scrapling

        scrapling_version = scrapling.__version__
    except Exception:
        scrapling_version = "unknown"
    return {"python": sys.version.split()[0], "scrapling": scrapling_version}


# ------------------------------------------------------------------- fetch ---


def op_fetch(args):
    from scrapling.fetchers import Fetcher

    url = args.get("url")
    if not url:
        raise ValueError("missing url")

    timeout_ms = args.get("timeoutMs") or 20000
    max_redirects = args.get("maxRedirects") or 6

    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    cookie = args.get("cookie")
    if cookie:
        headers["Cookie"] = cookie

    try:
        resp = Fetcher.get(
            url,
            headers=headers,
            impersonate="chrome",
            stealthy_headers=False,
            follow_redirects=True,
            max_redirects=max_redirects,
            timeout=max(1.0, float(timeout_ms) / 1000.0),
            retries=0,
        )
    except Exception as err:  # noqa: BLE001 - every failure is reported upward
        name = type(err).__name__
        if "TooManyRedirects" in name or "redirect" in str(err).lower():
            # The source bounces discarded cookies in a loop; the Node side
            # reads that as an expired session rather than a network error.
            return {"status": 0, "url": url, "html": "", "redirectLoop": True, "challenge": False}
        raise RuntimeError(f"{name}: {str(err)[:400]}") from err

    encoding = getattr(resp, "encoding", None) or "utf-8"
    try:
        html = resp.body.decode(encoding, "replace")
    except Exception:
        html = resp.body.decode("utf-8", "replace")

    return {
        "status": int(resp.status or 0),
        "url": str(resp.url or url),
        "html": html,
        "redirectLoop": False,
        "challenge": resp.status in CHALLENGE_STATUSES or bool(CHALLENGE_RE.search(html)),
    }


# ------------------------------------------------------------------- login ---


def op_login(args):
    from scrapling.fetchers import StealthySession

    login_url = args.get("loginUrl")
    username = args.get("username")
    password = args.get("password")
    if not login_url or username is None or password is None:
        raise ValueError("missing loginUrl/username/password")

    timeout_ms = int(args.get("timeoutMs") or 30000)
    captured = {}

    def fill_and_submit(page):
        try:
            page.fill('input[name="username"]', username)
            page.fill('input[name="password"]', password)
        except Exception as err:  # noqa: BLE001
            captured["error"] = f"fill failed: {err}"
            return

        try:
            with page.expect_navigation(wait_until="domcontentloaded", timeout=timeout_ms):
                try:
                    page.click('button[type="submit"]')
                except Exception:
                    page.click("form button")
        except Exception:
            # No navigation fired: read whatever the click produced.
            try:
                page.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception:
                pass

        try:
            captured["url"] = page.url
        except Exception:
            captured["url"] = ""
        try:
            captured["title"] = page.title() or ""
        except Exception:
            captured["title"] = ""
        try:
            captured["cookies"] = page.context.cookies()
        except Exception:
            captured["cookies"] = []

    with StealthySession(headless=True, timeout=timeout_ms) as session:
        session.fetch(login_url, page_action=fill_and_submit, load_dom=True)

    if captured.get("error"):
        raise RuntimeError(captured["error"])

    cookies = captured.get("cookies") or []
    # Playwright's addCookies rejects anything that is not one of these three.
    for cookie in cookies:
        if cookie.get("sameSite") not in ("Strict", "Lax", "None"):
            cookie["sameSite"] = "Lax"

    return {
        "url": captured.get("url", ""),
        "title": captured.get("title", ""),
        "cookies": cookies,
    }


# ---------------------------------------------------------------- dispatch ---


OPS = {"ping": lambda _args: version_info(), "fetch": op_fetch, "login": op_login}


def handle(line):
    try:
        msg = json.loads(line)
    except Exception as err:  # noqa: BLE001
        emit({"ok": False, "error": {"code": "BAD_REQUEST", "message": str(err)}})
        return

    request_id = msg.get("id")
    op = msg.get("op")
    args = msg.get("args") or {}

    def run():
        handler = OPS.get(op)
        if handler is None:
            emit({
                "id": request_id,
                "ok": False,
                "error": {"code": "BAD_OP", "message": f"unknown op: {op}"},
            })
            return
        try:
            result = handler(args)
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as err:  # noqa: BLE001
            emit({
                "id": request_id,
                "ok": False,
                "error": {"code": "SIDECAR_ERROR", "message": str(err)[:800]},
            })

    _executor.submit(run)


def main():
    emit({"event": "ready", **version_info()})
    for line in sys.stdin:
        line = line.strip()
        if line:
            handle(line)
    _executor.shutdown(wait=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Ditherlab static server: like `python3 -m http.server` but with caching
disabled, so code updates are always picked up by browsers and the macOS app.

Usage: python3 scripts/serve.py [port] [--parent PID]
    (default port 8173, binds 127.0.0.1; with --parent the server exits as
    soon as that process disappears, so it never outlives the macOS app)
"""
import functools
import http.server
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PORT = 8173
PARENT_PID = None
_args = sys.argv[1:]
while _args:
    _arg = _args.pop(0)
    if _arg == '--parent':
        PARENT_PID = int(_args.pop(0))
    else:
        PORT = int(_arg)


def _watch_parent(pid):
    """Exit when the parent process is gone (app crashed or was force quit)."""
    while True:
        time.sleep(5)
        try:
            os.kill(pid, 0)  # signal 0: existence check only
        except ProcessLookupError:
            os._exit(0)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # no-store: mtime-based 304s must never serve stale modules
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet


if __name__ == '__main__':
    if PARENT_PID is not None:
        threading.Thread(target=_watch_parent, args=(PARENT_PID,),
                         daemon=True).start()
    server = http.server.ThreadingHTTPServer(
        ('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT))
    print(f'ditherlab serving {ROOT} on http://127.0.0.1:{PORT}')
    server.serve_forever()

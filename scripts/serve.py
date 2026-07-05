#!/usr/bin/env python3
"""Ditherlab static server: like `python3 -m http.server` but with caching
disabled, so code updates are always picked up by browsers and the macOS app.

Usage: python3 scripts/serve.py [port]   (default 8173, binds 127.0.0.1)
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8173


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet


if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(
        ('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT))
    print(f'ditherlab serving {ROOT} on http://127.0.0.1:{PORT}')
    server.serve_forever()

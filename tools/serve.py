"""Static preview server that tells browsers to revalidate every file.

  python tools/serve.py <dir> <port> [bind]

Plain `python -m http.server` sends no Cache-Control, so phones may keep an
old engine for minutes after an edit. It also allows cross-origin reads, so a
page on another host can embed the player from here.
"""
import functools
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


def main():
    root, port = sys.argv[1], int(sys.argv[2])
    bind = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"
    handler = functools.partial(NoCache, directory=root)
    http.server.ThreadingHTTPServer((bind, port), handler).serve_forever()


if __name__ == "__main__":
    main()

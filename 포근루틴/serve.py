#!/usr/bin/env python3
"""포근루틴을 같은 Wi-Fi의 아이폰에서 QR로 열 수 있게 로컬 서버를 켭니다."""

from __future__ import annotations

import json
import mimetypes
import os
import socket
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("POGEUN_PORT", "8787"))

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/png", ".png")


def lan_ips() -> list[str]:
    found: list[str] = []
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        primary = probe.getsockname()[0]
        probe.close()
        if not primary.startswith("127."):
            found.append(primary)
    except OSError:
        pass
    host = socket.gethostname()
    try:
        for info in socket.getaddrinfo(host, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith("127."):
                found.append(ip)
    except socket.gaierror:
        pass
    return found


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("포근루틴  " + (format % args) + "\n")

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] in ("/meta.json", "meta.json"):
            payload = json.dumps(
                {"url": self.server.public_url, "urls": self.server.public_urls},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()


def main() -> None:
    os.chdir(ROOT)
    ips = lan_ips()
    urls = [f"http://{ip}:{PORT}/" for ip in ips] or [f"http://127.0.0.1:{PORT}/"]
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.public_url = urls[0]
    server.public_urls = urls
    install = f"http://127.0.0.1:{PORT}/install.html"
    print()
    print("  포근루틴이 켜졌어요.")
    print("  맥 설치 화면:", install)
    print("  아이폰 주소:")
    for url in urls:
        print("   ", url)
    print()
    print("  아이폰과 맥이 같은 Wi-Fi인지 확인한 뒤 QR을 찍으세요.")
    print("  끝내려면 Ctrl+C")
    print()
    try:
        webbrowser.open(install)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  포근루틴 서버를 닫았어요.")


if __name__ == "__main__":
    main()

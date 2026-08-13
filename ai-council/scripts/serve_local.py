#!/usr/bin/env python3
"""로컬 AI 웹 UI — 127.0.0.1 전용."""

from __future__ import annotations

import json
import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
WEB = ROOT / "web"
DATA = Path(
    os.environ.get(
        "CONFIRMED_MEMORY_PATH",
        str(ROOT / "data" / "memory.json"),
    )
)
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from council.run import run_council  # noqa: E402
from memory.store import MemoryStore  # noqa: E402


HOST = "127.0.0.1"
PORT = int(os.environ.get("LOCAL_AI_WEB_PORT", "18792"))
DEFAULT_MODEL = os.environ.get("LOCAL_CHAT_MODEL", "qwen3.6:35b")
DEFAULT_BASE = os.environ.get("LOCAL_OLLAMA_URL", "http://127.0.0.1:11434")
MEMORY = MemoryStore(DATA)


def _load_dotenv() -> None:
    path = ROOT / "config" / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ[key.strip()] = value


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalAIWeb/0.2"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(code, data, "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            try:
                import urllib.request

                with urllib.request.urlopen(f"{DEFAULT_BASE}/api/tags", timeout=3) as res:
                    ok = res.status == 200
                self._send_json(
                    200,
                    {
                        "ok": ok,
                        "exposure": "loopback_only",
                        "model": os.environ.get("LOCAL_CHAT_MODEL", DEFAULT_MODEL),
                        "active_memory_count": MEMORY.count_active(),
                    },
                )
            except Exception as error:  # noqa: BLE001
                self._send_json(200, {"ok": False, "error": str(error)})
            return

        if path == "/api/memory":
            active = [
                {
                    "id": i.id,
                    "text": i.text,
                    "status": i.status,
                    "share_external": i.share_external,
                }
                for i in MEMORY.list_active()
            ]
            candidates = [
                {
                    "id": i.id,
                    "text": i.text,
                    "status": i.status,
                    "share_external": i.share_external,
                }
                for i in MEMORY.list_candidates()
            ]
            self._send_json(
                200,
                {"active": active, "candidates": candidates, "count": len(active)},
            )
            return

        if path in ("/", "/index.html"):
            html = (WEB / "index.html").read_bytes()
            self._send(200, html, "text/html; charset=utf-8")
            return

        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid_json"})
            return

        if path == "/api/memory/propose":
            try:
                item = MEMORY.propose(str(payload.get("text") or ""))
            except (ValueError, PermissionError) as error:
                self._send_json(400, {"error": str(error)})
                return
            self._send_json(
                200,
                {
                    "id": item.id,
                    "text": item.text,
                    "status": item.status,
                    "message": "후보로 저장됨. 확인하면 장기기억에 들어갑니다.",
                },
            )
            return

        if path == "/api/memory/confirm":
            try:
                item = MEMORY.confirm(
                    str(payload.get("id") or ""),
                    share_external=bool(payload.get("share_external")),
                )
            except KeyError as error:
                self._send_json(404, {"error": str(error)})
                return
            self._send_json(
                200,
                {
                    "id": item.id,
                    "text": item.text,
                    "status": item.status,
                    "share_external": item.share_external,
                    "active_memory_count": MEMORY.count_active(),
                },
            )
            return

        if path != "/api/ask":
            self._send_json(404, {"error": "not_found"})
            return

        prompt = str(payload.get("prompt") or "").strip()
        use_council = bool(payload.get("council"))
        if not prompt:
            self._send_json(400, {"error": "질문이 비어 있습니다."})
            return

        try:
            result = run_council(
                prompt=prompt,
                local_model=os.environ.get("LOCAL_CHAT_MODEL", DEFAULT_MODEL),
                base_url=os.environ.get("LOCAL_OLLAMA_URL", DEFAULT_BASE),
                use_external=False,
                use_local_council=use_council,
                think=False,
                memory_store=MEMORY,
                open_browser_consult=use_council,
            )
        except Exception as error:  # noqa: BLE001
            self._send_json(500, {"error": str(error)})
            return

        rec = result.recommendation
        self._send_json(
            200,
            {
                "answer": rec.recommended_content,
                "recommended_source": rec.recommended_source,
                "agreement": rec.agreement,
                "notes": rec.notes,
                "used_local_council": result.used_local_council,
                "local_model": result.local_model,
                "local_duration_ms": result.local_duration_ms,
                "active_memory_count": result.active_memory_count,
            },
        )


def main() -> int:
    _load_dotenv()
    if not (WEB / "index.html").exists():
        print("web/index.html 이 없습니다.", file=sys.stderr)
        return 1

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"로컬 AI UI: {url} (loopback only)", flush=True)
    if os.environ.get("LOCAL_AI_WEB_OPEN_BROWSER", "1") != "0":
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n중지됨", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

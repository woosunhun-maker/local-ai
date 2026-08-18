"""로컬 Ollama HTTP API 클라이언트."""

from __future__ import annotations

import re
from typing import Any

import httpx

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


class OllamaError(RuntimeError):
    pass


class OllamaClient:
    def __init__(self, base_url: str, model: str, timeout: float = 300.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    async def health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise OllamaError(
                "이 프로필의 Ollama(11435)에 연결하지 못했다. scripts/start.sh 로 서버를 확인하라."
            ) from exc
        data = response.json()
        names = [item.get("name", "") for item in data.get("models", [])]
        return {"ok": True, "models": names, "has_model": self.model in names}

    async def chat(self, messages: list[dict[str, str]]) -> str:
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/api/chat",
                    json=payload,
                )
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise OllamaError(f"Ollama 호출에 실패했다: {exc}") from exc

        data = response.json()
        content = (data.get("message") or {}).get("content") or ""
        return strip_think(content).strip()


def strip_think(text: str) -> str:
    cleaned = THINK_RE.sub("", text)
    return cleaned.strip()

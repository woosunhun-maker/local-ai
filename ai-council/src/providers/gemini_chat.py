"""Google Gemini 어댑터 (옵트인)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from providers.base import ProviderAnswer


class GeminiProvider:
    name = "gemini"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
    ) -> None:
        self.api_key = (
            api_key
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY")
            or ""
        ).strip()
        self.model = (
            model
            or os.environ.get("GEMINI_MODEL")
            or "gemini-2.0-flash"
        ).strip()

    def is_configured(self) -> bool:
        return bool(self.api_key)

    def chat(self, prompt: str, *, timeout_sec: float = 90.0) -> ProviderAnswer:
        if not self.is_configured():
            return ProviderAnswer(
                source=self.name,
                model=self.model,
                content="",
                error="GEMINI_API_KEY/GOOGLE_API_KEY 없음",
            )
        query = urllib.parse.urlencode({"key": self.api_key})
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{urllib.parse.quote(self.model)}:generateContent?{query}"
        )
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "systemInstruction": {
                "parts": [
                    {
                        "text": "Answer concisely in Korean unless the user asks otherwise."
                    }
                ]
            },
        }
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_sec) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:300]
            return ProviderAnswer(
                source=self.name,
                model=self.model,
                content="",
                error=f"HTTP {error.code}: {detail}",
            )
        except urllib.error.URLError as error:
            return ProviderAnswer(
                source=self.name,
                model=self.model,
                content="",
                error=f"연결 실패: {error}",
            )

        try:
            parts = body["candidates"][0]["content"]["parts"]
            content = "".join(str(part.get("text") or "") for part in parts)
        except (KeyError, IndexError, TypeError):
            return ProviderAnswer(
                source=self.name,
                model=self.model,
                content="",
                error="응답 형식 오류",
            )
        return ProviderAnswer(
            source=self.name,
            model=self.model,
            content=content.strip(),
        )

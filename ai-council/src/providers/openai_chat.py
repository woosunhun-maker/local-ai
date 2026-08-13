"""OpenAI Chat Completions 어댑터 (옵트인)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from providers.base import ProviderAnswer


class OpenAIProvider:
    name = "openai"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
    ) -> None:
        self.api_key = (api_key or os.environ.get("OPENAI_API_KEY") or "").strip()
        self.model = (
            model
            or os.environ.get("OPENAI_MODEL")
            or "gpt-4.1-mini"
        ).strip()

    def is_configured(self) -> bool:
        return bool(self.api_key)

    def chat(self, prompt: str, *, timeout_sec: float = 90.0) -> ProviderAnswer:
        if not self.is_configured():
            return ProviderAnswer(
                source=self.name,
                model=self.model,
                content="",
                error="OPENAI_API_KEY 없음",
            )
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "Answer concisely in Korean unless the user asks otherwise.",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
        }
        request = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
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
            content = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return ProviderAnswer(
                source=self.name,
                model=self.model,
                content="",
                error="응답 형식 오류",
            )
        return ProviderAnswer(
            source=self.name,
            model=str(body.get("model") or self.model),
            content=str(content or "").strip(),
        )

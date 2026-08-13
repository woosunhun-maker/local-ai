"""추가 로컬 모델 후보 (외부 키 없이 대조 데모용)."""

from __future__ import annotations

import os

from local.ollama_client import chat_local
from providers.base import ProviderAnswer


class LocalAltProvider:
    """Ollama의 두 번째 로컬 모델을 외부 슬롯처럼 취급한다."""

    name = "local_alt"

    def __init__(self, *, model: str | None = None, base_url: str | None = None) -> None:
        self.model = (
            model
            or os.environ.get("LOCAL_ALT_MODEL")
            or "qwen3:32b"
        ).strip()
        self.base_url = (
            base_url
            or os.environ.get("LOCAL_OLLAMA_URL")
            or "http://127.0.0.1:11434"
        ).strip()

    def is_configured(self) -> bool:
        return bool(self.model)

    def chat(self, prompt: str, *, timeout_sec: float = 180.0) -> ProviderAnswer:
        try:
            result = chat_local(
                prompt=prompt,
                model=self.model,
                base_url=self.base_url,
                think=False,
                timeout_sec=timeout_sec,
            )
        except Exception as error:  # noqa: BLE001
            return ProviderAnswer(
                source=self.name,
                model=self.model,
                content="",
                error=str(error),
            )
        return ProviderAnswer(
            source=self.name,
            model=result.model,
            content=result.content,
        )

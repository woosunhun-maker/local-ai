"""외부 AI 프로바이더 공통 계약."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ProviderAnswer:
    source: str
    model: str
    content: str
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and bool(self.content.strip())


class ChatProvider(Protocol):
    name: str

    def is_configured(self) -> bool: ...

    def chat(self, prompt: str, *, timeout_sec: float = 90.0) -> ProviderAnswer: ...

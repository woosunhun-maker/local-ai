"""설정된 외부 프로바이더 목록."""

from __future__ import annotations

from providers.base import ChatProvider
from providers.gemini_chat import GeminiProvider
from providers.openai_chat import OpenAIProvider


def configured_external_providers() -> list[ChatProvider]:
    providers: list[ChatProvider] = [OpenAIProvider(), GeminiProvider()]
    return [provider for provider in providers if provider.is_configured()]

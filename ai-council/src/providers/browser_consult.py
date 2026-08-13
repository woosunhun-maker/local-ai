"""브라우저 채팅 대행 골격. 기본은 클립보드+앱 열기(과금 API 없음)."""

from __future__ import annotations

import subprocess
from providers.base import ProviderAnswer


class BrowserConsultProvider:
    """
    ChatGPT/제미나이 '창에 나인 척 타이핑'의 1단계.
    - API 키 불필요
    - 질문을 클립보드에 넣고 앱/웹을 연다
    - 자동 전송까지는 OS 접근성 승인 후 다음 단계에서 확장
    """

    name = "browser_consult"

    def __init__(self, *, target: str = "chatgpt") -> None:
        self.target = target

    def is_configured(self) -> bool:
        return True

    def chat(self, prompt: str, *, timeout_sec: float = 90.0) -> ProviderAnswer:
        text = prompt.strip()
        if not text:
            return ProviderAnswer(
                source=self.name,
                model=self.target,
                content="",
                error="빈 질문",
            )
        try:
            subprocess.run(
                ["pbcopy"],
                input=text.encode("utf-8"),
                check=True,
                timeout=5,
            )
        except Exception as error:  # noqa: BLE001
            return ProviderAnswer(
                source=self.name,
                model=self.target,
                content="",
                error=f"클립보드 실패: {error}",
            )

        open_target = {
            "chatgpt": "https://chatgpt.com/",
            "gemini": "https://gemini.google.com/app",
        }.get(self.target, "https://chatgpt.com/")
        try:
            subprocess.run(["open", open_target], check=False, timeout=10)
        except Exception as error:  # noqa: BLE001
            return ProviderAnswer(
                source=self.name,
                model=self.target,
                content="",
                error=f"앱/웹 열기 실패: {error}",
            )

        return ProviderAnswer(
            source=self.name,
            model=self.target,
            content=(
                "다른 AI 창을 열었고, 질문을 클립보드에 넣었습니다. "
                "해당 창에서 붙여넣기(⌘V) 후 전송하세요. "
                "(완전 자동 전송은 다음 단계 — 접근성 권한 필요)"
            ),
        )

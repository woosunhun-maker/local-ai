"""외부 전송 전 민감정보 가드. 로컬 전용 경로는 통과시킨다."""

from __future__ import annotations

import re
from dataclasses import dataclass


SENSITIVE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("주민등록번호", re.compile(r"\b\d{6}\s*[-–]?\s*[1-4]\d{6}\b")),
    ("카드번호", re.compile(r"\b(?:\d[ -]*?){13,19}\b")),
    ("이메일", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)),
    ("휴대폰", re.compile(r"\b01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b")),
    (
        "비밀문구",
        re.compile(
            r"(비밀번호|패스워드|password|otp|인증번호|계좌번호|카드비번)",
            re.I,
        ),
    ),
)


@dataclass(frozen=True)
class PrivacyDecision:
    allowed: bool
    reason: str
    matched_labels: tuple[str, ...] = ()


def inspect_for_external(text: str) -> PrivacyDecision:
    """외부 AI로 보내기 전 검사. 하나라도 걸리면 거부."""
    matched: list[str] = []
    for label, pattern in SENSITIVE_PATTERNS:
        if pattern.search(text):
            matched.append(label)
    if matched:
        return PrivacyDecision(
            allowed=False,
            reason="외부 전송 차단: 민감 패턴이 감지되었습니다.",
            matched_labels=tuple(matched),
        )
    return PrivacyDecision(allowed=True, reason="외부 전송 검사 통과")


def assert_external_allowed(text: str) -> None:
    decision = inspect_for_external(text)
    if not decision.allowed:
        labels = ", ".join(decision.matched_labels)
        raise PermissionError(f"{decision.reason} ({labels})")

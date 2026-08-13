"""로컬 Ollama 호출 (루프백 전용)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class OllamaChatResult:
    model: str
    content: str
    total_duration_ms: int | None


def chat_local(
    *,
    prompt: str,
    model: str,
    base_url: str = "http://127.0.0.1:11434",
    think: bool = False,
    num_predict: int | None = None,
    timeout_sec: float = 180.0,
    memory_context: str = "",
) -> OllamaChatResult:
    if not prompt.strip():
        raise ValueError("질문이 비어 있습니다.")
    if not base_url.startswith("http://127.0.0.1") and not base_url.startswith(
        "http://localhost"
    ):
        raise ValueError("로컬 Ollama는 127.0.0.1/localhost 만 허용합니다.")

    system = (
        "당신은 사용자의 Mac에서 Ollama로 동작하는 로컬 AI입니다. "
        "클라우드 서비스가 아니며, 이 대화는 기본적으로 기기 밖으로 나가지 않습니다. "
        "한국어로 간결하고 정확하게 답하세요. "
        "아래에 '확인된 기억'이 있으면 사실로 참고하되, 없는 내용은 지어내지 마세요."
    )
    if memory_context.strip():
        system = system + "\n\n" + memory_context.strip()
    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "think": think,
    }
    if num_predict is not None:
        payload["options"] = {"num_predict": num_predict}

    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as error:
        raise RuntimeError(f"Ollama 연결 실패: {error}") from error

    message = body.get("message") or {}
    content = str(message.get("content") or "").strip()
    duration_ns = body.get("total_duration")
    duration_ms = int(duration_ns / 1_000_000) if isinstance(duration_ns, int) else None
    return OllamaChatResult(
        model=str(body.get("model") or model),
        content=content,
        total_duration_ms=duration_ms,
    )

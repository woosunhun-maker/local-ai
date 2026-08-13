"""여러 답변 대조 및 추천."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from local.ollama_client import chat_local


@dataclass(frozen=True)
class AnswerCandidate:
    source: str
    content: str
    model: str = ""


@dataclass(frozen=True)
class Recommendation:
    recommended_source: str
    recommended_content: str
    notes: str
    candidates: tuple[AnswerCandidate, ...]
    agreement: str = "unknown"


def recommend_local_only(local_content: str, *, model: str = "") -> Recommendation:
    candidate = AnswerCandidate(source="local", content=local_content, model=model)
    return Recommendation(
        recommended_source="local",
        recommended_content=local_content,
        notes="외부 AI 대조 비활성. 로컬 답만 사용했습니다.",
        candidates=(candidate,),
        agreement="n/a",
    )


def _extract_json_object(text: str) -> dict[str, object] | None:
    stripped = text.strip()
    try:
        value = json.loads(stripped)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", stripped)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def recommend_from_candidates(
    *,
    prompt: str,
    candidates: tuple[AnswerCandidate, ...],
    local_model: str,
    base_url: str,
) -> Recommendation:
    usable = tuple(c for c in candidates if c.content.strip())
    if not usable:
        return Recommendation(
            recommended_source="none",
            recommended_content="",
            notes="사용 가능한 답이 없습니다.",
            candidates=candidates,
            agreement="none",
        )
    if len(usable) == 1:
        only = usable[0]
        return Recommendation(
            recommended_source=only.source,
            recommended_content=only.content,
            notes="외부 답이 없어 로컬(또는 단일 소스)만 사용했습니다.",
            candidates=candidates,
            agreement="single",
        )

    numbered = "\n\n".join(
        f"[{index}] source={item.source} model={item.model}\n{item.content}"
        for index, item in enumerate(usable)
    )
    judge_prompt = (
        "당신은 여러 AI 답변을 대조하는 심사자입니다. 개인정보를 새로 만들지 마세요.\n"
        "아래 사용자 질문과 후보 답변을 보고 JSON만 출력하세요.\n"
        '형식: {"recommended_index":0,"agreement":"high|medium|low","notes":"한국어 한두 문장","recommended_content":"최종 추천 답"}\n'
        "recommended_content는 후보를 바탕으로 한 최적 답이며, 근거 없는 사실 추가를 피하세요.\n\n"
        f"질문:\n{prompt}\n\n후보:\n{numbered}"
    )
    judged = chat_local(
        prompt=judge_prompt,
        model=local_model,
        base_url=base_url,
        think=False,
        num_predict=800,
    )
    parsed = _extract_json_object(judged.content)
    if not parsed:
        fallback = usable[0]
        return Recommendation(
            recommended_source=fallback.source,
            recommended_content=fallback.content,
            notes="대조 JSON 파싱 실패로 로컬 후보를 사용했습니다.",
            candidates=candidates,
            agreement="parse_failed",
        )

    index_raw = parsed.get("recommended_index", 0)
    try:
        index = int(index_raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        index = 0
    if index < 0 or index >= len(usable):
        index = 0
    chosen = usable[index]
    content = str(parsed.get("recommended_content") or chosen.content).strip()
    notes = str(parsed.get("notes") or "로컬 모델이 후보를 대조했습니다.").strip()
    agreement = str(parsed.get("agreement") or "unknown").strip()
    return Recommendation(
        recommended_source=chosen.source,
        recommended_content=content or chosen.content,
        notes=notes,
        candidates=candidates,
        agreement=agreement,
    )

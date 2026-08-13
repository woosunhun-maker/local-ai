"""질문 → 로컬 + (옵션) 대행/대조 → 추천."""

from __future__ import annotations

from dataclasses import dataclass

from compare.recommend import AnswerCandidate, Recommendation, recommend_from_candidates
from local.ollama_client import chat_local
from memory.store import MemoryStore
from privacy.guard import assert_external_allowed
from providers.base import ChatProvider, ProviderAnswer
from providers.browser_consult import BrowserConsultProvider
from providers.local_alt import LocalAltProvider
from providers.registry import configured_external_providers


@dataclass(frozen=True)
class CouncilResult:
    recommendation: Recommendation
    local_model: str
    local_duration_ms: int | None
    external_attempts: tuple[ProviderAnswer, ...]
    used_external: bool
    used_local_council: bool
    active_memory_count: int


def run_council(
    *,
    prompt: str,
    local_model: str,
    base_url: str,
    use_external: bool = False,
    use_local_council: bool = False,
    think: bool = False,
    memory_store: MemoryStore | None = None,
    open_browser_consult: bool = False,
) -> CouncilResult:
    if use_external and use_local_council:
        raise ValueError("--external 과 --council 은 동시에 쓰지 마세요.")

    memory_block = ""
    active_count = 0
    if memory_store is not None:
        active_count = memory_store.count_active()
        memory_block = memory_store.active_context_block(query=prompt, for_external=False)

    local = chat_local(
        prompt=prompt,
        model=local_model,
        base_url=base_url,
        think=think,
        memory_context=memory_block,
    )
    candidates = [
        AnswerCandidate(source="local", content=local.content, model=local.model)
    ]
    attempts: list[ProviderAnswer] = []
    providers: list[ChatProvider] = []

    if use_external:
        assert_external_allowed(prompt)
        providers = configured_external_providers()
        if not providers:
            raise RuntimeError(
                "외부 AI 키가 없습니다. 키 없이 쓰려면 --council(또는 웹 체크)을 사용하세요."
            )
    elif use_local_council:
        assert_external_allowed(prompt)
        providers = [LocalAltProvider(base_url=base_url)]
        if open_browser_consult:
            providers.append(BrowserConsultProvider(target="chatgpt"))

    if providers:
        for provider in providers:
            answer = provider.chat(prompt)
            attempts.append(answer)
            if answer.ok and answer.source != "browser_consult":
                candidates.append(
                    AnswerCandidate(
                        source=answer.source,
                        content=answer.content,
                        model=answer.model,
                    )
                )
            elif answer.ok and answer.source == "browser_consult":
                # 브라우저 안내는 후보 대조에 넣지 않고 notes로만 활용
                pass

        recommendation = recommend_from_candidates(
            prompt=prompt,
            candidates=tuple(candidates),
            local_model=local_model,
            base_url=base_url,
        )
        browser_notes = [
            a.content for a in attempts if a.source == "browser_consult" and a.ok
        ]
        if browser_notes:
            recommendation = Recommendation(
                recommended_source=recommendation.recommended_source,
                recommended_content=recommendation.recommended_content,
                notes=(recommendation.notes + " | " + browser_notes[0]).strip(" |"),
                candidates=recommendation.candidates,
                agreement=recommendation.agreement,
            )
    else:
        recommendation = Recommendation(
            recommended_source="local",
            recommended_content=local.content,
            notes="대조 비활성. 로컬 답만 사용했습니다.",
            candidates=tuple(candidates),
            agreement="n/a",
        )

    return CouncilResult(
        recommendation=recommendation,
        local_model=local.model,
        local_duration_ms=local.total_duration_ms,
        external_attempts=tuple(attempts),
        used_external=use_external,
        used_local_council=use_local_council,
        active_memory_count=active_count,
    )

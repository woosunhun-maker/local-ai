from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from compare.recommend import AnswerCandidate, recommend_from_candidates
from council.run import run_council
from local.ollama_client import OllamaChatResult
from providers.base import ProviderAnswer
from providers.openai_chat import OpenAIProvider
from privacy.guard import inspect_for_external


class PrivacyGuardTests(unittest.TestCase):
    def test_safe_text_allows_external(self) -> None:
        decision = inspect_for_external("Home Assistant 자동화 조건을 어떻게 짜면 좋을까?")
        self.assertTrue(decision.allowed)

    def test_phone_blocks_external(self) -> None:
        decision = inspect_for_external("내 번호는 010-1234-5678 이야")
        self.assertFalse(decision.allowed)
        self.assertIn("휴대폰", decision.matched_labels)


class ProviderConfigTests(unittest.TestCase):
    def test_openai_without_key_is_not_configured(self) -> None:
        provider = OpenAIProvider(api_key="")
        self.assertFalse(provider.is_configured())
        answer = provider.chat("hi")
        self.assertFalse(answer.ok)
        self.assertIn("OPENAI_API_KEY", answer.error or "")


class CouncilTests(unittest.TestCase):
    def test_local_only_path(self) -> None:
        fake = OllamaChatResult(model="qwen", content="로컬답", total_duration_ms=10)

        with patch("council.run.chat_local", return_value=fake):
            result = run_council(
                prompt="안녕",
                local_model="qwen",
                base_url="http://127.0.0.1:11434",
                use_external=False,
            )
        self.assertEqual(result.recommendation.recommended_content, "로컬답")
        self.assertFalse(result.used_external)
        self.assertFalse(result.used_local_council)

    def test_local_council_path(self) -> None:
        local = OllamaChatResult(model="qwen-a", content="A답", total_duration_ms=10)
        judge = OllamaChatResult(
            model="qwen-a",
            content='{"recommended_index":0,"agreement":"high","notes":"일치","recommended_content":"합의답"}',
            total_duration_ms=12,
        )

        class FakeAlt:
            name = "local_alt"

            def is_configured(self) -> bool:
                return True

            def chat(self, prompt: str, *, timeout_sec: float = 90.0) -> ProviderAnswer:
                return ProviderAnswer(source="local_alt", model="qwen-b", content="B답")

        with (
            patch("council.run.chat_local", return_value=local),
            patch("council.run.LocalAltProvider", return_value=FakeAlt()),
            patch("compare.recommend.chat_local", return_value=judge),
        ):
            result = run_council(
                prompt="일반 질문",
                local_model="qwen-a",
                base_url="http://127.0.0.1:11434",
                use_local_council=True,
            )
        self.assertTrue(result.used_local_council)
        self.assertEqual(result.recommendation.recommended_content, "합의답")

    def test_external_without_keys_errors(self) -> None:
        fake = OllamaChatResult(model="qwen", content="로컬답", total_duration_ms=10)
        with (
            patch("council.run.chat_local", return_value=fake),
            patch("council.run.configured_external_providers", return_value=[]),
        ):
            with self.assertRaises(RuntimeError):
                run_council(
                    prompt="안전한 일반 질문",
                    local_model="qwen",
                    base_url="http://127.0.0.1:11434",
                    use_external=True,
                )

    def test_external_compare_uses_judge(self) -> None:
        local = OllamaChatResult(model="qwen", content="로컬 의견", total_duration_ms=11)
        judge = OllamaChatResult(
            model="qwen",
            content='{"recommended_index":1,"agreement":"medium","notes":"외부 쪽이 더 구체적","recommended_content":"최종 추천"}',
            total_duration_ms=12,
        )

        class FakeProvider:
            name = "openai"

            def is_configured(self) -> bool:
                return True

            def chat(self, prompt: str, *, timeout_sec: float = 90.0) -> ProviderAnswer:
                return ProviderAnswer(source="openai", model="gpt-test", content="외부 의견")

        with (
            patch("council.run.chat_local", side_effect=[local, judge]),
            patch(
                "council.run.configured_external_providers",
                return_value=[FakeProvider()],
            ),
            patch("compare.recommend.chat_local", return_value=judge),
        ):
            result = run_council(
                prompt="일반 기술 질문",
                local_model="qwen",
                base_url="http://127.0.0.1:11434",
                use_external=True,
            )
        self.assertEqual(result.recommendation.recommended_content, "최종 추천")
        self.assertEqual(result.recommendation.recommended_source, "openai")
        self.assertEqual(result.recommendation.agreement, "medium")


class RecommendParseTests(unittest.TestCase):
    def test_single_candidate(self) -> None:
        rec = recommend_from_candidates(
            prompt="q",
            candidates=(AnswerCandidate(source="local", content="only"),),
            local_model="qwen",
            base_url="http://127.0.0.1:11434",
        )
        self.assertEqual(rec.agreement, "single")
        self.assertEqual(rec.recommended_content, "only")


if __name__ == "__main__":
    unittest.main()

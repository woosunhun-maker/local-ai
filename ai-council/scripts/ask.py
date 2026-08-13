#!/usr/bin/env python3
"""로컬 AI 질문 + (옵션) 로컬/외부 대조 CLI."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from council.run import run_council  # noqa: E402
from privacy.guard import assert_external_allowed  # noqa: E402


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_env_files() -> dict[str, str]:
    defaults = _parse_env_file(ROOT / "config" / ".env.example")
    secrets = _parse_env_file(ROOT / "config" / ".env")
    for key, value in secrets.items():
        if value:
            os.environ[key] = value
    return {**defaults, **secrets}


def build_parser(defaults: dict[str, str]) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="AI Council — 로컬 우선 / --council 로컬대조 / --external 외부대조"
    )
    parser.add_argument("prompt", nargs="?", help="질문 문장")
    parser.add_argument(
        "--model",
        default=os.environ.get(
            "LOCAL_CHAT_MODEL", defaults.get("LOCAL_CHAT_MODEL", "qwen3.6:35b")
        ),
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get(
            "LOCAL_OLLAMA_URL",
            defaults.get("LOCAL_OLLAMA_URL", "http://127.0.0.1:11434"),
        ),
    )
    parser.add_argument(
        "--council",
        action="store_true",
        help="외부 키 없이 로컬 모델 2개로 대조 (기본+LOCAL_ALT_MODEL)",
    )
    parser.add_argument(
        "--external",
        action="store_true",
        help="설정된 외부 AI에 같은 질문을 보내고 로컬이 대조",
    )
    parser.add_argument("--json", action="store_true", help="JSON으로 출력")
    parser.add_argument("--think", action="store_true", help="로컬 thinking 모드")
    return parser


def main(argv: list[str] | None = None) -> int:
    defaults = load_env_files()
    parser = build_parser(defaults)
    args = parser.parse_args(argv)
    prompt = args.prompt
    if not prompt:
        if sys.stdin.isatty():
            parser.error("질문을 인자로 넣거나 파이프로 전달하세요.")
        prompt = sys.stdin.read().strip()
    if not prompt:
        parser.error("질문이 비어 있습니다.")

    if args.external:
        try:
            assert_external_allowed(prompt)
        except PermissionError as error:
            print(str(error), file=sys.stderr)
            return 2

    try:
        result = run_council(
            prompt=prompt,
            local_model=args.model,
            base_url=args.base_url,
            use_external=bool(args.external),
            use_local_council=bool(args.council),
            think=bool(args.think),
        )
    except (RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 3
    except Exception as error:  # noqa: BLE001
        print(f"실패: {error}", file=sys.stderr)
        return 1

    rec = result.recommendation
    if args.json:
        payload = {
            "used_external": result.used_external,
            "used_local_council": result.used_local_council,
            "local_model": result.local_model,
            "local_duration_ms": result.local_duration_ms,
            "recommended_source": rec.recommended_source,
            "agreement": rec.agreement,
            "notes": rec.notes,
            "answer": rec.recommended_content,
            "candidates": [
                {"source": c.source, "model": c.model, "content": c.content}
                for c in rec.candidates
            ],
            "attempt_errors": [
                {"source": a.source, "error": a.error}
                for a in result.external_attempts
                if a.error
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(rec.recommended_content)
        meta = [f"source:{rec.recommended_source}", f"local:{result.local_model}"]
        if result.local_duration_ms is not None:
            meta.append(f"{result.local_duration_ms}ms")
        if result.used_external or result.used_local_council:
            meta.append(f"agreement:{rec.agreement}")
            others = [c.source for c in rec.candidates if c.source != "local"]
            if others:
                meta.append("peers:" + ",".join(others))
            meta.append(rec.notes)
        print("\n— " + " · ".join(meta), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

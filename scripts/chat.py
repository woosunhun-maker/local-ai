#!/usr/bin/env python3
"""터미널에서 로컬 Qwen3와 대화한다. 내용은 이 맥에만 남는다."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from memory import ConversationMemory
from ollama_client import OllamaClient, OllamaError

SYSTEM = (
    "너는 이 Mac에서만 동작하는 로컬 AI다. "
    "이름은 로컬 AI이고, 모델은 Qwen3 8B다. "
    "모든 답은 한국어로 친절하고 명확하게 한다. "
    "개인 대화와 기억은 이 맥 안에만 둔다."
)


async def main() -> None:
    memory = ConversationMemory(ROOT / "data" / "conversations.json")
    client = OllamaClient("http://127.0.0.1:11435", "qwen3:8b")
    chat_id = 0
    print("로컬 AI (Qwen3 8B). 끝내려면 /exit , 기억 지우려면 /reset")
    try:
        health = await client.health()
        print("모델:", "준비됨" if health["has_model"] else "없음")
    except OllamaError as exc:
        print(exc)
        raise SystemExit(1)

    while True:
        try:
            text = input("나: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not text:
            continue
        if text in {"/exit", "/quit"}:
            break
        if text == "/reset":
            memory.reset(chat_id)
            print("기억을 지웠다.")
            continue
        memory.append(chat_id, "user", text)
        messages = [{"role": "system", "content": SYSTEM}, *memory.history(chat_id)]
        try:
            reply = await client.chat(messages)
        except OllamaError as exc:
            print("오류:", exc)
            continue
        memory.append(chat_id, "assistant", reply)
        print("로컬 AI:", reply)


if __name__ == "__main__":
    asyncio.run(main())

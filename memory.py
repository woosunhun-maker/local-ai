"""대화 기억을 로컬 JSON에 저장한다."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MAX_TURNS = 30


class ConversationMemory:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._data: dict[str, list[dict[str, str]]] = self._load()

    def _load(self) -> dict[str, list[dict[str, str]]]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        if not isinstance(raw, dict):
            return {}
        return raw

    def _save(self) -> None:
        self.path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def history(self, chat_id: int) -> list[dict[str, str]]:
        return list(self._data.get(str(chat_id), []))

    def append(self, chat_id: int, role: str, content: str) -> None:
        key = str(chat_id)
        turns = self._data.setdefault(key, [])
        turns.append({"role": role, "content": content})
        if len(turns) > MAX_TURNS * 2:
            self._data[key] = turns[-(MAX_TURNS * 2) :]
        self._save()

    def reset(self, chat_id: int) -> None:
        self._data.pop(str(chat_id), None)
        self._save()

    def snapshot(self) -> dict[str, Any]:
        return {
            "chats": len(self._data),
            "path": str(self.path),
        }

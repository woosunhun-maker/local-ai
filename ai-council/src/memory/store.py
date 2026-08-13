"""확인형 장기기억 (채팅 폴더와 무관한 공통 프로필)."""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


FORBIDDEN = re.compile(
    r"(비밀번호|패스워드|password|otp|인증번호|주민등록|계좌|카드번호|010[-.\s]?\d{3,4})",
    re.I,
)
TOKEN = re.compile(r"[0-9A-Za-z가-힣]{2,}")


@dataclass(frozen=True)
class MemoryItem:
    id: str
    text: str
    status: str  # candidate | active
    share_external: bool
    created_at: float
    updated_at: float


class MemoryStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write({"items": []})

    def _read(self) -> dict[str, Any]:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self, data: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.path)
        self.path.chmod(0o600)

    def list_active(self) -> list[MemoryItem]:
        items = []
        for raw in self._read().get("items", []):
            if raw.get("status") == "active":
                items.append(self._item(raw))
        return items

    def list_candidates(self) -> list[MemoryItem]:
        items = []
        for raw in self._read().get("items", []):
            if raw.get("status") == "candidate":
                items.append(self._item(raw))
        return items

    def count_active(self) -> int:
        return len(self.list_active())

    def propose(self, text: str) -> MemoryItem:
        cleaned = text.strip()
        if not cleaned:
            raise ValueError("기억 내용이 비어 있습니다.")
        if FORBIDDEN.search(cleaned):
            raise PermissionError("민감정보로 보여 기억에 넣을 수 없습니다.")
        now = time.time()
        item = MemoryItem(
            id=str(uuid.uuid4()),
            text=cleaned,
            status="candidate",
            share_external=False,
            created_at=now,
            updated_at=now,
        )
        data = self._read()
        data["items"].append(item.__dict__)
        self._write(data)
        return item

    def confirm(self, memory_id: str, *, share_external: bool = False) -> MemoryItem:
        data = self._read()
        for raw in data["items"]:
            if raw.get("id") == memory_id:
                raw["status"] = "active"
                raw["share_external"] = bool(share_external)
                raw["updated_at"] = time.time()
                self._write(data)
                return self._item(raw)
        raise KeyError("기억을 찾을 수 없습니다.")

    def select_for_prompt(
        self,
        query: str,
        *,
        limit: int = 6,
        for_external: bool = False,
        char_limit: int = 1200,
    ) -> list[MemoryItem]:
        """질문과 겹치는 기억만 on-demand로 고른다. 없으면 최근 활성 기억."""
        active = [
            item
            for item in self.list_active()
            if (item.share_external if for_external else True)
        ]
        if not active:
            return []
        tokens = {t.lower() for t in TOKEN.findall(query)}
        scored: list[tuple[int, float, MemoryItem]] = []
        for item in active:
            item_tokens = {t.lower() for t in TOKEN.findall(item.text)}
            overlap = len(tokens & item_tokens)
            scored.append((overlap, item.updated_at, item))
        scored.sort(key=lambda row: (row[0], row[1]), reverse=True)
        if scored and scored[0][0] == 0:
            # 겹침 없으면 최신순만
            scored.sort(key=lambda row: row[1], reverse=True)
        selected: list[MemoryItem] = []
        used = 0
        for _, _, item in scored:
            if len(selected) >= limit:
                break
            if used + len(item.text) > char_limit and selected:
                break
            selected.append(item)
            used += len(item.text)
        return selected

    def active_context_block(
        self,
        *,
        query: str = "",
        for_external: bool = False,
        limit: int = 6,
    ) -> str:
        items = self.select_for_prompt(
            query,
            limit=limit,
            for_external=for_external,
        )
        if not items:
            return ""
        lines = [f"- {item.text}" for item in items]
        return "사용자에 대해 확인된 기억(관련 항목만):\n" + "\n".join(lines)

    @staticmethod
    def _item(raw: dict[str, Any]) -> MemoryItem:
        return MemoryItem(
            id=str(raw["id"]),
            text=str(raw["text"]),
            status=str(raw["status"]),
            share_external=bool(raw.get("share_external")),
            created_at=float(raw.get("created_at") or 0),
            updated_at=float(raw.get("updated_at") or 0),
        )

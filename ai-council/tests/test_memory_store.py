from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from memory.store import MemoryStore


class MemoryStoreTests(unittest.TestCase):
    def test_propose_confirm_and_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = MemoryStore(Path(tmp) / "memory.json")
            item = store.propose("커피는 아이스를 좋아함")
            self.assertEqual(item.status, "candidate")
            self.assertEqual(store.count_active(), 0)
            store.confirm(item.id)
            self.assertEqual(store.count_active(), 1)
            block = store.active_context_block(query="커피 뭐 마실까")
            self.assertIn("아이스", block)
            selected = store.select_for_prompt("커피", limit=3)
            self.assertEqual(len(selected), 1)

    def test_forbidden_memory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = MemoryStore(Path(tmp) / "memory.json")
            with self.assertRaises(PermissionError):
                store.propose("와이파이 비밀번호는 1234")


if __name__ == "__main__":
    unittest.main()

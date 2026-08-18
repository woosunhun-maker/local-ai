#!/usr/bin/env python3
"""텔레그램으로 로컬 Qwen3와 대화하는 브리지."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from memory import ConversationMemory
from ollama_client import OllamaClient, OllamaError

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_DIR / "bot.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("local-ai")

TELEGRAM_LIMIT = 4000
SYSTEM_PROMPT = (
    "너는 이 Mac에서만 동작하는 로컬 AI다. "
    "이름은 로컬 AI이고, 모델은 Qwen3 8B다. "
    "모든 답은 한국어로 친절하고 명확하게 한다. "
    "개인 대화와 기억은 이 맥 안에만 둔다. "
    "외부 클라우드 AI로 내용을 보내지 않는다. "
    "코딩이 아닌 일상 대화, 개인 질문, 기억을 우선한다."
)


def required_env() -> tuple[str, str, str, set[str]]:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        print(
            "TELEGRAM_BOT_TOKEN이 없다.\n"
            "1) Telegram에서 @BotFather에게 /newbot 또는 기존 봇 토큰을 받는다.\n"
            "2) .env.example을 복사해 .env를 만든다.\n"
            "3) TELEGRAM_BOT_TOKEN=토큰 을 넣고 다시 실행한다.\n"
            "   예: cp .env.example .env",
            file=sys.stderr,
        )
        raise SystemExit(1)

    model = os.getenv("OLLAMA_MODEL", "qwen3:8b").strip() or "qwen3:8b"
    url = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").strip()
    allowed = {
        item.strip()
        for item in os.getenv("ALLOWED_CHAT_ID", "").split(",")
        if item.strip()
    }
    return token, url, model, allowed


def split_message(text: str) -> list[str]:
    if len(text) <= TELEGRAM_LIMIT:
        return [text]
    chunks: list[str] = []
    remaining = text
    while remaining:
        chunks.append(remaining[:TELEGRAM_LIMIT])
        remaining = remaining[TELEGRAM_LIMIT:]
    return chunks


def is_allowed(chat_id: int, allowed: set[str]) -> bool:
    return str(chat_id) in allowed


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    await update.message.reply_text(
        "로컬 AI가 준비됐다. 이 맥의 Qwen3 8B와 대화한다.\n"
        "/reset 으로 기억을 지운다. /status 로 상태를 본다."
    )


async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_chat or not update.message:
        return
    memory: ConversationMemory = context.application.bot_data["memory"]
    allowed: set[str] = context.application.bot_data["allowed"]
    chat_id = update.effective_chat.id
    if allowed and not is_allowed(chat_id, allowed):
        await deny(update, chat_id)
        return
    memory.reset(chat_id)
    await update.message.reply_text("이 대화 기억을 지웠다.")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    client: OllamaClient = context.application.bot_data["ollama"]
    memory: ConversationMemory = context.application.bot_data["memory"]
    try:
        health = await client.health()
        models = ", ".join(health["models"]) or "(없음)"
        model_ok = "있음" if health["has_model"] else "없음 — ollama pull qwen3:8b 가 필요하다"
        text = (
            f"모델: {client.model} ({model_ok})\n"
            f"Ollama: {client.base_url}\n"
            f"설치된 모델: {models}\n"
            f"기억 파일: {memory.snapshot()['path']}"
        )
    except OllamaError as exc:
        text = str(exc)
    await update.message.reply_text(text)


async def deny(update: Update, chat_id: int) -> None:
    log.info("허용되지 않은 채팅 %s", chat_id)
    if update.message:
        await update.message.reply_text(
            f"이 채팅은 아직 허용되지 않았다.\n"
            f"채팅 ID: {chat_id}\n"
            f".env의 ALLOWED_CHAT_ID에 넣고 봇을 다시 시작해라."
        )


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.effective_chat:
        return
    text = (update.message.text or "").strip()
    if not text:
        return

    chat_id = update.effective_chat.id
    allowed: set[str] = context.application.bot_data["allowed"]
    log.info("메시지 chat_id=%s", chat_id)

    if not allowed:
        await deny(update, chat_id)
        return
    if not is_allowed(chat_id, allowed):
        await deny(update, chat_id)
        return

    memory: ConversationMemory = context.application.bot_data["memory"]
    client: OllamaClient = context.application.bot_data["ollama"]

    await update.message.chat.send_action(ChatAction.TYPING)
    memory.append(chat_id, "user", text)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *memory.history(chat_id)]

    try:
        reply = await client.chat(messages)
    except OllamaError as exc:
        log.exception("Ollama 오류")
        await update.message.reply_text(str(exc))
        return

    if not reply:
        reply = "(빈 응답)"
    memory.append(chat_id, "assistant", reply)
    for chunk in split_message(reply):
        await update.message.reply_text(chunk)


def main() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        print(
            ".env 파일이 없다. 아래를 실행한 뒤 토큰을 넣어라.\n"
            "  cp .env.example .env\n"
            "기존 텔레그램 토큰이 있으면 그걸 그대로 쓰고, 새로 만들지 않아도 된다.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    token, url, model, allowed = required_env()
    memory = ConversationMemory(ROOT / "data" / "conversations.json")
    client = OllamaClient(url, model)

    app = Application.builder().token(token).build()
    app.bot_data["memory"] = memory
    app.bot_data["ollama"] = client
    app.bot_data["allowed"] = allowed

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))

    log.info("로컬 AI 봇 시작 model=%s allowed=%s", model, ",".join(sorted(allowed)) or "(미설정)")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

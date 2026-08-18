# 로컬 AI (Qwen3 8B) + 텔레그램

이 맥에서 Ollama와 Qwen3 8B를 돌리고, 텔레그램으로만 대화한다.
대화는 이 컴퓨터 안에만 남는다. ChatGPT 등 클라우드로 보내지 않는다.

## 한 번만 하는 설치

터미널에서 프로젝트 폴더로 들어온 뒤:

```bash
cd /Users/baehayeong/local-ai
chmod +x scripts/*.sh
./scripts/install-ollama.sh
./scripts/setup.sh
OLLAMA_HOST=127.0.0.1:11435 ./bin/ollama pull qwen3:8b
```

이 프로필 전용으로 공식 `Ollama.app`을 `~/Applications`에 둔다. 다른 계정 Homebrew Ollama와 포트를 나눈다 (`11435`).

## 텔레그램 토큰 넣기

기존 봇 토큰이 있으면 그걸 그대로 쓴다. 새로 만들 필요는 없다. 토큰을 지우거나 폐기하지 않는다.

1. Telegram에서 [@BotFather](https://t.me/BotFather)를 연다.
2. 기존 봇이면 `/token` 또는 `/mybots`에서 토큰을 복사한다. 없으면 `/newbot`으로 만든다.
3. `.env`를 연다. (`setup.sh`가 없을 때만 `.env.example`을 복사한다.)

```bash
cp -n .env.example .env
```

4. 토큰만 넣는다. 채팅 ID는 첫 메시지로 자동 등록된다.

```bash
./scripts/set-token.sh 'BotFather토큰'
```

또는 `.env`에 직접:

```
TELEGRAM_BOT_TOKEN=여기에_토큰
ALLOWED_CHAT_ID=
```

5. 텔레그램에서 봇에게 `/start` 또는 아무 말을 보낸다. 그 채팅이 주인으로 등록된다.

허용되지 않은 채팅에는 모델을 호출하지 않는다. 기존 토큰은 지우지 않는다.

## 맥에서 바로 대화

텔레그램 토큰 없이도 이 맥에서 바로 대화할 수 있다.

```bash
/Users/baehayeong/local-ai/scripts/chat.sh
```

## 실행 / 중지

| 동작 | 명령 |
| --- | --- |
| 지금 켜기 | `./scripts/start.sh` |
| 끄기 | `./scripts/stop.sh` |
| 상태 | 텔레그램에서 `/status` |
| 기억 지우기 | 텔레그램에서 `/reset` |

`setup.sh`는 로그인 시 자동 실행용 LaunchAgent를 등록한다.

- `~/Library/LaunchAgents/com.baehayeong.ollama.plist`
- `~/Library/LaunchAgents/com.baehayeong.local-ai.plist`

`.env`에 토큰이 없으면 봇은 바로 종료되고, 로그에 넣는 방법을 남긴다.

## 구성

- 모델: `qwen3:8b` (이 프로필 전용 Ollama, 로컬 `127.0.0.1:11435`)
- 브리지: `bot.py`
- 기억: `data/conversations.json` (최근 30턴)
- 로그: `logs/`

## 만들지 않은 것

- ChatGPT / 클라우드 LLM 연동
- 웹 UI
- 기존 텔레그램 토큰 삭제

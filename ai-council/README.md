# AI Council (멀티 AI 대조)

로컬 AI가 먼저 답하고, 선택적으로 여러 답을 대조합니다. 최종 추천은 **로컬 모델**이 합니다.

## 사용

### 마우스 (추천)
- 바탕화면 **`로컬AI실행.command`** 더블클릭 → 브라우저 자동 오픈
- 질문 보내고, 필요할 때만 **「다른 AI에게 대신 물어보기」** 체크

프로젝트 안 원본: `scripts/로컬AI실행.command`  
바탕화면 재설치: `scripts/바탕화면에실행버튼설치.command`

### 터미널

```bash
cd "/Users/hun/Documents/로컬ai/ai-council"

# 웹 UI
python3 scripts/serve_local.py

# CLI 로컬 1개
python3 scripts/ask.py "질문"

# CLI 로컬 2모델 대조
python3 scripts/ask.py --council "질문"

# 외부 OpenAI/Gemini 대조 (키 필요)
python3 scripts/ask.py --external "일반 기술 질문"
```

API 키: `scripts/키넣기.command` (채팅에 키 붙이지 말 것)

## 원칙

1. 기본은 맥 로컬만
2. `--external` + API 키가 있을 때만 클라우드 호출
3. 민감 패턴은 외부 전송 전 차단
4. `config/.env`는 커밋 금지

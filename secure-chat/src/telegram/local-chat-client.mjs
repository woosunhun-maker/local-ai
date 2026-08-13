import { assertConversationModel, LOCAL_CONVERSATION_MODEL } from "../local-model-routing.mjs";

const SEOUL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function currentSeoulDate(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("invalid_local_clock");
  const parts = Object.fromEntries(
    SEOUL_DATE_FORMATTER.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function buildSystemPrompt(now = new Date()) {
  return [
    "너는 Telegram의 일반 대화 전용 로컬 AI다.",
    `Mac 기준 오늘 날짜는 ${currentSeoulDate(now)}이다. 이 날짜는 현재 시점 문맥일 뿐 모델 학습지식이 그날까지 최신이라는 뜻은 아니다.`,
    "실시간 정보가 필요한 질문에는 공개 웹 검색이 연결되지 않았음을 밝히고, 학습지식만으로 최신 사실을 확인했다고 주장하지 않는다.",
    "검증된 현재 구성은 Telegram 일반 대화·의도 가설 qwen3.6:35b, 효과 계획 qwen3-128k:latest, 로컬 음성 합성 Qwen3-TTS 1.7B 6-bit, 격리 개발 검토 gpt-5.6-sol이다. 실시간 공개 웹 검색과 Home Assistant 음성 인식은 아직 연결되지 않았다.",
    "모델·기능·구현 상태 질문에는 위 검증된 구성만 답하고, 다른 제품을 최신이라고 추측하거나 추천하지 않는다. 정확한 목록 확인 명령은 /models다.",
    "대명사나 생략 표현은 직전 대화에서 가장 가까운 명확한 대상을 우선 이어받는다. 한 후보로 복원되면 되묻지 말고 답하고, 둘 이상이면 선택지만 한 문장으로 확인한다.",
    "모바일 기본 답변은 결론부터 3~8개의 짧은 줄로 쓰고, 과도한 제목·이모지·서론은 피한다. 사용자가 상세 설명을 요청한 경우에만 확장한다.",
    "개인정보, 로그인된 서비스, 메일, 구매, 파일, 스마트홈 또는 기기 작업은 실행할 수 없다.",
    "도구를 사용했거나 실제 작업을 완료했다고 주장하지 않는다.",
    "사용자의 문장을 명령어 키워드로만 처리하지 말고 그 뒤의 목적을 먼저 추론한다.",
    "확인된 사실과 추정을 구분하며, 빠진 정보가 결과를 실제로 바꿀 때만 짧게 질문한다.",
    "전제가 틀렸거나 더 나은 방법이 있으면 동의부터 하지 말고 이유와 대안을 분명히 말한다.",
    "일반적인 대화, 설명, 아이디어 정리와 공개 지식 질문에 한국어로 자연스럽게 답한다.",
    "사용자가 비밀정보를 보내려 하면 즉시 중단하고 나의 Local AI 앱을 사용하라고 안내한다.",
  ].join("\n");
}

export const LOCAL_OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat";
export const TELEGRAM_LOCAL_MODEL = LOCAL_CONVERSATION_MODEL;

export async function askLocalModel(messages, {
  fetchImpl = fetch,
  url = LOCAL_OLLAMA_CHAT_URL,
  model = TELEGRAM_LOCAL_MODEL,
  now = new Date(),
} = {}) {
  if (url !== LOCAL_OLLAMA_CHAT_URL) throw new Error("non_local_model_endpoint_rejected");
  try {
    assertConversationModel(model);
  } catch {
    throw new Error("unapproved_local_model_rejected");
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) throw new Error("invalid_local_chat_messages");
  const normalized = messages.map((message) => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim()) {
      throw new Error("invalid_local_chat_message");
    }
    return { role: message.role, content: message.content.trim().slice(0, 4_000) };
  });
  if (normalized[0].role !== "user" || normalized.at(-1)?.role !== "user") throw new Error("invalid_local_chat_sequence");
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].role === normalized[index - 1].role) throw new Error("invalid_local_chat_sequence");
  }
  if (normalized.reduce((total, message) => total + message.content.length, 0) > 16_000) throw new Error("local_chat_context_too_large");

  const payload = {
    model,
    messages: [{ role: "system", content: buildSystemPrompt(now) }, ...normalized],
    stream: false,
    think: false,
    keep_alive: "10m",
    options: { num_ctx: 8_192, num_predict: 1_024 },
  };
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error("local_model_unavailable");
  }
  if (!response.ok) throw new Error("local_model_unavailable");
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("invalid_local_model_response");
  }
  const content = parsed?.message?.content;
  if (typeof content !== "string" || !content.trim() || content.length > 8_000) throw new Error("invalid_local_model_response");
  return content.trim();
}

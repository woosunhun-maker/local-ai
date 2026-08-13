import { LOCAL_CONVERSATION_MODEL, LOCAL_EFFECT_PLANNING_MODEL } from "../local-model-routing.mjs";
import { PINNED_QWEN_REPOSITORY } from "../tts/pinned-runtime.mjs";

export const ISOLATED_CODEX_MODEL = "gpt-5.6-sol";

export function formatLocalModelInventory({ codexReady = false } = {}) {
  return [
    "현재 구성된 모델",
    `• Telegram 일반 대화·의도 가설: ${LOCAL_CONVERSATION_MODEL}`,
    `• 효과 계획 전용: ${LOCAL_EFFECT_PLANNING_MODEL}`,
    `• 로컬 음성 합성: ${PINNED_QWEN_REPOSITORY}`,
    `• 격리 개발 검토: ${codexReady ? `${ISOLATED_CODEX_MODEL} · Local AI 앱 서명 승인 전용` : "비활성"}`,
    "• 실시간 공개 웹 검색: 아직 연결 안 됨",
    "• Home Assistant 음성 인식: 아직 연결 안 됨",
    "이 목록은 구성값이며, /status에서 현재 서비스 가동 여부를 따로 확인합니다.",
    "모델이 직접 구매·메일·파일·홈 제어를 실행하지는 않습니다.",
  ].join("\n");
}

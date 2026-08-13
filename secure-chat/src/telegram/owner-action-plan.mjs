/**
 * Telegram 일상 대화에서 감지한 작업을 앱 승인용 계획으로 만든다.
 * 결제·민감 조회는 실행 계획에 넣지 않는다.
 */
import { createHash } from "node:crypto";

export const OWNER_ACTION_SCHEMA = "local-ai.owner-action-plan.v1";
export const OWNER_ACTION_KIND = "owner.action.v1";

const HUMAN_ONLY = Object.freeze([
  /(?:결제|구매\s*확정|주문\s*확정|checkout|purchase|payment|송금|이체)/iu,
  /(?:비밀번호|패스워드|otp|인증번호|주민등록|계좌|카드번호)/iu,
]);

const COUPANG_CART = /(?:쿠팡|coupang|장바구니).{0,80}(?:넣어|담아|추가해)/iu;
const COUPANG_SEARCH = /(?:쿠팡|coupang).{0,80}(?:검색|찾아|보여)/iu;

function utteranceSha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function extractCoupangQuery(text) {
  const cleaned = String(text)
    .replace(/(?:쿠팡|coupang|에서|장바구니|에|을|를|넣어|담아|추가해|검색해|찾아|보여|줘|주세요|해줘|해)/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || cleaned.length > 80) return "생수";
  return cleaned.slice(0, 80);
}

export function classifyOwnerAction(text) {
  const normalized = String(text ?? "").normalize("NFKC").trim();
  if (!normalized) {
    return Object.freeze({ mode: "reject", reason: "empty_action_text" });
  }
  if (HUMAN_ONLY.some((pattern) => pattern.test(normalized))) {
    return Object.freeze({
      mode: "human_only",
      reason: "payment_or_sensitive",
      message:
        "결제·비밀번호·계좌 같은 민감 작업은 자동으로 하지 않습니다. 직접 진행해 주세요. 일반 준비 작업만 앱에서 승인할 수 있습니다.",
    });
  }

  if (COUPANG_CART.test(normalized) || COUPANG_SEARCH.test(normalized)) {
    const query = extractCoupangQuery(normalized);
    const wantsCart = COUPANG_CART.test(normalized);
    return Object.freeze({
      mode: "approval",
      plan: Object.freeze({
        schema: OWNER_ACTION_SCHEMA,
        action: "coupang.search",
        query,
        note: wantsCart
          ? "검색까지 자동. 장바구니 담기와 결제는 앱/직접 확인."
          : "쿠팡 공개 검색만 실행.",
        utteranceSha256: utteranceSha256(normalized),
        escalateCart: wantsCart,
      }),
      title: "쿠팡 검색 실행 승인",
      summary: wantsCart
        ? `‘${query}’ 검색 후 장바구니·결제는 직접/앱에서 확인합니다.`
        : `‘${query}’ 쿠팡 공개 검색을 1회 실행합니다.`,
    });
  }

  return Object.freeze({
    mode: "approval",
    plan: Object.freeze({
      schema: OWNER_ACTION_SCHEMA,
      action: "owner.prepare_only",
      note: "실행기는 아직 연결 전. 승인하면 앱 받은함에 준비 완료만 남깁니다.",
      utteranceSha256: utteranceSha256(normalized),
      escalateCart: false,
    }),
    title: "작업 준비 승인",
    summary: "Telegram에서 요청한 작업을 앱에서 확인·승인합니다. 결제·민감은 실행하지 않습니다.",
  });
}

export function approvalRequestFromClassification(classification) {
  if (classification?.mode !== "approval" || !classification.plan) {
    throw Object.assign(new Error("owner_action_not_approvable"), { statusCode: 400 });
  }
  return {
    kind: OWNER_ACTION_KIND,
    title: classification.title,
    summary: classification.summary,
    payload: JSON.stringify(classification.plan),
    dataCategories: ["owner_action", "telegram_ingress"],
  };
}

export function parseOwnerActionPayload(payload) {
  let parsed;
  try {
    parsed = JSON.parse(String(payload ?? ""));
  } catch {
    throw Object.assign(new Error("invalid_owner_action_payload"), { statusCode: 400 });
  }
  if (!parsed || parsed.schema !== OWNER_ACTION_SCHEMA) {
    throw Object.assign(new Error("invalid_owner_action_schema"), { statusCode: 400 });
  }
  if (!["coupang.search", "owner.prepare_only"].includes(parsed.action)) {
    throw Object.assign(new Error("unsupported_owner_action"), { statusCode: 400 });
  }
  if (parsed.action === "coupang.search") {
    if (typeof parsed.query !== "string" || !parsed.query.trim() || parsed.query.length > 120) {
      throw Object.assign(new Error("invalid_owner_action_query"), { statusCode: 400 });
    }
  }
  return Object.freeze(parsed);
}

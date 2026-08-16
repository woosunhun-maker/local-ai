/**
 * 시킨 실행은 아이폰 앱의 Face ID/암호 한 번 뒤에만 맥이 한다.
 * macOS가 원격 AI에 Face ID를 열어주는 구조가 아니다.
 */
import { doHouseSecurity, isMacDoCommand } from "./room-mac-do.mjs";

export const ROOM_HOUSE_DO_KIND = "room.house-do.v1";

export const FACEID_GATE_REPLY = [
  "그렇게 되어 있습니다.",
  "시킨 실행은 이 아이폰에서 Face ID 또는 암호로 한 번 승인한 뒤에만 맥이 합니다.",
  "macOS Face ID를 원격으로 여는 구조가 아닙니다. 결제·문자·전화는 승인 칸에도 올리지 않습니다.",
].join(" ");

export function isFaceIdGateCommand(text) {
  const value = String(text ?? "");
  if (!value.trim()) return false;
  const face = /face\s*id|페이스\s*아이디|페이스아이디/iu.test(value);
  const once = /1회|일회|한번|한\s*번|승인/iu.test(value);
  return face && once;
}

export function houseDoPayload(text) {
  return JSON.stringify({
    schema: "local-ai.room.house-do.v1",
    action: "house.security",
    text: String(text ?? "").trim().slice(0, 500),
  });
}

export function houseDoRequest(text) {
  return {
    kind: ROOM_HOUSE_DO_KIND,
    title: "집 점검 한 번",
    summary: "방화벽·포트·계정·백업·감시만 맥이 확인하고, 결제·문자·전화는 하지 않습니다.",
    payload: houseDoPayload(text),
    dataCategories: ["house_status"],
  };
}

export function formatFaceIdWait(request) {
  return [
    "아이폰에서 Face ID 또는 암호로 한 번 승인해 주세요.",
    `내용: ${request?.summary ?? "시킨 집 점검"}`,
    "승인되면 그 일만 맥이 실행합니다. 결제·문자·전화·집 밖 전송은 올려두지 않았습니다.",
  ].join("\n");
}

export async function findPendingHouseDo(approvalStore) {
  if (!approvalStore || typeof approvalStore.listPending !== "function") return null;
  const pending = await approvalStore.listPending();
  return pending.find((entry) => entry.kind === ROOM_HOUSE_DO_KIND) ?? null;
}

export function publicRoomApproval(request) {
  if (!request || request.kind !== ROOM_HOUSE_DO_KIND) return null;
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    payloadSha256: request.payloadSha256,
    nonce: request.nonce,
    expiresAt: request.expiresAt,
  };
}

export function lastDoText(messages, fallback = "방화벽·포트·계정·백업·감시 점검") {
  if (!Array.isArray(messages)) return fallback;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item?.role === "user" && isMacDoCommand(item.content)) return item.content;
  }
  return fallback;
}

export async function requestHouseDoApproval(text, { approvalStore, ttlMs = 30 * 60_000 } = {}) {
  const request = houseDoRequest(text);
  if (!approvalStore || typeof approvalStore.createRequest !== "function") {
    return formatFaceIdWait(request);
  }
  const pending = await findPendingHouseDo(approvalStore);
  if (pending) return formatFaceIdWait(pending);
  const created = await approvalStore.createRequest(request, ttlMs);
  return formatFaceIdWait(created);
}

export async function openFaceIdGate(messages, options = {}) {
  const wait = await requestHouseDoApproval(lastDoText(messages), options);
  return `${FACEID_GATE_REPLY}\n\n${wait}`;
}

export async function executeApprovedHouseDo({
  approvalStore,
  approvalId,
  payloadSha256,
  execFileImpl,
} = {}) {
  if (!approvalStore || typeof approvalStore.consumeApproved !== "function") {
    throw Object.assign(new Error("house_do_approval_missing"), { statusCode: 500 });
  }
  const consumed = await approvalStore.consumeApproved(approvalId, payloadSha256);
  if (!consumed || consumed.kind !== ROOM_HOUSE_DO_KIND) {
    throw Object.assign(new Error("house_do_approval_invalid"), { statusCode: 403 });
  }
  return doHouseSecurity({ execFileImpl });
}

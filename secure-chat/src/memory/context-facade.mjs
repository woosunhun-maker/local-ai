/**
 * Memory Context Facade
 *
 * User Memory = 기존 ConfirmedMemoryStore (대체·이중화 금지)
 * Project Context = 운영 상태 (자동 갱신, 확인 불필요)
 * Decision Memory = 별도 파일 + propose→confirm
 * Active Discussion = TTL 임시 맥락 (사용자 사실로 주입하지 않음)
 */
import {
  LIVE_CAPABILITIES,
  collectProjectProgress,
} from "../project-progress.mjs";
import {
  LOCAL_CONVERSATION_MODEL,
  LOCAL_EFFECT_PLANNING_MODEL,
} from "../local-model-routing.mjs";

export const MEMORY_LAYER_SCHEMA = "local-ai.memory-context.v1";

export function buildProjectContext({
  progress = collectProjectProgress(),
  conversationModel = LOCAL_CONVERSATION_MODEL,
  plannerModel = LOCAL_EFFECT_PLANNING_MODEL,
  liveCapabilities = LIVE_CAPABILITIES,
  constraints = [
    "Telegram은 도구/제어/개인정보 금지",
    "확인형 사용자 기억만 사실로 주입",
    "결제·민감은 human_only",
    "Cursor는 코딩 도구이며 일상 대화 채널이 아님",
  ],
} = {}) {
  return Object.freeze({
    layer: "project",
    persistence: "operational_ephemeral",
    confirmation_required: false,
    chat_injection: "never_as_user_fact",
    conversation_model: conversationModel,
    planner_model: plannerModel,
    progress: Object.freeze({
      overall_percent: progress.overall.percent,
      tests_percent: progress.tests.percent,
      operations_percent: progress.operations.percent,
    }),
    constraints: Object.freeze([...constraints]),
    live_capabilities: Object.freeze([...liveCapabilities]),
  });
}

/**
 * @param {{
 *   confirmedMemory: import("../confirmed-memory-store.mjs").ConfirmedMemoryStore,
 *   decisionStore: import("./decision-memory-store.mjs").DecisionMemoryStore,
 *   discussionStore: import("./discussion-context-store.mjs").DiscussionContextStore,
 * }} deps
 */
export function createMemoryContextFacade({
  confirmedMemory,
  decisionStore,
  discussionStore,
  projectContextProvider = buildProjectContext,
} = {}) {
  if (!confirmedMemory || typeof confirmedMemory.activeContextBlock !== "function") {
    throw new Error("confirmed_memory_required");
  }
  if (!decisionStore || typeof decisionStore.listActive !== "function") {
    throw new Error("decision_store_required");
  }
  if (!discussionStore || typeof discussionStore.listOpen !== "function") {
    throw new Error("discussion_store_required");
  }

  return Object.freeze({
    /** 채팅 주입은 기존 확인형 사용자 기억만 — 동작 불변 */
    async chatUserMemoryBlock(query = "", options = {}) {
      return confirmedMemory.activeContextBlock(query, options);
    },

    async snapshot({ query = "" } = {}) {
      const [activeUser, candidateUser, decisions, decisionCandidates, discussions] = await Promise.all([
        confirmedMemory.listActive(),
        confirmedMemory.listCandidates(),
        decisionStore.listActive(),
        decisionStore.listCandidates(),
        discussionStore.listOpen(),
      ]);
      const selectedUser = await confirmedMemory.selectForPrompt(query, { limit: 6 });

      return Object.freeze({
        schema: MEMORY_LAYER_SCHEMA,
        layers: Object.freeze({
          user_memory: Object.freeze({
            layer: "user",
            store: "ConfirmedMemoryStore",
            path_role: "confirmed-memory/memory.json",
            persistence: "durable_after_confirm",
            confirmation_required: true,
            chat_injection: "on_demand_active_only",
            active_count: activeUser.length,
            candidate_count: candidateUser.length,
            selected_for_query: Object.freeze(selectedUser.map((item) => Object.freeze({
              id: item.id,
              text: item.text,
              status: item.status,
            }))),
          }),
          project_context: projectContextProvider(),
          decision_memory: Object.freeze({
            layer: "decision",
            store: "DecisionMemoryStore",
            persistence: "durable_after_confirm",
            confirmation_required: true,
            chat_injection: "owner_context_api_only",
            active: decisions,
            candidates: decisionCandidates,
          }),
          active_discussion: Object.freeze({
            layer: "discussion",
            store: "DiscussionContextStore",
            persistence: "ttl_soft",
            confirmation_required: false,
            auto_promote_to_user_memory: false,
            chat_injection: "never_as_user_fact",
            open: discussions,
          }),
        }),
        invariants: Object.freeze([
          "user_memory는 ConfirmedMemoryStore 단일 소스다",
          "decision/discussion은 confirmed-memory 파일을 쓰지 않는다",
          "project_context는 자동 운영 상태이며 사용자 사실로 위장하지 않는다",
        ]),
      });
    },
  });
}

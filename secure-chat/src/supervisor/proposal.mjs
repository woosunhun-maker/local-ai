/**
 * Development Proposal — Cursor 실행 전에 고정한다.
 * success_criteria / out_of_scope는 digest에 포함되며 실행 후 변경 불가.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.mjs";

export const PROPOSAL_SCHEMA = "local-ai.development-proposal.v1";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function boundedList(value, field, { maxItems = 20, maxLen = 500 } = {}) {
  if (!Array.isArray(value)) fail(`invalid_proposal_${field}`);
  if (value.length > maxItems) fail(`invalid_proposal_${field}_count`);
  return Object.freeze(value.map((item, index) => {
    if (typeof item === "string") {
      const text = item.trim();
      if (text.length < 1 || text.length > maxLen) fail(`invalid_proposal_${field}_${index}`);
      return text;
    }
    if (item && typeof item === "object" && typeof item.type === "string") {
      return Object.freeze({ ...item });
    }
    fail(`invalid_proposal_${field}_${index}`);
  }));
}

/**
 * @param {{
 *   goal: string,
 *   findings?: string[],
 *   proposed_tasks?: Array<{ title: string, prompt: string, tool_name?: string, test_command?: string|null }>,
 *   risk_class?: string,
 *   success_criteria: Array<string|object>,
 *   out_of_scope: Array<string|object>,
 *   allowed_paths?: string[],
 *   allowed_commands?: string[],
 *   requires_direction_decision?: boolean,
 * }} input
 */
export function createDevelopmentProposal(input = {}) {
  if (typeof input.goal !== "string" || input.goal.trim().length < 8) fail("invalid_proposal_goal");
  const successCriteria = boundedList(input.success_criteria, "success_criteria");
  const outOfScope = boundedList(input.out_of_scope, "out_of_scope");
  if (successCriteria.length < 1) fail("proposal_success_criteria_required");

  const proposedTasks = Array.isArray(input.proposed_tasks)
    ? Object.freeze(input.proposed_tasks.map((task, index) => {
      if (!task || typeof task.title !== "string" || typeof task.prompt !== "string") {
        fail(`invalid_proposal_task_${index}`);
      }
      const title = task.title.trim().slice(0, 200);
      const prompt = task.prompt.trim().slice(0, 4_000);
      if (title.length < 1 || prompt.length < 8) fail(`invalid_proposal_task_${index}`);
      return Object.freeze({
        title,
        prompt,
        tool_name: task.tool_name ?? "cursor.develop",
        test_command: typeof task.test_command === "string" ? task.test_command.trim() : null,
      });
    }))
    : Object.freeze([]);

  const proposal = Object.freeze({
    schema: PROPOSAL_SCHEMA,
    goal: input.goal.trim().slice(0, 2_000),
    findings: boundedList(input.findings ?? [], "findings", { maxItems: 30 }),
    proposed_tasks: proposedTasks,
    risk_class: ["LOW", "MEDIUM", "HIGH"].includes(input.risk_class) ? input.risk_class : "HIGH",
    success_criteria: successCriteria,
    out_of_scope: outOfScope,
    allowed_paths: boundedList(input.allowed_paths ?? ["secure-chat/"], "allowed_paths", { maxItems: 50, maxLen: 300 }),
    allowed_commands: boundedList(
      input.allowed_commands ?? ["npm test", "npm run lint", "git status", "git diff"],
      "allowed_commands",
      { maxItems: 30, maxLen: 200 },
    ),
    requires_direction_decision: input.requires_direction_decision === true,
    frozen_at: new Date().toISOString(),
  });

  const digest = createHash("sha256").update(canonicalJson({
    schema: proposal.schema,
    goal: proposal.goal,
    findings: proposal.findings,
    proposed_tasks: proposal.proposed_tasks,
    risk_class: proposal.risk_class,
    success_criteria: proposal.success_criteria,
    out_of_scope: proposal.out_of_scope,
    allowed_paths: proposal.allowed_paths,
    allowed_commands: proposal.allowed_commands,
    requires_direction_decision: proposal.requires_direction_decision,
  })).digest("hex");

  return Object.freeze({ ...proposal, proposal_digest: digest });
}

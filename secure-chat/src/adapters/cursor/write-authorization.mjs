/**
 * Write 승인 판정 — ACP WRITE 이벤트에 의존하지 않는다.
 *
 * PASS (write_authorization_verified):
 *  1) 명시적 ACP WRITE/EXECUTE→WRITE 승인이 관측됐거나
 *  2) 변경이 immutable Development Envelope의 isolated worktree + allowed_paths
 *     안임을 host가 독립 검증 (envelope_authorized_write)
 *
 * Envelope 밖(worktree 밖, scope 증가, destructive, main 수정 등)은
 * 별도 Approval Manager 재승인 대상이며 여기서 자동 허용하지 않는다.
 */
import path from "node:path";
import { verifyEnvelopeIntegrity, isEnvelopeExpired } from "../../supervisor/approval-envelope.mjs";
import { isPathInsideRoot } from "./sandbox.mjs";

function pathAllowedByPrefixes(relativePath, prefixes = []) {
  if (!Array.isArray(prefixes) || prefixes.length < 1) return false;
  return prefixes.some((prefix) => {
    const normalized = String(prefix).replace(/\/?$/u, "/");
    return relativePath === String(prefix).replace(/\/$/u, "")
      || relativePath.startsWith(normalized)
      || relativePath.startsWith(String(prefix));
  });
}

function touchesProhibited(relativePath, outOfScope = []) {
  const patterns = (outOfScope ?? [])
    .map((item) => (typeof item === "string" ? item : item?.path))
    .filter(Boolean);
  return patterns.some((pattern) => relativePath.includes(pattern));
}

/**
 * @returns {Readonly<{
 *   write_authorization_verified: boolean,
 *   kind: "no_content_changes"|"acp_write_observed"|"envelope_authorized_write"|"unauthorized"|"out_of_envelope",
 *   reason: string,
 *   acp_write_observed: boolean,
 *   envelope_authorized_write: boolean,
 * }>}
 */
export function evaluateWriteAuthorization({
  hasContentChanges = false,
  changedFiles = [],
  blockedFiles = [],
  mainRepoWrites = [],
  writeRoots = null,
  mainRepo = null,
  mainReadOnly = false,
  envelope = null,
  permissionEvents = [],
  nowMs = Date.now(),
} = {}) {
  const acpWriteObserved = (permissionEvents ?? []).some(
    (event) =>
      (event?.risk === "WRITE" && (event?.optionId === "allow-once" || event?.decision === "approved"))
      || (event?.escalated_from === "EXECUTE" && event?.risk === "WRITE"
        && (event?.optionId === "allow-once" || event?.decision === "approved")),
  );

  if (!hasContentChanges) {
    return Object.freeze({
      write_authorization_verified: true,
      kind: "no_content_changes",
      reason: "no_content_changes",
      acp_write_observed: acpWriteObserved,
      envelope_authorized_write: false,
    });
  }

  if (acpWriteObserved) {
    // ACP WRITE가 있어도 host 범위 검증은 유지 — 밖이면 out_of_envelope
    const scope = evaluateEnvelopeScope({
      changedFiles,
      blockedFiles,
      mainRepoWrites,
      writeRoots,
      mainRepo,
      mainReadOnly,
      envelope,
      nowMs,
    });
    if (!scope.ok) {
      return Object.freeze({
        write_authorization_verified: false,
        kind: "out_of_envelope",
        reason: scope.reason,
        acp_write_observed: true,
        envelope_authorized_write: false,
      });
    }
    return Object.freeze({
      write_authorization_verified: true,
      kind: "acp_write_observed",
      reason: "acp_write_permission_observed",
      acp_write_observed: true,
      envelope_authorized_write: false,
    });
  }

  const scope = evaluateEnvelopeScope({
    changedFiles,
    blockedFiles,
    mainRepoWrites,
    writeRoots,
    mainRepo,
    mainReadOnly,
    envelope,
    nowMs,
  });

  if (scope.ok) {
    return Object.freeze({
      write_authorization_verified: true,
      kind: "envelope_authorized_write",
      reason: "envelope_authorized_write",
      acp_write_observed: false,
      envelope_authorized_write: true,
    });
  }

  return Object.freeze({
    write_authorization_verified: false,
    kind: scope.reason === "envelope_missing" || scope.reason === "envelope_digest_mismatch"
      ? "unauthorized"
      : "out_of_envelope",
    reason: scope.reason,
    acp_write_observed: false,
    envelope_authorized_write: false,
  });
}

function evaluateEnvelopeScope({
  changedFiles,
  blockedFiles,
  mainRepoWrites,
  writeRoots,
  mainRepo,
  mainReadOnly,
  envelope,
  nowMs,
}) {
  if ((blockedFiles?.length ?? 0) > 0) {
    return Object.freeze({ ok: false, reason: "sandbox_blocked_paths" });
  }
  if ((mainRepoWrites?.length ?? 0) > 0) {
    return Object.freeze({ ok: false, reason: "main_repo_modified" });
  }
  if (!envelope) {
    return Object.freeze({ ok: false, reason: "envelope_missing" });
  }
  const integrity = verifyEnvelopeIntegrity(envelope);
  if (!integrity.ok) {
    return Object.freeze({ ok: false, reason: integrity.reason });
  }
  if (isEnvelopeExpired(envelope, nowMs)) {
    return Object.freeze({ ok: false, reason: "envelope_expired" });
  }
  if (envelope.no_merge !== true || envelope.no_push !== true || envelope.no_deploy !== true) {
    return Object.freeze({ ok: false, reason: "envelope_safety_flags_invalid" });
  }
  if (envelope.auto_commit === true) {
    return Object.freeze({ ok: false, reason: "envelope_auto_commit_forbidden" });
  }

  const roots = Array.isArray(writeRoots) && writeRoots.length > 0
    ? writeRoots.map((root) => path.resolve(root))
    : (envelope.worktree_path ? [path.resolve(envelope.worktree_path)] : []);
  if (roots.length < 1) {
    return Object.freeze({ ok: false, reason: "write_roots_missing" });
  }

  // worktree path must match envelope
  if (envelope.worktree_path) {
    const expected = path.resolve(envelope.worktree_path);
    if (!roots.some((root) => root === expected)) {
      return Object.freeze({ ok: false, reason: "worktree_mismatch" });
    }
  }

  for (const file of changedFiles ?? []) {
    if (touchesProhibited(file, envelope.out_of_scope)) {
      return Object.freeze({ ok: false, reason: "out_of_scope_touched" });
    }
    if (!pathAllowedByPrefixes(file, envelope.allowed_paths ?? [])) {
      return Object.freeze({ ok: false, reason: "outside_allowed_paths" });
    }
    // absolute resolution against each write root — relative paths must stay inside
    const escapes = roots.every((root) => {
      const absolute = path.resolve(root, file);
      return !isPathInsideRoot(absolute, root);
    });
    if (escapes) {
      return Object.freeze({ ok: false, reason: "outside_write_roots" });
    }
  }

  if (mainReadOnly && mainRepo) {
    const main = path.resolve(mainRepo);
    for (const root of roots) {
      if (root === main || isPathInsideRoot(root, main) && root === main) {
        return Object.freeze({ ok: false, reason: "main_used_as_write_root" });
      }
    }
  }

  return Object.freeze({ ok: true, reason: "within_envelope" });
}

export { pathAllowedByPrefixes };

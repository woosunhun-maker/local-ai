import CryptoKit
import XCTest
@testable import LocalAI

final class CodexTaskTests: XCTestCase {
    private let taskID = "123e4567-e89b-12d3-a456-426614174000"
    private let ownerHash = String(repeating: "b", count: 64)
    private let sourceManifestHash = String(repeating: "c", count: 64)
    private let idempotencyKey = "codex_attempt_1234567890"
    private let createdAt = "2026-08-08T10:00:00.123Z"
    private let expiresAt = "2026-08-08T10:05:00.123Z"

    func testPinnedExecutionContractMatchesServerV3() {
        XCTAssertEqual(CodexContract.planSchema, "local-ai.codex-task-plan.v3")
        XCTAssertEqual(CodexContract.executionMode, "isolated_inspect_and_draft")
        XCTAssertEqual(CodexContract.codexVersion, "codex-cli 0.147.0-alpha.1.2")
        XCTAssertEqual(CodexContract.model, "gpt-5.6-sol")
        XCTAssertEqual(CodexContract.reasoningEffort, "high")
        XCTAssertEqual(CodexContract.provider, "openai_codex")
        XCTAssertEqual(CodexContract.transferredData, ["task_instruction", "known_identifier_scrubbed_code_snapshot"])
        XCTAssertEqual(CodexContract.approvalDataCategories, ["known_identifier_scrubbed_code_snapshot", "task_instruction"])
        XCTAssertEqual(CodexContract.sourcePolicy, "allowlisted_known_identifier_scrubbed_code_v2")
        XCTAssertEqual(CodexContract.ownerSourcePermission, "read_only")
        XCTAssertEqual(CodexContract.draftValidation, "trusted_apply_isolated_copy_only")
        XCTAssertEqual(CodexContract.clientAuthentication, "codex_auth_used")
        XCTAssertEqual(CodexContract.maximumSourceFileCount, 4_096)
        XCTAssertEqual(CodexContract.maximumSourceTotalBytes, 2_097_152)
    }

    func testValidatesExactCodexPlanIncludingFractionalDates() throws {
        let payload = canonicalPayload()
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let expectation = try CodexTaskPlanExpectation(
            intent: .inspect,
            request: "승인 경로 점검",
            idempotencyKey: idempotencyKey
        )

        let plan = try approval.validatedCodexPlan(
            for: task,
            expected: expectation,
            now: try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))
        )

        XCTAssertEqual(plan.taskId, taskID)
        XCTAssertEqual(plan.ownerDeviceHash, ownerHash)
        XCTAssertEqual(plan.sourceManifestSha256, sourceManifestHash)
        XCTAssertEqual(plan.sourceFileCount, 12)
        XCTAssertEqual(plan.sourceTotalBytes, 1_024)
        XCTAssertEqual(plan.execution.codexVersion, CodexContract.codexVersion)
        XCTAssertEqual(plan.execution.model, CodexContract.model)
        XCTAssertEqual(plan.execution.provider, "openai_codex")
        XCTAssertTrue(plan.execution.externalTransfer)
        XCTAssertEqual(plan.execution.transferredData, ["task_instruction", "known_identifier_scrubbed_code_snapshot"])
        XCTAssertFalse(plan.execution.toolNetwork)
        XCTAssertFalse(plan.execution.modelHostFileTools)
        XCTAssertFalse(plan.execution.osProcessSandbox)
        XCTAssertEqual(plan.execution.clientAuthentication, "codex_auth_used")
        XCTAssertEqual(plan.execution.ownerSourcePermission, "read_only")
        XCTAssertEqual(plan.execution.draftValidation, "trusted_apply_isolated_copy_only")
        XCTAssertFalse(plan.execution.sourceApply)
    }

    func testRejectsPlanWhenExpectedRequestOrIdempotencyKeyChanged() throws {
        let payload = canonicalPayload()
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let editedRequest = try CodexTaskPlanExpectation(
            intent: .inspect,
            request: "다른 요청",
            idempotencyKey: idempotencyKey
        )
        let changedKey = try CodexTaskPlanExpectation(
            intent: .inspect,
            request: "승인 경로 점검",
            idempotencyKey: "codex_attempt_0987654321"
        )
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, expected: editedRequest, now: now))
        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, expected: changedKey, now: now))
    }

    func testRejectsUnknownPlanFieldEvenWhenDigestMatches() throws {
        let payload = canonicalPayload(extraRootField: ",\"unexpected\":true")
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: now))
    }

    func testRejectsNoncanonicalPlanSerializationEvenWhenDigestMatches() throws {
        let payload = canonicalPayload()
            .replacingOccurrences(of: #"{"schema""#, with: #"{ "schema""#)
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: now))
    }

    func testCanonicalPlanAcceptsJSONStringEscapesUsedByServer() throws {
        let payload = canonicalPayload(requestJSON: #"줄1\n\"인용\"\\경로"#)
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let expectation = try CodexTaskPlanExpectation(
            intent: .inspect,
            request: "줄1\n\"인용\"\\경로",
            idempotencyKey: idempotencyKey
        )
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertNoThrow(try approval.validatedCodexPlan(for: task, expected: expectation, now: now))
    }

    func testRejectsChangedExecutionContractEvenWhenDigestMatches() throws {
        let payload = canonicalPayload(model: "unapproved-model")
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: now))
    }

    func testRejectsExternalTransferContractDriftEvenWhenDigestMatches() throws {
        let payload = canonicalPayload()
            .replacingOccurrences(of: "\"externalTransfer\":true", with: "\"externalTransfer\":false")
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: now))
    }

    func testRejectsClientAuthenticationContractDriftEvenWhenDigestMatches() throws {
        let payload = canonicalPayload()
            .replacingOccurrences(of: "\"clientAuthentication\":\"codex_auth_used\"", with: "\"clientAuthentication\":\"unapproved_auth\"")
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: now))
    }

    func testRejectsMalformedSourceManifestDigestEvenWhenPayloadDigestMatches() throws {
        let payload = canonicalPayload(sourceManifestHash: "not-a-sha256")
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: now))
    }

    func testRejectsOutOfRangeSourceSnapshotSizeEvenWhenPayloadDigestMatches() throws {
        let tooManyFiles = canonicalPayload(sourceFileCount: 4_097)
        let tooManyBytes = canonicalPayload(sourceTotalBytes: 2_097_153)
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try pendingApproval(payload: tooManyFiles).validatedCodexPlan(
            for: awaitingTask(payload: tooManyFiles),
            now: now
        ))
        XCTAssertThrowsError(try pendingApproval(payload: tooManyBytes).validatedCodexPlan(
            for: awaitingTask(payload: tooManyBytes),
            now: now
        ))
    }

    func testRejectsUnexpectedApprovalDataCategory() throws {
        let payload = canonicalPayload()
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload, dataCategories: ["private_documents", "task_instruction"])
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: now))
    }

    func testCreationAttemptReusesKeyOnlyForSameLogicalRequest() throws {
        let first = try CodexTaskCreationAttempt.prepare(
            reusing: nil,
            intent: .inspect,
            request: "  승인 경로 점검  "
        )
        let retry = try CodexTaskCreationAttempt.prepare(
            reusing: first,
            intent: .inspect,
            request: "승인 경로 점검"
        )
        let edited = try CodexTaskCreationAttempt.prepare(
            reusing: retry,
            intent: .inspect,
            request: "승인 경로 재점검"
        )
        let differentIntent = try CodexTaskCreationAttempt.prepare(
            reusing: retry,
            intent: .draft,
            request: "승인 경로 점검"
        )

        XCTAssertEqual(first.expectation.idempotencyKey, retry.expectation.idempotencyKey)
        XCTAssertNotEqual(retry.expectation.idempotencyKey, edited.expectation.idempotencyKey)
        XCTAssertNotEqual(retry.expectation.idempotencyKey, differentIntent.expectation.idempotencyKey)
    }

    func testCreateResponseRequiresApprovalOnlyWhileAwaitingApproval() throws {
        let payload = canonicalPayload()
        let awaiting = awaitingTask(payload: payload)
        let queued = CodexTask(
            id: taskID,
            status: .queued,
            intent: .inspect,
            planSha256: sha256(payload),
            approvalRequestId: taskID,
            createdAt: createdAt,
            updatedAt: createdAt,
            startedAt: nil,
            finishedAt: nil,
            result: nil
        )
        let approval = pendingApproval(payload: payload)
        let expectation = try CodexTaskPlanExpectation(
            intent: .inspect,
            request: "승인 경로 점검",
            idempotencyKey: idempotencyKey
        )
        let now = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:01:00.123Z"))

        XCTAssertNoThrow(try CodexTaskCreateResponse(task: awaiting, approval: approval).validated(
            expected: expectation,
            now: now
        ))
        XCTAssertThrowsError(try CodexTaskCreateResponse(task: awaiting, approval: nil).validated(
            expected: expectation,
            now: now
        ))
        XCTAssertNoThrow(try CodexTaskCreateResponse(task: queued, approval: nil).validated(
            expected: expectation,
            now: now
        ))
        XCTAssertThrowsError(try CodexTaskCreateResponse(task: queued, approval: approval).validated(
            expected: expectation,
            now: now
        ))
    }

    func testTaskStateAndResultInvariants() throws {
        let payload = canonicalPayload()
        let digest = sha256(payload)
        let invalidQueued = CodexTask(
            id: taskID,
            status: .queued,
            intent: .inspect,
            planSha256: digest,
            approvalRequestId: taskID,
            createdAt: createdAt,
            updatedAt: createdAt,
            startedAt: createdAt,
            finishedAt: nil,
            result: nil
        )
        let invalidInspectResult = CodexTask(
            id: taskID,
            status: .succeeded,
            intent: .inspect,
            planSha256: digest,
            approvalRequestId: taskID,
            createdAt: createdAt,
            updatedAt: expiresAt,
            startedAt: "2026-08-08T10:01:00.123Z",
            finishedAt: "2026-08-08T10:04:00.123Z",
            result: CodexTaskResult(
                code: "ok",
                summary: "완료",
                changedFileCount: 1,
                changedPaths: ["src/a.mjs"],
                patch: nil,
                patchSha256: nil
            )
        )
        let patch = validDraftPatch()
        let validDraftResult = CodexTask(
            id: taskID,
            status: .succeeded,
            intent: .draft,
            planSha256: digest,
            approvalRequestId: taskID,
            createdAt: createdAt,
            updatedAt: expiresAt,
            startedAt: "2026-08-08T10:01:00.123Z",
            finishedAt: "2026-08-08T10:04:00.123Z",
            result: CodexTaskResult(
                code: "ok",
                summary: "격리 초안 완료",
                changedFileCount: 1,
                changedPaths: ["src/a.mjs"],
                patch: patch,
                patchSha256: sha256(patch)
            )
        )

        XCTAssertThrowsError(try invalidQueued.validated())
        XCTAssertThrowsError(try invalidInspectResult.validated())
        XCTAssertNoThrow(try validDraftResult.validated())
    }

    func testDraftResultRejectsPatchHashAndPathDrift() throws {
        let patch = validDraftPatch()
        let valid = CodexTaskResult(
            code: "codex_task_succeeded",
            summary: "격리 초안 완료",
            changedFileCount: 1,
            changedPaths: ["src/a.mjs"],
            patch: patch,
            patchSha256: sha256(patch)
        )
        let badHash = CodexTaskResult(
            code: valid.code,
            summary: valid.summary,
            changedFileCount: 1,
            changedPaths: valid.changedPaths,
            patch: patch,
            patchSha256: String(repeating: "0", count: 64)
        )
        let mismatchedPath = CodexTaskResult(
            code: valid.code,
            summary: valid.summary,
            changedFileCount: 1,
            changedPaths: ["src/b.mjs"],
            patch: patch,
            patchSha256: sha256(patch)
        )

        XCTAssertNoThrow(try valid.validated(intent: .draft, status: .succeeded))
        XCTAssertThrowsError(try badHash.validated(intent: .draft, status: .succeeded))
        XCTAssertThrowsError(try mismatchedPath.validated(intent: .draft, status: .succeeded))
    }

    func testChangedPathAllowlistMirrorsServerPolicy() {
        for path in [
            "README.md", "package.json", "src/a.mjs", "ios/LocalAI/App.swift",
            "public/assets/app.js", "scripts/worker.zsh", "test/codex.test.mjs",
            "scripts/Dockerfile",
        ] {
            XCTAssertTrue(CodexContract.isAllowedChangedPath(path), path)
        }
        for path in [
            "docs/a.mjs", "src/../package.json", "src/secret.md", "src/node_modules/a.js",
            "/src/a.mjs", #"src\a.mjs"#, "src/.env", "src/a.png", "ios/AGENTS.md",
        ] {
            XCTAssertFalse(CodexContract.isAllowedChangedPath(path), path)
        }
    }

    func testDraftResultRejectsMalformedOrOversizedPatch() {
        let incomplete = "diff --git a/src/a.mjs b/src/a.mjs\n"
        let wrongHunkCount = validDraftPatch().replacingOccurrences(of: "@@ -1 +1 @@", with: "@@ -1,2 +1 @@")
        let addedLines = String(repeating: "+01234567890123456789\n", count: 1_600)
        let oversized = "diff --git a/src/a.mjs b/src/a.mjs\n" +
            "new file mode 100644\n" +
            "index 0000000..2222222\n" +
            "--- /dev/null\n" +
            "+++ b/src/a.mjs\n" +
            "@@ -0,0 +1,1600 @@\n" + addedLines

        for patch in [incomplete, wrongHunkCount, oversized] {
            let result = CodexTaskResult(
                code: "codex_task_succeeded",
                summary: "격리 초안 완료",
                changedFileCount: 1,
                changedPaths: ["src/a.mjs"],
                patch: patch,
                patchSha256: sha256(patch)
            )
            XCTAssertThrowsError(try result.validated(intent: .draft, status: .succeeded))
        }
    }

    func testDraftNoChangeAndInspectResultsRequireEmptyPatchFields() throws {
        let noChange = CodexTaskResult(
            code: "codex_task_succeeded",
            summary: "변경 없음",
            changedFileCount: 0,
            changedPaths: [],
            patch: nil,
            patchSha256: nil
        )
        let invalidInspect = CodexTaskResult(
            code: "codex_task_succeeded",
            summary: "점검 완료",
            changedFileCount: 0,
            changedPaths: [],
            patch: "",
            patchSha256: sha256("")
        )

        XCTAssertNoThrow(try noChange.validated(intent: .draft, status: .succeeded))
        XCTAssertNoThrow(try noChange.validated(intent: .inspect, status: .succeeded))
        XCTAssertThrowsError(try invalidInspect.validated(intent: .inspect, status: .succeeded))
    }

    func testResultDecoderRequiresExactOwnerResultKeys() throws {
        let validJSON = #"{"code":"ok","summary":"완료","changedFileCount":0,"changedPaths":[],"patch":null,"patchSha256":null}"#
        let unknownJSON = #"{"code":"ok","summary":"완료","changedFileCount":0,"changedPaths":[],"patch":null,"patchSha256":null,"unexpected":true}"#
        let missingJSON = #"{"code":"ok","summary":"완료","changedFileCount":0,"changedPaths":[],"patch":null}"#

        XCTAssertNoThrow(try JSONDecoder().decode(CodexTaskResult.self, from: Data(validJSON.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(CodexTaskResult.self, from: Data(unknownJSON.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(CodexTaskResult.self, from: Data(missingJSON.utf8)))
    }

    func testRejectsExpiredApproval() throws {
        let payload = canonicalPayload()
        let task = awaitingTask(payload: payload)
        let approval = pendingApproval(payload: payload)
        let afterExpiry = try XCTUnwrap(CodexContract.date(from: "2026-08-08T10:06:00.123Z"))

        XCTAssertThrowsError(try approval.validatedCodexPlan(for: task, now: afterExpiry))
    }

    private func awaitingTask(payload: String) -> CodexTask {
        CodexTask(
            id: taskID,
            status: .awaitingApproval,
            intent: .inspect,
            planSha256: sha256(payload),
            approvalRequestId: taskID,
            createdAt: createdAt,
            updatedAt: createdAt,
            startedAt: nil,
            finishedAt: nil,
            result: nil
        )
    }

    private func pendingApproval(
        payload: String,
        dataCategories: [String] = ["known_identifier_scrubbed_code_snapshot", "task_instruction"]
    ) -> PendingApproval {
        PendingApproval(
            id: taskID,
            kind: "codex.execute",
            title: "Codex 작업 실행",
            summary: "승인된 격리 작업",
            payload: payload,
            payloadSha256: sha256(payload),
            dataCategories: dataCategories,
            nonce: "nonce_1234567890_1234567890_1234567890",
            createdAt: createdAt,
            expiresAt: expiresAt,
            status: "pending"
        )
    }

    private func canonicalPayload(
        model: String = CodexContract.model,
        sourceManifestHash: String? = nil,
        sourceFileCount: Int = 12,
        sourceTotalBytes: Int = 1_024,
        requestJSON: String = "승인 경로 점검",
        extraRootField: String = ""
    ) -> String {
        let manifestHash = sourceManifestHash ?? self.sourceManifestHash
        return """
        {"schema":"\(CodexContract.planSchema)","taskId":"\(taskID)","ownerDeviceHash":"\(ownerHash)","idempotencyKey":"\(idempotencyKey)","intent":"inspect","request":"\(requestJSON)","sourceManifestSha256":"\(manifestHash)","sourceFileCount":\(sourceFileCount),"sourceTotalBytes":\(sourceTotalBytes),"execution":{"mode":"\(CodexContract.executionMode)","codexVersion":"\(CodexContract.codexVersion)","model":"\(model)","reasoningEffort":"\(CodexContract.reasoningEffort)","provider":"\(CodexContract.provider)","externalTransfer":true,"transferredData":["task_instruction","known_identifier_scrubbed_code_snapshot"],"sourcePolicy":"\(CodexContract.sourcePolicy)","ownerSourcePermission":"\(CodexContract.ownerSourcePermission)","draftValidation":"\(CodexContract.draftValidation)","toolNetwork":false,"modelHostFileTools":false,"osProcessSandbox":false,"clientAuthentication":"\(CodexContract.clientAuthentication)","sourceApply":false}\(extraRootField)}
        """
    }

    private func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func validDraftPatch() -> String {
        "diff --git a/src/a.mjs b/src/a.mjs\n" +
            "index 1111111..2222222 100644\n" +
            "--- a/src/a.mjs\n" +
            "+++ b/src/a.mjs\n" +
            "@@ -1 +1 @@\n" +
            "-export const value = 1;\n" +
            "+export const value = 2;\n"
    }
}

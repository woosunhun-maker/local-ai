import XCTest
@testable import LocalAI

final class ApprovalChallengeTests: XCTestCase {
    func testSigningPayloadBindsEveryDecisionField() {
        let challenge = ApprovalChallenge(
            id: "approval-1",
            payloadSha256: String(repeating: "a", count: 64),
            nonce: "nonce-1",
            expiresAt: "2026-08-05T10:00:00.000Z"
        )

        XCTAssertEqual(
            String(decoding: challenge.signingPayload(decision: .approved), as: UTF8.self),
            "localai-approval-v1\napproval-1\n\(String(repeating: "a", count: 64))\nnonce-1\n2026-08-05T10:00:00.000Z\napproved"
        )
        XCTAssertNotEqual(
            challenge.signingPayload(decision: .approved),
            challenge.signingPayload(decision: .rejected)
        )
    }

    func testVerifiesExactCanonicalPayloadUTF8Digest() {
        let payload = "{\"question\":\"기술 질문만\"}"
        let valid = PendingApproval(
            id: "approval-valid-0001",
            kind: "gpt.consult",
            title: "외부 자문",
            summary: "테스트",
            payload: payload,
            payloadSha256: "5bf301f75290d8576fdfa9ecfa45250217481def002d181a8acf7e6f0c69b89b",
            dataCategories: [],
            nonce: "nonce",
            createdAt: "2026-08-05T10:00:00.000Z",
            expiresAt: "2026-08-05T10:05:00.000Z",
            status: "pending"
        )
        let changed = PendingApproval(
            id: valid.id,
            kind: valid.kind,
            title: valid.title,
            summary: valid.summary,
            payload: payload + " ",
            payloadSha256: valid.payloadSha256,
            dataCategories: valid.dataCategories,
            nonce: valid.nonce,
            createdAt: valid.createdAt,
            expiresAt: valid.expiresAt,
            status: valid.status
        )

        XCTAssertTrue(valid.payloadHashMatches)
        XCTAssertFalse(changed.payloadHashMatches)
    }

    func testClientRefusesMismatchedPayloadBeforeSigning() async {
        let request = PendingApproval(
            id: "approval-invalid-0001",
            kind: "gpt.consult",
            title: "외부 자문",
            summary: "테스트",
            payload: "changed payload",
            payloadSha256: String(repeating: "0", count: 64),
            dataCategories: [],
            nonce: "nonce",
            createdAt: "2026-08-05T10:00:00.000Z",
            expiresAt: "2026-08-05T10:05:00.000Z",
            status: "pending"
        )

        do {
            try await LocalAIClient.shared.decide(request, decision: .approved)
            XCTFail("Hash mismatch must be rejected before signing or networking")
        } catch LocalAIError.payloadIntegrityMismatch {
            // Expected privacy boundary.
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }
}

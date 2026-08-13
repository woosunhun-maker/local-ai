import CryptoKit
import Foundation

enum ApprovalDecision: String, Codable, Sendable {
    case approved
    case rejected
}

struct ApprovalChallenge: Codable, Identifiable, Sendable {
    let id: String
    let payloadSha256: String
    let nonce: String
    let expiresAt: String

    func signingPayload(decision: ApprovalDecision) -> Data {
        Data(
            "localai-approval-v1\n\(id)\n\(payloadSha256)\n\(nonce)\n\(expiresAt)\n\(decision.rawValue)"
                .utf8
        )
    }
}

struct PendingApproval: Codable, Identifiable, Sendable {
    let id: String
    let kind: String
    let title: String
    let summary: String
    let payload: String
    let payloadSha256: String
    let dataCategories: [String]
    let nonce: String
    let createdAt: String
    let expiresAt: String
    let status: String

    var computedPayloadSha256: String {
        SHA256.hash(data: Data(payload.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    var payloadHashMatches: Bool {
        computedPayloadSha256 == payloadSha256.lowercased()
    }

    var challenge: ApprovalChallenge {
        ApprovalChallenge(
            id: id,
            payloadSha256: payloadSha256,
            nonce: nonce,
            expiresAt: expiresAt
        )
    }
}

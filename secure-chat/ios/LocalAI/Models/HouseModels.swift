import Foundation

enum HouseError: LocalizedError, Equatable {
    case invalidPairingCode
    case invalidCredential
    case notPaired
    case rejected(Int)
    case malformedResponse
    case server(String)
    case interrupted

    var errorDescription: String? {
        switch self {
        case .invalidPairingCode:
            return "맥에 뜬 숫자 4자리, 또는 이 집에서 만든 페어링만 받습니다."
        case .invalidCredential:
            return "이 아이폰에 연결 열쇠를 저장하지 못했습니다."
        case .notPaired:
            return "먼저 맥과 연결해야 합니다."
        case .rejected(let code):
            switch code {
            case 401: return "맥 연결이 만료됐습니다. 다시 연결해 주세요."
            case 403: return "이 기기로는 그 요청을 할 수 없습니다."
            case 404: return "맥에서 그 방을 찾지 못했습니다."
            case 429: return "요청이 많습니다. 잠시 후 다시 보내 주세요."
            case 502...599: return "맥의 로컬 AI가 잠시 응답하지 않습니다."
            default: return "맥이 요청을 거절했습니다. (HTTP \(code))"
            }
        case .malformedResponse:
            return "맥 응답을 읽지 못했습니다."
        case .server(let message):
            return message
        case .interrupted:
            return "답이 끝나기 전에 연결이 끊겼습니다."
        }
    }
}

enum LinkState: Equatable {
    case checking
    case linked
    case broken

    var title: String {
        switch self {
        case .checking: return "맥을 찾는 중"
        case .linked: return "맥과 연결됨"
        case .broken: return "맥과 끊김"
        }
    }
}

struct HouseMessage: Identifiable, Equatable, Sendable {
    enum Role: String, Sendable {
        case user
        case assistant
    }

    enum Delivery: String, Sendable {
        case sent
        case streaming
        case done
        case failed
    }

    let id: UUID
    let role: Role
    var text: String
    let createdAt: Date
    var delivery: Delivery
}

struct HouseRoom: Equatable, Sendable {
    var messages: [HouseMessage]
    var jobLabel: String?
    var updatedAt: Date
}

enum HouseStreamEvent: Equatable, Sendable {
    case status(String)
    case delta(String)
    case finished
}

enum HouseSSE {
    static func events(from block: String, eventName: String) -> [HouseStreamEvent] {
        let payload = block.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !payload.isEmpty else { return [] }
        if payload == "[DONE]" || eventName == "done" {
            return [.finished]
        }
        guard let data = payload.data(using: .utf8) else { return [] }
        if eventName == "status" {
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let label = (object["label"] as? String)
                    ?? (object["detail"] as? String)
                    ?? ((object["job"] as? [String: Any])?["detail"] as? String)
                if let label, !label.isEmpty { return [.status(label)] }
            }
            return [.status("맥이 듣고 있습니다")]
        }
        if eventName == "error" {
            return []
        }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let choices = object["choices"] as? [[String: Any]],
           let delta = choices.first?["delta"] as? [String: Any],
           let content = delta["content"] as? String,
           !content.isEmpty {
            return [.delta(content)]
        }
        return []
    }

    static func errorMessage(from block: String) -> String? {
        guard let data = block.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let message = object["message"] as? String, !message.isEmpty { return message }
        return nil
    }
}

struct HouseApproval: Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let title: String
    let summary: String
    let payloadSha256: String
    let nonce: String
    let expiresAt: String
}

enum ApprovalSigning {
    static let prefix = "localai-approval-v1"

    static func message(
        requestId: String,
        payloadSha256: String,
        nonce: String,
        expiresAt: String,
        decision: String
    ) -> String {
        [prefix, requestId, payloadSha256, nonce, expiresAt, decision].joined(separator: "\n")
    }
}

enum HouseDate {
    static func parse(_ value: String) -> Date {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        return basic.date(from: value) ?? Date()
    }
}

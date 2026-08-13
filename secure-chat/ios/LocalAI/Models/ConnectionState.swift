import Foundation

enum ConnectionState: Equatable {
    case checking
    case connected
    case thinking
    case disconnected

    var title: String {
        switch self {
        case .checking: return "연결 확인 중"
        case .connected: return "Mac 직접 연결"
        case .thinking: return "생각하는 중"
        case .disconnected: return "연결 끊김"
        }
    }

    var symbol: String {
        switch self {
        case .checking: return "arrow.trianglehead.2.clockwise"
        case .connected: return "lock.shield.fill"
        case .thinking: return "ellipsis.bubble.fill"
        case .disconnected: return "wifi.slash"
        }
    }
}

enum ApprovalKeyState: Equatable, Sendable {
    case checking
    case ready
    case repairRequired
    case unavailable

    var title: String {
        switch self {
        case .checking: return "확인 중"
        case .ready: return "iPhone 서명 준비됨"
        case .repairRequired: return "다시 페어링 필요"
        case .unavailable: return "일시적으로 확인 불가"
        }
    }
}

struct ChatProgress: Codable, Equatable, Sendable {
    let requestId: String
    let phase: Phase
    let mode: ChatMode
    let label: String

    enum Phase: String, Codable, Sendable {
        case accepted
        case routing
        case loading
        case thinking
        case generating
        case tool
        case approval
        case completed
    }
}

enum ChatStreamEvent: Sendable {
    case progress(ChatProgress)
    case delta(String)
    case finished
}

import Foundation

/// Mac Development Supervisor / Cursor 작업 요약 (읽기 전용 목록용).
struct DevelopmentRunSummary: Decodable, Identifiable, Equatable, Sendable {
    var id: String { runId }

    let runId: String
    let goal: String
    let status: String
    let channel: String?
    let envelopeApprovalId: String?
    let leafTaskIds: [String]
    let blockedReason: String?
    let error: String?
    let createdAt: String?
    let updatedAt: String?
    let expiresAt: String?
    let worktree: DevelopmentWorktreeSummary?

    enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case goal, status, channel
        case envelopeApprovalId = "envelope_approval_id"
        case leafTaskIds = "leaf_task_ids"
        case blockedReason = "blocked_reason"
        case error
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case expiresAt = "expires_at"
        case worktree
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runId = try container.decode(String.self, forKey: .runId)
        goal = try container.decode(String.self, forKey: .goal)
        status = try container.decode(String.self, forKey: .status)
        channel = try container.decodeIfPresent(String.self, forKey: .channel)
        envelopeApprovalId = try container.decodeIfPresent(String.self, forKey: .envelopeApprovalId)
        leafTaskIds = try container.decodeIfPresent([String].self, forKey: .leafTaskIds) ?? []
        blockedReason = try container.decodeIfPresent(String.self, forKey: .blockedReason)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)
        worktree = try container.decodeIfPresent(DevelopmentWorktreeSummary.self, forKey: .worktree)
    }

    var isTerminal: Bool {
        status == "DONE" || status == "FAILED"
    }

    var needsOwnerAttention: Bool {
        ["WAITING_ENVELOPE_APPROVAL", "WAITING_OWNER", "BLOCKED"].contains(status)
    }

    var statusLabelKorean: String {
        switch status {
        case "DISCUSSING": return "논의 중"
        case "INSPECTING": return "점검 중"
        case "ANALYZING": return "분석 중"
        case "PROPOSING": return "제안 중"
        case "WAITING_ENVELOPE_APPROVAL": return "Envelope 승인 대기"
        case "RUNNING_TASKS": return "Cursor 실행 중"
        case "WAITING_OWNER": return "소유자 확인 대기"
        case "REPORTING": return "보고 중"
        case "DONE": return "완료"
        case "BLOCKED": return "차단됨"
        case "FAILED": return "실패"
        default: return status
        }
    }
}

struct DevelopmentWorktreeSummary: Decodable, Equatable, Sendable {
    let worktreePath: String?
    let branch: String?
    let mainReadOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case worktreePath = "worktree_path"
        case branch
        case mainReadOnly = "main_read_only"
    }
}

struct OwnerTaskSummary: Decodable, Identifiable, Equatable, Sendable {
    var id: String { taskId }

    let taskId: String
    let goal: String
    let status: String
    let currentStep: String?
    let nextStep: String?
    let error: String?
    let updatedAt: String?
    let bindings: OwnerTaskBindingsSummary?

    enum CodingKeys: String, CodingKey {
        case taskId = "task_id"
        case goal, status
        case currentStep = "current_step"
        case nextStep = "next_step"
        case error
        case updatedAt = "updated_at"
        case bindings
    }

    var isCursorRelated: Bool {
        if bindings?.cursor != nil { return true }
        if bindings?.supervisor != nil { return true }
        let step = "\(currentStep ?? "") \(nextStep ?? "")".lowercased()
        return step.contains("cursor")
    }

    var statusLabelKorean: String {
        switch status {
        case "CREATED": return "생성됨"
        case "ANALYZING": return "분석 중"
        case "PLANNED": return "계획됨"
        case "WAITING_APPROVAL": return "승인 대기"
        case "EXECUTING": return "실행 중"
        case "VERIFYING": return "검증 중"
        case "SUCCESS": return "성공"
        case "FAILED": return "실패"
        case "NEEDS_REPLAN": return "재계획 필요"
        default: return status
        }
    }
}

struct OwnerTaskBindingsSummary: Decodable, Equatable, Sendable {
    let cursor: OwnerCursorBindingSummary?
    let supervisor: OwnerSupervisorBindingSummary?
}

struct OwnerCursorBindingSummary: Decodable, Equatable, Sendable {
    let approvalId: String?
    let kind: String?
    let sessionId: String?

    enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case kind
        case sessionId = "session_id"
    }
}

struct OwnerSupervisorBindingSummary: Decodable, Equatable, Sendable {
    let runId: String?
    let worktreePath: String?

    enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case worktreePath = "worktree_path"
    }
}

extension PendingApproval {
    var isDevelopmentOrCursorApproval: Bool {
        kind == "development.envelope"
            || kind == "cursor.develop"
            || kind.hasPrefix("cursor.")
            || kind.hasPrefix("development.")
    }
}

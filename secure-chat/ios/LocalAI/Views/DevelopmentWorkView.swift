import SwiftUI

/// Cursor / Development Supervisor 작업 목록 (읽기 + 관련 승인 바로가기).
struct DevelopmentWorkView: View {
    let approvalKeyState: ApprovalKeyState
    let onRepairPairing: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var runs: [DevelopmentRunSummary] = []
    @State private var tasks: [OwnerTaskSummary] = []
    @State private var approvals: [PendingApproval] = []
    @State private var refreshing = true
    @State private var reloadID: UUID?
    @State private var runsError: String?
    @State private var tasksError: String?
    @State private var approvalsError: String?
    @State private var updatedAt: Date?
    @State private var decidingID: String?
    @State private var decisionError: String?
    @State private var confirmRepairPairing = false

    private var activeRuns: [DevelopmentRunSummary] {
        runs.filter { !$0.isTerminal }
    }

    private var recentDoneRuns: [DevelopmentRunSummary] {
        Array(runs.filter(\.isTerminal).prefix(5))
    }

    private var cursorTasks: [OwnerTaskSummary] {
        tasks.filter(\.isCursorRelated).filter { task in
            !["SUCCESS", "FAILED"].contains(task.status)
        }
    }

    private var developmentApprovals: [PendingApproval] {
        approvals.filter(\.isDevelopmentOrCursorApproval)
    }

    var body: some View {
        NavigationStack {
            List {
                keyStatusSection
                developmentApprovalsSection
                activeRunsSection
                cursorTasksSection
                if !recentDoneRuns.isEmpty {
                    recentDoneSection
                }
            }
            .refreshable { await reload() }
            .overlay {
                if refreshing && runs.isEmpty && tasks.isEmpty && approvals.isEmpty {
                    ProgressView("작업 목록 불러오는 중")
                }
            }
            .navigationTitle("Cursor / 개발")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("닫기") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    refreshButton
                }
            }
        }
        .alert("승인 처리 오류", isPresented: Binding(
            get: { decisionError != nil },
            set: { if !$0 { decisionError = nil } }
        )) {
            Button("확인", role: .cancel) { decisionError = nil }
        } message: {
            Text(decisionError ?? "")
        }
        .confirmationDialog(
            "승인 연결을 다시 설정할까요?",
            isPresented: $confirmRepairPairing,
            titleVisibility: .visible
        ) {
            Button("다시 페어링", role: .destructive) { onRepairPairing() }
            Button("취소", role: .cancel) {}
        }
        .task { await reload() }
    }

    private var refreshButton: some View {
        Button { Task { await reload() } } label: {
            if refreshing { ProgressView().controlSize(.small) }
            else { Image(systemName: "arrow.clockwise") }
        }
        .disabled(refreshing || decidingID != nil)
        .accessibilityLabel("Cursor 작업 목록 새로고침")
    }

    private var keyStatusSection: some View {
        Section {
            if approvalKeyState == .repairRequired {
                Button("승인 연결 다시 페어링") { confirmRepairPairing = true }
                    .foregroundStyle(.orange)
            } else {
                Label(
                    approvalKeyState == .ready ? "승인 키 준비됨 (Face ID 필수)" : "승인 키 상태 확인 중",
                    systemImage: approvalKeyState == .ready ? "faceid" : "key.fill"
                )
                .foregroundStyle(approvalKeyState == .ready ? .green : .secondary)
            }
        } footer: {
            Text(updatedLabel)
        }
    }

    private var developmentApprovalsSection: some View {
        Section {
            if let approvalsError {
                Text(approvalsError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if developmentApprovals.isEmpty {
                Text("대기 중인 Cursor/Envelope 승인 없음")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(developmentApprovals) { approval in
                    DevelopmentApprovalRow(
                        approval: approval,
                        busy: decidingID == approval.id,
                        onDecision: { decision in
                            Task { await decide(approval, decision: decision) }
                        }
                    )
                }
            }
        } header: {
            Text("승인 대기")
        }
    }

    private var activeRunsSection: some View {
        Section {
            if let runsError {
                Text(runsError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if activeRuns.isEmpty {
                Text("진행 중인 Development Run 없음")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(activeRuns) { run in
                    DevelopmentRunRow(run: run)
                }
            }
        } header: {
            Text("진행 중 Supervisor")
        }
    }

    private var cursorTasksSection: some View {
        Section {
            if let tasksError {
                Text(tasksError)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if cursorTasks.isEmpty {
                Text("진행 중인 cursor.develop 태스크 없음")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(cursorTasks) { task in
                    OwnerCursorTaskRow(task: task)
                }
            }
        } header: {
            Text("Cursor 태스크")
        }
    }

    private var recentDoneSection: some View {
        Section("최근 완료/실패") {
            ForEach(recentDoneRuns) { run in
                DevelopmentRunRow(run: run)
            }
        }
    }

    private var updatedLabel: String {
        guard let updatedAt else { return "아직 확인하지 못함" }
        return "최근 확인 \(updatedAt.formatted(date: .omitted, time: .shortened))"
    }

    @MainActor
    private func reload() async {
        let current = UUID()
        reloadID = current
        refreshing = true

        async let runsReq = Self.capture { try await LocalAIClient.shared.fetchDevelopmentRuns(limit: 30) }
        async let tasksReq = Self.capture { try await LocalAIClient.shared.fetchOwnerTasks(limit: 40) }
        async let approvalsReq = Self.capture { try await LocalAIClient.shared.fetchPendingApprovals() }
        let outcomes = await (runsReq, tasksReq, approvalsReq)
        guard reloadID == current else { return }

        switch outcomes.0 {
        case .success(let value):
            runs = value
            runsError = nil
        case .failure(let message):
            runsError = message
        }
        switch outcomes.1 {
        case .success(let value):
            tasks = value
            tasksError = nil
        case .failure(let message):
            tasksError = message
        }
        switch outcomes.2 {
        case .success(let value):
            approvals = value
            approvalsError = nil
        case .failure(let message):
            approvalsError = message
        }
        updatedAt = Date()
        refreshing = false
    }

    @MainActor
    private func decide(_ approval: PendingApproval, decision: ApprovalDecision) async {
        guard decision == .rejected || approval.payloadHashMatches else {
            decisionError = LocalAIError.payloadIntegrityMismatch.localizedDescription
            return
        }
        decidingID = approval.id
        defer { decidingID = nil }
        do {
            try await LocalAIClient.shared.decide(approval, decision: decision)
            approvals.removeAll { $0.id == approval.id }
            updatedAt = Date()
        } catch {
            decisionError = error.localizedDescription
        }
    }

    private static func capture<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value
    ) async -> DevFetchOutcome<Value> {
        do { return .success(try await operation()) }
        catch { return .failure(error.localizedDescription) }
    }
}

private enum DevFetchOutcome<Value: Sendable>: Sendable {
    case success(Value)
    case failure(String)
}

private struct DevelopmentRunRow: View {
    let run: DevelopmentRunSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(run.statusLabelKorean)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(run.needsOwnerAttention ? Color.orange : Color.secondary)
                Spacer()
                Text(String(run.runId.prefix(8)))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
            Text(run.goal)
                .font(.body)
                .lineLimit(3)
            if let branch = run.worktree?.branch {
                Text(branch)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let error = run.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            } else if let blocked = run.blockedReason, !blocked.isEmpty {
                Text(blocked)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(run.statusLabelKorean). \(run.goal)")
    }
}

private struct OwnerCursorTaskRow: View {
    let task: OwnerTaskSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(task.statusLabelKorean)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(task.status == "WAITING_APPROVAL" ? Color.orange : Color.secondary)
                Spacer()
                if let kind = task.bindings?.cursor?.kind {
                    Text(kind)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Text(task.goal)
                .font(.body)
                .lineLimit(3)
            if let approvalId = task.bindings?.cursor?.approvalId {
                Text("승인 \(approvalId.prefix(20))…")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct DevelopmentApprovalRow: View {
    let approval: PendingApproval
    let busy: Bool
    let onDecision: (ApprovalDecision) -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(approval.title)
                .font(.headline)
            Text(approval.kind)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Text(approval.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(expanded ? nil : 3)
            Button(expanded ? "본문 접기" : "승인할 정확한 내용 펼치기") {
                expanded.toggle()
            }
            .font(.caption)
            if expanded {
                Text(approval.payload)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            if !approval.payloadHashMatches {
                Label("본문 해시 불일치 — 승인 차단", systemImage: "xmark.shield.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack(spacing: 10) {
                Button("거부", role: .destructive) { onDecision(.rejected) }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                    .disabled(busy)
                Button {
                    onDecision(.approved)
                } label: {
                    Label("Face ID로 승인", systemImage: "faceid")
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .disabled(busy || !expanded || !approval.payloadHashMatches)
            }
            if busy {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Face ID / 암호 확인 중")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 6)
    }
}

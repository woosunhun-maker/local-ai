import SwiftUI

/// Cursor / Development Supervisor 작업 목록 — 자동 새로고침 + Face ID 승인.
struct DevelopmentWorkView: View {
    let approvalKeyState: ApprovalKeyState
    let onRepairPairing: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
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
    @State private var autoRefreshEnabled = true
    @State private var pollingTask: Task<Void, Never>?

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

    private var attentionCount: Int {
        developmentApprovals.count
            + activeRuns.filter(\.needsOwnerAttention).count
            + cursorTasks.filter { $0.status == "WAITING_APPROVAL" }.count
    }

    var body: some View {
        NavigationStack {
            List {
                summarySection
                keyStatusSection
                developmentApprovalsSection
                activeRunsSection
                cursorTasksSection
                if !recentDoneRuns.isEmpty {
                    recentDoneSection
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload(manual: true) }
            .overlay {
                if refreshing && runs.isEmpty && tasks.isEmpty && approvals.isEmpty {
                    ProgressView("작업 목록 불러오는 중")
                        .padding(20)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .navigationTitle("Cursor / 개발")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("닫기") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 12) {
                        Toggle(isOn: $autoRefreshEnabled) {
                            Image(systemName: autoRefreshEnabled ? "arrow.triangle.2.circlepath" : "pause.circle")
                        }
                        .toggleStyle(.button)
                        .accessibilityLabel(autoRefreshEnabled ? "자동 새로고침 켜짐" : "자동 새로고침 꺼짐")
                        refreshButton
                    }
                }
            }
        }
        .tint(AppTheme.accent)
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
        .task {
            await reload(manual: true)
            startPollingIfNeeded()
        }
        .onChange(of: autoRefreshEnabled) { _, enabled in
            if enabled { startPollingIfNeeded() } else { stopPolling() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { startPollingIfNeeded() }
            else { stopPolling() }
        }
        .onDisappear { stopPolling() }
    }

    private var refreshButton: some View {
        Button { Task { await reload(manual: true) } } label: {
            if refreshing { ProgressView().controlSize(.small) }
            else { Image(systemName: "arrow.clockwise") }
        }
        .disabled(refreshing || decidingID != nil)
        .accessibilityLabel("지금 새로고침")
    }

    private var summarySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    summaryChip(title: "승인", value: developmentApprovals.count, emphasis: !developmentApprovals.isEmpty)
                    summaryChip(title: "진행", value: activeRuns.count, emphasis: false)
                    summaryChip(title: "Cursor", value: cursorTasks.count, emphasis: cursorTasks.contains { $0.status == "WAITING_APPROVAL" })
                }
                if attentionCount > 0 {
                    Label("소유자 확인 \(attentionCount)건", systemImage: "exclamationmark.bubble.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.orange)
                } else {
                    Label("지금 확인할 승인 없음", systemImage: "checkmark.seal.fill")
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.accent)
                }
                Text(updatedLabel)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 4)
        }
    }

    private func summaryChip(title: String, value: Int, emphasis: Bool) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.title3.monospacedDigit().weight(.semibold))
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(emphasis ? AppTheme.accent.opacity(0.14) : AppTheme.secondaryBackground)
        )
    }

    private var keyStatusSection: some View {
        Section {
            if approvalKeyState == .repairRequired {
                Button("승인 연결 다시 페어링") { confirmRepairPairing = true }
                    .foregroundStyle(.orange)
            } else {
                Label(
                    approvalKeyState == .ready ? "Face ID 승인 준비됨" : "승인 키 확인 중",
                    systemImage: approvalKeyState == .ready ? "faceid" : "key.fill"
                )
                .foregroundStyle(approvalKeyState == .ready ? AppTheme.accent : .secondary)
            }
            Toggle("목록 자동 새로고침", isOn: $autoRefreshEnabled)
        } footer: {
            Text("활성 작업이 있으면 수초마다 Mac 상태를 다시 읽습니다. IPA 자동 설치는 하지 않습니다.")
        }
    }

    private var developmentApprovalsSection: some View {
        Section {
            if let approvalsError {
                Text(approvalsError).font(.footnote).foregroundStyle(.red)
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
                Text(runsError).font(.footnote).foregroundStyle(.red)
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
                Text(tasksError).font(.footnote).foregroundStyle(.red)
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
        let auto = autoRefreshEnabled ? " · 자동 갱신" : ""
        return "최근 확인 \(updatedAt.formatted(date: .omitted, time: .shortened))\(auto)"
    }

    private func startPollingIfNeeded() {
        stopPolling()
        guard autoRefreshEnabled, scenePhase == .active else { return }
        pollingTask = Task {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(5))
                    try Task.checkCancellation()
                    await reload(manual: false)
                } catch is CancellationError {
                    return
                } catch {
                    return
                }
            }
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    @MainActor
    private func reload(manual: Bool) async {
        let current = UUID()
        reloadID = current
        if manual { refreshing = true }

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
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                statusPill(run.statusLabelKorean, attention: run.needsOwnerAttention)
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
                Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
            } else if let blocked = run.blockedReason, !blocked.isEmpty {
                Text(blocked).font(.caption).foregroundStyle(.orange).lineLimit(2)
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
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                statusPill(task.statusLabelKorean, attention: task.status == "WAITING_APPROVAL")
                Spacer()
                if let kind = task.bindings?.cursor?.kind {
                    Text(kind).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Text(task.goal).font(.body).lineLimit(3)
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
            Text(approval.title).font(.headline)
            Text(approval.kind).font(.caption.monospaced()).foregroundStyle(.secondary)
            Text(approval.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(expanded ? nil : 3)
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
                    Text("Face ID / 암호 확인 중").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 6)
    }
}

private func statusPill(_ title: String, attention: Bool) -> some View {
    Text(title)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(attention ? Color.orange : AppTheme.accent)
        .background(
            Capsule().fill(attention ? Color.orange.opacity(0.14) : AppTheme.accent.opacity(0.12))
        )
}

import SwiftUI

private enum FetchOutcome<Value: Sendable>: Sendable {
    case success(Value)
    case failure(String)
}

struct GrowthCenterView: View {
    let approvalKeyState: ApprovalKeyState
    let onRepairPairing: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var approvals: [PendingApproval] = []
    @State private var growthStatus: GrowthStatus?
    @State private var proposals: [GrowthProposalSummary] = []
    @State private var refreshing = true
    @State private var reloadID: UUID?
    @State private var decidingID: String?
    @State private var decisionError: String?
    @State private var approvalsError: String?
    @State private var statusError: String?
    @State private var proposalsError: String?
    @State private var approvalsUpdatedAt: Date?
    @State private var statusUpdatedAt: Date?
    @State private var proposalsUpdatedAt: Date?
    @State private var confirmRepairPairing = false

    var body: some View {
        NavigationStack {
            List {
                safeguardsSection
                approvalsSection
                proposalsSection
            }
            .navigationTitle("성장 및 승인")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("닫기") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await reload() } } label: {
                        if refreshing { ProgressView().controlSize(.small) }
                        else { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(refreshing || decidingID != nil)
                    .accessibilityLabel("성장과 승인 상태 새로고침")
                }
            }
            .alert("승인 처리 오류", isPresented: Binding(
                get: { decisionError != nil },
                set: { if !$0 { decisionError = nil } }
            )) {
                Button("확인", role: .cancel) { decisionError = nil }
            } message: {
                Text(decisionError ?? "알 수 없는 오류")
            }
            .confirmationDialog(
                "승인 연결을 다시 설정할까요?",
                isPresented: $confirmRepairPairing,
                titleVisibility: .visible
            ) {
                Button("다시 페어링", role: .destructive) {
                    dismiss()
                    onRepairPairing()
                }
                Button("취소", role: .cancel) {}
            } message: {
                Text("이 iPhone의 현재 연결 토큰만 지우고 Mac과 새 보안 키를 등록합니다. 대화 내용은 지우지 않습니다.")
            }
            .task { await reload() }
            .refreshable { await reload() }
        }
    }

    private var safeguardsSection: some View {
        Section {
            if let statusError {
                LoadStateRow(
                    message: statusUpdatedAt == nil ? "안전장치 상태를 확인하지 못했습니다." : "기존 안전장치 정보를 표시 중입니다.",
                    detail: statusError,
                    retry: { Task { await reload() } }
                )
            }
            securityRow(
                "개인정보",
                detail: privacyDetail,
                symbol: "hand.raised.fill",
                color: growthStatus == nil ? .secondary : .green
            )
            securityRow(
                "외부 AI 자문",
                detail: externalTransferDetail,
                symbol: "checkmark.shield.fill",
                color: growthStatus == nil ? .secondary : .blue
            )
            securityRow(
                "자동 적용",
                detail: autoApplyDetail,
                symbol: "lock.fill",
                color: autoApplyColor
            )
            securityRow(
                "iPhone 승인 키",
                detail: approvalKeyState.title,
                symbol: approvalKeyState == .ready ? "key.fill" : "key.slash.fill",
                color: approvalKeyState == .ready ? .green : .orange
            )
            if approvalKeyState == .repairRequired {
                Button("승인 연결 다시 페어링") {
                    confirmRepairPairing = true
                }
                .foregroundStyle(.orange)
            }
        } header: {
            Text("성장 안전장치")
        } footer: {
            Text("승인·거부 모두 Face ID 또는 iPhone 암호가 필요합니다. 아이폰이 화면에 표시한 본문을 다시 해시하고 Secure Enclave로 서명합니다. Mac은 같은 본문과 요청만 한 번 처리하며, 승인했다고 임의 작업 권한이 생기지 않습니다. 외부 답변은 실행 권한이 없는 검토 자료로만 저장됩니다.\n\(updatedLabel(statusUpdatedAt))")
        }
    }

    private var approvalsSection: some View {
        Section {
            if let approvalsError {
                LoadStateRow(
                    message: approvalsUpdatedAt == nil ? "승인 요청을 확인하지 못했습니다." : "이전에 확인한 승인 요청입니다.",
                    detail: approvalsError,
                    retry: { Task { await reload() } }
                )
            }

            if approvalsUpdatedAt == nil && refreshing {
                loadingRow("승인 요청 확인 중")
            } else if approvalsUpdatedAt != nil && approvals.isEmpty {
                ContentUnavailableView(
                    "대기 중인 요청 없음",
                    systemImage: "checkmark.shield",
                    description: Text("Local AI는 승인 없이 보호된 작업이나 외부 전송을 실행하지 않습니다.")
                )
            } else {
                ForEach(approvals) { approval in
                    ApprovalCard(
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
        } footer: {
            Text(updatedLabel(approvalsUpdatedAt))
        }
    }

    private var proposalsSection: some View {
        Section {
            if let proposalsError {
                LoadStateRow(
                    message: proposalsUpdatedAt == nil ? "개선 제안을 확인하지 못했습니다." : "이전에 확인한 개선 제안입니다.",
                    detail: proposalsError,
                    retry: { Task { await reload() } }
                )
            }

            if proposalsUpdatedAt == nil && refreshing {
                loadingRow("격리된 개선 제안 확인 중")
            } else if proposalsUpdatedAt != nil && proposals.isEmpty {
                ContentUnavailableView(
                    "아직 개선 제안 없음",
                    systemImage: "lightbulb",
                    description: Text("Local AI가 문제를 발견하면 개인정보 없는 기술 질문과 합성 시험을 먼저 준비합니다.")
                )
            } else {
                ForEach(proposals) { proposal in
                    proposalRow(proposal)
                }
            }
        } header: {
            Text("개선 제안")
        } footer: {
            Text(updatedLabel(proposalsUpdatedAt))
        }
    }

    @ViewBuilder
    private func securityRow(_ title: String, detail: String, symbol: String, color: Color) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                securityLabel(title, symbol: symbol, color: color)
                Spacer()
                securityDetail(detail)
            }
            VStack(alignment: .leading, spacing: 5) {
                securityLabel(title, symbol: symbol, color: color)
                securityDetail(detail).padding(.leading, 40)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func securityLabel(_ title: String, symbol: String, color: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 28)
            Text(title)
        }
    }

    private func securityDetail(_ detail: String) -> some View {
        Text(detail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
    }

    private func loadingRow(_ message: String) -> some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(message).foregroundStyle(.secondary)
        }
    }

    private func proposalRow(_ proposal: GrowthProposalSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text(proposal.title).font(.headline)
                    Spacer()
                    proposalStatus(proposal.status)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(proposal.title).font(.headline)
                    proposalStatus(proposal.status)
                }
            }
            Text(proposal.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("외부 조언 기반 · 개정 \(proposal.revision)")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private func proposalStatus(_ status: String) -> some View {
        Text(statusLabel(status))
            .font(.caption.weight(.semibold))
            .foregroundStyle(statusColor(status))
    }

    private var privacyDetail: String {
        guard let growthStatus else { return "미확인" }
        return growthStatus.blockedCategories == "personal_and_unclassified" ? "개인·미분류 차단" : "정책 \(growthStatus.dlpPolicy)"
    }

    private var externalTransferDetail: String {
        guard let growthStatus else { return "미확인" }
        return growthStatus.externalTransfer == "exact_payload_iphone_approval" ? "정확한 본문 승인 후 1회" : "알 수 없는 정책"
    }

    private var autoApplyDetail: String {
        guard let growthStatus else { return "미확인" }
        return growthStatus.autoApply ? "켜짐" : "꺼짐 · 개선 제안만 생성"
    }

    private var autoApplyColor: Color {
        guard let growthStatus else { return .secondary }
        return growthStatus.autoApply ? .red : .green
    }

    private func updatedLabel(_ date: Date?) -> String {
        guard let date else { return "아직 확인하지 못함" }
        return "최근 확인 \(date.formatted(date: .omitted, time: .shortened))"
    }

    @MainActor
    private func reload() async {
        let currentReloadID = UUID()
        reloadID = currentReloadID
        refreshing = true

        async let approvalsRequest = Self.capture { try await LocalAIClient.shared.fetchPendingApprovals() }
        async let statusRequest = Self.capture { try await LocalAIClient.shared.fetchGrowthStatus() }
        async let proposalsRequest = Self.capture { try await LocalAIClient.shared.fetchGrowthProposals() }
        let outcomes = await (approvalsRequest, statusRequest, proposalsRequest)

        guard reloadID == currentReloadID else { return }
        let now = Date()
        switch outcomes.0 {
        case .success(let value):
            approvals = value
            approvalsError = nil
            approvalsUpdatedAt = now
        case .failure(let message):
            approvalsError = message
        }
        switch outcomes.1 {
        case .success(let value):
            growthStatus = value
            statusError = nil
            statusUpdatedAt = now
        case .failure(let message):
            statusError = message
        }
        switch outcomes.2 {
        case .success(let value):
            proposals = value
            proposalsError = nil
            proposalsUpdatedAt = now
        case .failure(let message):
            proposalsError = message
        }
        refreshing = false
    }

    private static func capture<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value
    ) async -> FetchOutcome<Value> {
        do { return .success(try await operation()) }
        catch { return .failure(error.localizedDescription) }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "pending": return "검토 대기"
        case "approved": return "적용 승인"
        case "rejected": return "거부됨"
        case "applied": return "적용 완료"
        default: return "알 수 없음"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "applied": return .green
        case "rejected": return .red
        case "approved": return .blue
        default: return .orange
        }
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
            approvalsUpdatedAt = Date()
        } catch {
            decisionError = error.localizedDescription
        }
    }
}

private struct LoadStateRow: View {
    let message: String
    let detail: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Button("다시 확인", action: retry)
                .font(.footnote.weight(.semibold))
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ApprovalCard: View {
    let approval: PendingApproval
    let busy: Bool
    let onDecision: (ApprovalDecision) -> Void
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(approval.title, systemImage: symbol)
                .font(.headline)
            Text(approval.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            DisclosureGroup("승인할 정확한 내용", isExpanded: $expanded) {
                Text(approval.payload)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.top, 8)

                VStack(alignment: .leading, spacing: 4) {
                    Text("SHA-256")
                        .font(.caption.weight(.semibold))
                    Text(approval.payloadSha256)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                }
                .foregroundStyle(.secondary)
                .padding(.top, 4)
            }

            if !approval.payloadHashMatches {
                Label("본문 해시가 일치하지 않아 승인을 차단했습니다.", systemImage: "xmark.shield.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
            } else if !expanded {
                Label("정확한 본문을 펼쳐야 승인할 수 있습니다.", systemImage: "eye.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if !approval.dataCategories.isEmpty {
                Text(approval.dataCategories.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text("만료 \(approval.expiresAt)")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            HStack(spacing: 10) {
                Button("거부", role: .destructive) { onDecision(.rejected) }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                    .disabled(busy)
                    .accessibilityHint("Face ID 또는 iPhone 암호로 거부를 서명합니다")
                Button {
                    onDecision(.approved)
                } label: {
                    Label("Face ID로 승인", systemImage: "faceid")
                }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
                    .disabled(busy || !expanded || !approval.payloadHashMatches)
                    .accessibilityHint("Face ID 또는 iPhone 암호로 승인을 서명합니다")
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
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }

    private var symbol: String {
        approval.kind == "gpt.consult" ? "network.badge.shield.half.filled" : "exclamationmark.shield.fill"
    }
}

import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
final class CodexTaskViewModel: ObservableObject {
    @Published var requestText = ""
    @Published var intent: CodexTaskIntent = .inspect
    @Published private(set) var tasks: [CodexTask] = []
    @Published private(set) var task: CodexTask?
    @Published private(set) var approval: PendingApproval?
    @Published private(set) var plan: CodexTaskPlan?
    @Published private(set) var loading = false
    @Published private(set) var deciding = false
    @Published var errorMessage: String?
    @Published var noticeMessage: String?

    private var pollingTask: Task<Void, Never>?
    private var started = false
    private(set) var creationAttempt: CodexTaskCreationAttempt?

    var canCreate: Bool {
        !lockedForApproval && !loading && !deciding && CodexContract.requestIsValid(requestText)
    }

    var lockedForApproval: Bool {
        task?.status == .awaitingApproval && approval != nil && plan != nil
    }

    var requestLength: Int { requestText.utf16.count }

    func start(initialDraft: String?) async {
        if !started {
            started = true
            if let initialDraft, requestText.isEmpty {
                requestText = initialDraft
            }
        }
        await refreshHistory(selectLatest: initialDraft == nil && task == nil)
    }

    func create() async {
        guard !loading, !lockedForApproval else { return }
        stopPolling()
        loading = true
        errorMessage = nil
        noticeMessage = nil
        defer { loading = false }
        do {
            let attempt = try CodexTaskCreationAttempt.prepare(
                reusing: creationAttempt,
                intent: intent,
                request: requestText
            )
            creationAttempt = attempt
            task = nil
            approval = nil
            plan = nil
            try await LocalAIClient.shared.registerCodexApprovalKey()
            let response = try await LocalAIClient.shared.createCodexTask(
                intent: attempt.expectation.intent,
                request: attempt.expectation.request,
                idempotencyKey: attempt.expectation.idempotencyKey
            )
            requestText = attempt.expectation.request
            intent = attempt.expectation.intent
            try apply(CodexTaskDetailResponse(task: response.task, approval: response.approval))
            creationAttempt = nil
            await refreshHistory(selectLatest: false)
            if !response.task.status.isTerminal && response.task.status != .awaitingApproval {
                startPolling()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func decide(_ decision: ApprovalDecision) async {
        guard let task, let approval, let plan, !deciding else { return }
        deciding = true
        errorMessage = nil
        noticeMessage = nil
        defer { deciding = false }
        do {
            let expectation = try CodexTaskPlanExpectation(
                intent: intent,
                request: requestText,
                idempotencyKey: plan.idempotencyKey
            )
            let frozen = try approval.validatedCodexPlan(for: task, expected: expectation)
            guard frozen == plan else { throw LocalAIError.payloadIntegrityMismatch }
            let detail = try await LocalAIClient.shared.decideCodexTask(
                task: task,
                approval: approval,
                expectedPlan: frozen,
                decision: decision
            )
            try apply(detail)
            creationAttempt = nil
            await refreshHistory(selectLatest: false)
            if decision == .approved { startPolling() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func beginAnotherTask() {
        guard !deciding else { return }
        stopPolling()
        task = nil
        approval = nil
        plan = nil
        requestText = ""
        intent = .inspect
        creationAttempt = nil
        errorMessage = nil
        noticeMessage = nil
    }

    func select(_ value: CodexTask) async {
        stopPolling()
        loading = true
        errorMessage = nil
        noticeMessage = nil
        defer { loading = false }
        do {
            let detail = try await LocalAIClient.shared.fetchCodexTask(id: value.id)
            try apply(detail)
            if !detail.task.status.isTerminal && detail.task.status != .awaitingApproval {
                startPolling()
            }
        } catch LocalAIError.rejected(let code) where code == 404 {
            handleMissingTask(id: value.id)
            await refreshHistory(selectLatest: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func resumePollingIfNeeded() {
        guard let task, !task.status.isTerminal, task.status != .awaitingApproval else { return }
        startPolling()
    }

    func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    private func refreshHistory(selectLatest: Bool) async {
        do {
            let values = try await LocalAIClient.shared.fetchCodexTasks(limit: 20)
            tasks = values
            if selectLatest, let latest = values.first {
                do {
                    let detail = try await LocalAIClient.shared.fetchCodexTask(id: latest.id)
                    try apply(detail)
                    if !detail.task.status.isTerminal && detail.task.status != .awaitingApproval {
                        startPolling()
                    }
                } catch LocalAIError.rejected(let code) where code == 404 {
                    handleMissingTask(id: latest.id)
                }
            }
        } catch {
            if tasks.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    private func apply(_ detail: CodexTaskDetailResponse) throws {
        let validatedTask = try detail.task.validated()
        if validatedTask.status == .awaitingApproval {
            guard let approval = detail.approval else { throw LocalAIError.malformedResponse }
            let frozenPlan = try approval.validatedCodexPlan(for: validatedTask)
            let restoredAttempt = CodexTaskCreationAttempt(
                expectation: try CodexTaskPlanExpectation(
                    intent: frozenPlan.intent,
                    request: frozenPlan.request,
                    idempotencyKey: frozenPlan.idempotencyKey
                )
            )
            task = validatedTask
            self.approval = approval
            plan = frozenPlan
            requestText = frozenPlan.request
            intent = frozenPlan.intent
            creationAttempt = restoredAttempt
        } else {
            guard detail.approval == nil else { throw LocalAIError.malformedResponse }
            task = validatedTask
            approval = nil
            plan = nil
            creationAttempt = nil
        }
    }

    private func startPolling() {
        stopPolling()
        guard let id = task?.id else { return }
        pollingTask = Task { [weak self] in
            let delays: [Duration] = [.seconds(1), .seconds(2), .seconds(3), .seconds(5)]
            var index = 0
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: delays[min(index, delays.count - 1)])
                    try Task.checkCancellation()
                    let detail = try await LocalAIClient.shared.fetchCodexTask(id: id)
                    guard !Task.isCancelled else { return }
                    if let self { try self.apply(detail) }
                    if detail.task.status.isTerminal { return }
                    index += 1
                } catch is CancellationError {
                    return
                } catch LocalAIError.rejected(let code) where code == 404 {
                    self?.handleMissingTask(id: id)
                    return
                } catch {
                    self?.errorMessage = error.localizedDescription
                    index = min(index + 1, delays.count - 1)
                }
            }
        }
    }

    private func handleMissingTask(id: String) {
        tasks.removeAll { $0.id == id }
        if task?.id == id {
            task = nil
            approval = nil
            plan = nil
            creationAttempt = nil
        }
        noticeMessage = "이 작업은 로컬 보존 한도에 따라 Mac에서 정상 정리되었습니다."
    }
}

struct CodexTaskFlowView: View {
    let initialDraft: String?

    @StateObject private var model = CodexTaskViewModel()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var showExactPayload = false
    @State private var copiedPatchSha256: String?

    var body: some View {
        NavigationStack {
            Form {
                safetySection
                if let notice = model.noticeMessage {
                    Section {
                        Label(notice, systemImage: "clock.badge.checkmark")
                            .foregroundStyle(.secondary)
                        Button("안내 닫기") { model.noticeMessage = nil }
                    }
                }
                requestSection
                if let task = model.task {
                    statusSection(task)
                }
                if let task = model.task, let approval = model.approval, let plan = model.plan {
                    approvalSection(task: task, approval: approval, plan: plan)
                }
                if !model.tasks.isEmpty {
                    historySection
                }
            }
            .navigationTitle("Codex 작업")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                }
            }
            .overlay {
                if model.loading && model.tasks.isEmpty {
                    ProgressView("Mac 작업 상태 확인 중")
                        .padding(20)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .alert("작업 처리 오류", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("확인", role: .cancel) { model.errorMessage = nil }
            } message: {
                Text(model.errorMessage ?? "알 수 없는 오류")
            }
        }
        .task { await model.start(initialDraft: initialDraft) }
        .onDisappear { model.stopPolling() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.resumePollingIfNeeded() }
            else { model.stopPolling() }
        }
    }

    private var safetySection: some View {
        Section {
            Label("표시된 작업문과 허용 목록 코드에서 알려진 식별자를 검사·치환한 복사본은 OpenAI Codex로 전송되어 외부 처리됩니다.", systemImage: "globe")
                .foregroundStyle(.blue)
            Label("개인 운영 문서는 복사 대상에서 제외하며, 알려진 식별자 검사에 실패하면 전송을 차단합니다.", systemImage: "lock.shield.fill")
                .foregroundStyle(.green)
            Label("모델에는 추가 인터넷 도구와 Mac 원본 파일 도구를 제공하지 않으며, 실제 소스 적용·배포·삭제도 하지 않습니다.", systemImage: "hand.raised.fill")
                .foregroundStyle(.orange)
            Label("로컬 Codex 클라이언트는 기존 Codex 로그인 인증을 사용하며 별도 OS 프로세스 샌드박스는 현재 없습니다.", systemImage: "exclamationmark.shield.fill")
                .foregroundStyle(.orange)
        } header: {
            Text("외부 처리와 고정 보호 경계")
        } footer: {
            Text("직원명, 가게 장부, 이메일, 계정정보, 사진 원본은 이 경로에 입력하지 마세요. 현재는 코드 점검과 격리 초안만 허용합니다.")
        }
    }

    private var requestSection: some View {
        Section {
            Picker("작업 종류", selection: $model.intent) {
                ForEach(CodexTaskIntent.allCases) { intent in
                    Text(intent.title).tag(intent)
                }
            }
            .pickerStyle(.segmented)
            .disabled(model.lockedForApproval)

            Text(model.intent.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)

            TextEditor(text: $model.requestText)
                .frame(minHeight: 110)
                .disabled(model.lockedForApproval)
                .overlay(alignment: .topLeading) {
                    if model.requestText.isEmpty {
                        Text("예: 승인 경로의 재생 공격 방지를 점검해줘")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }

            HStack {
                Text("\(model.requestLength)/\(CodexContract.maximumRequestLength)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(model.requestLength > CodexContract.maximumRequestLength ? .red : .secondary)
                Spacer()
                Button {
                    Task { await model.create() }
                } label: {
                    if model.loading {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("계획 만들기", systemImage: "doc.badge.gearshape")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canCreate)
            }

            if model.lockedForApproval {
                Label("표시된 요청을 그대로 승인하거나 거부하기 전에는 편집할 수 없습니다.", systemImage: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("새 작업")
        }
    }

    private func statusSection(_ task: CodexTask) -> some View {
        Section {
            HStack(spacing: 12) {
                statusIcon(task.status)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.status.title).font(.headline)
                    Text("작업 #\(task.id.prefix(8)) · \(task.intent.title)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            if let result = task.result {
                Text(result.summary)
                    .textSelection(.enabled)
                if task.intent == .draft {
                    Label("격리 초안 \(result.changedFileCount)개 · 실제 소스 미적용", systemImage: "doc.badge.shield.checkmark")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let patch = result.patch, let patchSha256 = result.patchSha256 {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("변경 경로").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            ForEach(result.changedPaths, id: \.self) { path in
                                Text(path).font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("초안 SHA-256").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(patchSha256).font(.caption.monospaced()).textSelection(.enabled)
                        }
                        DisclosureGroup("검증된 격리 변경 초안 보기") {
                            ScrollView(.horizontal) {
                                Text(patch)
                                    .font(.caption.monospaced())
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: true, vertical: false)
                            }
                            Button {
                                copyPatch(patch, sha256: patchSha256)
                            } label: {
                                Label(
                                    copiedPatchSha256 == patchSha256 ? "이 기기 클립보드에 복사됨" : "초안 복사",
                                    systemImage: copiedPatchSha256 == patchSha256 ? "checkmark" : "doc.on.doc"
                                )
                            }
                            .buttonStyle(.bordered)
                            Text("복사본은 이 기기에서만 사용되며 10분 후 클립보드에서 만료됩니다.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Label("검토·복사만 가능하며 자동 적용 기능은 없습니다.", systemImage: "hand.raised.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    } else if task.status == .succeeded {
                        Label("안전하게 제안할 코드 변경이 없어 초안 파일은 없습니다.", systemImage: "doc.badge.ellipsis")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if task.status.isTerminal {
                Button {
                    model.beginAnotherTask()
                } label: {
                    Label("새 Codex 작업 시작", systemImage: "plus.circle.fill")
                }
            }

            if task.status == .interruptedUncertain {
                Label("결과를 확정할 수 없어 자동 재실행하지 않습니다.", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }

            DisclosureGroup("감사 식별자") {
                LabeledContent("작업 ID", value: task.id)
                LabeledContent("계획 SHA-256", value: task.planSha256)
            }
            .font(.caption)
            .textSelection(.enabled)
        } header: {
            Text("현재 작업")
        }
    }

    private func copyPatch(_ patch: String, sha256: String) {
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: patch]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(10 * 60),
            ]
        )
        copiedPatchSha256 = sha256
    }

    private func approvalSection(task: CodexTask, approval: PendingApproval, plan: CodexTaskPlan) -> some View {
        Section {
            LabeledContent("작업", value: plan.intent.title)
            LabeledContent("Codex 버전", value: plan.execution.codexVersion)
            LabeledContent("모델", value: plan.execution.model)
            LabeledContent("추론 강도", value: plan.execution.reasoningEffort)
            LabeledContent("처리 제공자", value: "OpenAI Codex · 외부 처리")
            LabeledContent("외부 전송", value: plan.execution.externalTransfer ? "있음" : "없음")
            VStack(alignment: .leading, spacing: 6) {
                Text("전송 데이터").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text("표시된 작업문 + 허용 목록 코드에서 알려진 식별자를 검사·치환한 복사본")
            }
            LabeledContent("소스 정책", value: plan.execution.sourcePolicy)
            LabeledContent(
                "Mac 원본 소스",
                value: plan.execution.ownerSourcePermission == CodexContract.ownerSourcePermission
                    ? "읽기 전용 · 변경 없음"
                    : plan.execution.ownerSourcePermission
            )
            VStack(alignment: .leading, spacing: 6) {
                Text("초안 검증").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text("격리 복사본에만 임시 적용해 검증하고 완료 후 자동 정리하며, 실패 시 worker 시작 때 재시도합니다.")
            }
            LabeledContent("Codex 도구 추가 인터넷", value: plan.execution.toolNetwork ? "허용" : "차단")
            LabeledContent("모델의 Mac 원본 파일 도구", value: plan.execution.modelHostFileTools ? "제공" : "미제공")
            LabeledContent("OS 프로세스 샌드박스", value: plan.execution.osProcessSandbox ? "있음" : "없음")
            LabeledContent(
                "클라이언트 인증",
                value: plan.execution.clientAuthentication == CodexContract.clientAuthentication
                    ? "기존 Codex 로그인 인증 사용"
                    : plan.execution.clientAuthentication
            )
            LabeledContent("실제 소스 적용", value: plan.execution.sourceApply ? "허용" : "차단")
            LabeledContent("승인 만료", value: approval.expiresAt)

            VStack(alignment: .leading, spacing: 6) {
                Text("계획 SHA-256").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(approval.payloadSha256)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("허용 코드 스냅샷 SHA-256").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(plan.sourceManifestSha256)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            LabeledContent("허용 코드 본문 규모", value: sourceBodySizeSummary(plan))
            Label("앱은 코드 원문 자체를 표시하지 않으며, 고정된 허용 코드 스냅샷의 해시와 본문 규모를 확인합니다.", systemImage: "number.square.fill")
                .font(.caption)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("요청 원문").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(plan.request).textSelection(.enabled)
            }

            DisclosureGroup("서명할 계획 JSON", isExpanded: $showExactPayload) {
                Text(approval.payload)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }

            HStack(spacing: 12) {
                Button("거부", role: .destructive) {
                    Task { await model.decide(.rejected) }
                }
                .buttonStyle(.bordered)
                .disabled(model.deciding)

                Button {
                    Task { await model.decide(.approved) }
                } label: {
                    if model.deciding {
                        ProgressView().tint(.white)
                    } else {
                        Label("Face ID 또는 iPhone 암호로 승인", systemImage: "faceid")
                    }
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .disabled(model.deciding)
            }
        } header: {
            Text("실행 전 승인")
        } footer: {
            Text("승인하면 표시된 작업문과 해시·본문 규모로 고정된 허용 목록 코드의 알려진 식별자 검사·치환 복사본이 OpenAI Codex 외부 처리에 사용됩니다. 승인은 위 계획 JSON·SHA-256·만료시각에만 유효하며 다른 작업에 재사용할 수 없습니다.")
        }
    }

    private func sourceBodySizeSummary(_ plan: CodexTaskPlan) -> String {
        let megabytes = Double(plan.sourceTotalBytes) / 1_048_576
        let size = String(format: "%.2f", locale: Locale.current, megabytes)
        return "\(plan.sourceFileCount.formatted())개 · \(size) MB"
    }

    private var historySection: some View {
        Section {
            ForEach(model.tasks) { task in
                Button {
                    Task { await model.select(task) }
                } label: {
                    HStack(spacing: 12) {
                        statusIcon(task.status)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(task.intent.title) · \(task.status.title)")
                                .foregroundStyle(.primary)
                            Text("#\(task.id.prefix(8))")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }
                }
            }
        } header: {
            Text("최근 작업")
        } footer: {
            Text("완료·실패·중단·거부·만료 기록과 검증된 초안은 로컬 Mac에 7일 또는 최근 100개 중 먼저 도달한 한도까지 보존됩니다. 진행 중인 작업은 이 정리 대상에서 제외됩니다.")
        }
    }

    @ViewBuilder
    private func statusIcon(_ status: CodexTaskStatus) -> some View {
        switch status {
        case .awaitingApproval:
            Image(systemName: "checkmark.shield").foregroundStyle(.orange)
        case .queued, .running:
            ProgressView().controlSize(.small)
        case .succeeded:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed, .interruptedUncertain:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .rejected, .expired:
            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
        }
    }
}

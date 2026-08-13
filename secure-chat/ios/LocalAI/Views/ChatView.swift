import SwiftUI
import UIKit

struct ChatResponseGeneration: Equatable, Sendable {
    let id: UUID
    let conversationID: UUID
    let responseID: UUID
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var text = ""
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var busy = false
    @Published private(set) var connection: ConnectionState = .checking
    @Published private(set) var approvalKeyState: ApprovalKeyState = .checking
    @Published private(set) var progress: ChatProgress?
    @Published private(set) var activityStartedAt: Date?
    @Published private(set) var activeResponseID: UUID?
    @Published private(set) var renderRevision = 0
    @Published var errorMessage: String?
    @Published private(set) var mode: ChatMode = .auto
    /// 보내기 직전에만 켜는 수동 옵션. 자동 판단하지 않는다.
    @Published var askOtherAIs = false

    let speech = SpeechController()
    let playback = SpeechPlaybackController.shared

    private let store: ConversationStore
    private let statusCheck: @Sendable () async throws -> Void
    private let approvalKeyCheck: @Sendable () async -> ApprovalKeyState
    private let streamRequest: @Sendable ([ChatMessage], ChatMode) async throws -> AsyncThrowingStream<ChatStreamEvent, Error>
    private var conversation: Conversation
    private var activeTask: Task<Void, Never>?
    private var activeGeneration: ChatResponseGeneration?
    private var failedResponseID: UUID?

    init(
        store: ConversationStore,
        statusCheck: @escaping @Sendable () async throws -> Void = {
            try await LocalAIClient.shared.checkStatus()
        },
        approvalKeyCheck: @escaping @Sendable () async -> ApprovalKeyState = {
            await LocalAIClient.shared.checkApprovalKeyStatus()
        },
        streamRequest: @escaping @Sendable ([ChatMessage], ChatMode) async throws -> AsyncThrowingStream<ChatStreamEvent, Error> = { messages, mode in
            try LocalAIClient.shared.stream(messages: messages, mode: mode)
        }
    ) {
        self.store = store
        self.statusCheck = statusCheck
        self.approvalKeyCheck = approvalKeyCheck
        self.streamRequest = streamRequest
        conversation = store.selected
        messages = conversation.messages
        text = conversation.draft
        mode = conversation.mode

        if AppRuntime.isVisualTest {
            approvalKeyState = .ready
            messages = [
                ChatMessage(role: .user, content: "오늘 집 상태와 먼저 챙길 일을 알려줘."),
                ChatMessage(
                    role: .assistant,
                    content: "### 현재 상태\n\n특이사항은 없습니다. 다음 일정 전에는 아래 두 가지만 확인하면 됩니다.\n\n- 거실 조명 자동화\n- 현관 센서 배터리",
                    deliveryState: .completed
                ),
            ]
        }
    }

    var title: String { conversation.title }
    var canRetry: Bool { failedResponseID != nil && !busy }

    func start() async {
        if AppRuntime.isVisualTest {
            connection = .connected
            approvalKeyState = .ready
            return
        }
        do {
            try await statusCheck()
            connection = .connected
        } catch {
            connection = .disconnected
            approvalKeyState = .unavailable
            return
        }
        approvalKeyState = .checking
        approvalKeyState = await approvalKeyCheck()
    }

    func setMode(_ newMode: ChatMode) {
        mode = newMode
        conversation.mode = newMode
        persist()
    }

    func load(_ value: Conversation) {
        playback.stop()
        cancelActiveResponseForTransition()
        let selected = store.select(value.id) ?? value
        activate(selected)
    }

    private func activate(_ value: Conversation) {
        conversation = value
        messages = value.messages
        text = value.draft
        mode = value.mode
        errorMessage = nil
        failedResponseID = nil
        renderRevision += 1
    }

    func newConversation() {
        playback.stop()
        cancelActiveResponseForTransition()
        activate(store.createConversation())
    }

    func deleteConversation(_ id: UUID) {
        if id == conversation.id {
            playback.stop()
            cancelActiveResponseForTransition()
        }
        let selected = store.delete(id)
        if id == conversation.id { activate(selected) }
    }

    func mergeInbox(_ incoming: [ChatMessage]) {
        let existing = Set(messages.map(\.id))
        let fresh = incoming.filter { !existing.contains($0.id) }
        guard !fresh.isEmpty else { return }
        messages.append(contentsOf: fresh)
        persist()
        renderRevision += 1
    }

    func saveDraft() {
        conversation.draft = text
        persist()
    }

    func send(voiceReplies: Bool) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !busy else { return }
        text = ""
        messages.append(ChatMessage(role: .user, content: question, deliveryState: .sent))
        conversation.draft = ""
        persist()
        beginResponse(voiceReplies: voiceReplies)
    }

    func retry(voiceReplies: Bool) {
        guard let failedResponseID,
              let responseIndex = messages.firstIndex(where: { $0.id == failedResponseID }),
              messages[..<responseIndex].last(where: { $0.role == .user }) != nil,
              !busy else { return }
        messages.removeSubrange(responseIndex...)
        self.failedResponseID = nil
        errorMessage = nil
        persist()
        beginResponse(voiceReplies: voiceReplies)
    }

    func regenerate(responseID: UUID, voiceReplies: Bool) {
        guard let responseIndex = messages.firstIndex(where: { $0.id == responseID }),
              messages[..<responseIndex].last(where: { $0.role == .user }) != nil,
              !busy else { return }
        messages.removeSubrange(responseIndex...)
        errorMessage = nil
        failedResponseID = nil
        persist()
        beginResponse(voiceReplies: voiceReplies)
    }

    func stopGeneration() {
        guard busy else { return }
        activeTask?.cancel()
    }

    func stopSpeaking() {
        playback.stop()
    }

    func speak(_ message: ChatMessage) {
        let selectedVoice = UserDefaults.standard.string(forKey: "speechVoiceIdentifier")
        playback.speak(message.content, voiceIdentifier: selectedVoice)
    }

    private func beginResponse(voiceReplies: Bool) {
        let context = messages.filter { $0.deliveryState != .failed && $0.deliveryState != .cancelled }
        let response = ChatMessage(role: .assistant, content: "", deliveryState: .streaming)
        messages.append(response)
        let generation = ChatResponseGeneration(
            id: UUID(),
            conversationID: conversation.id,
            responseID: response.id
        )
        let requestMode: ChatMode = askOtherAIs ? .deep : mode
        activeGeneration = generation
        activeResponseID = response.id
        busy = true
        errorMessage = nil
        failedResponseID = nil
        activityStartedAt = Date()
        progress = ChatProgress(
            requestId: UUID().uuidString,
            phase: .accepted,
            mode: requestMode,
            label: askOtherAIs ? "다른 AI 대행 요청을 Mac으로 전달하는 중" : "요청을 Mac으로 전달하는 중"
        )
        renderRevision += 1

        activeTask = Task { [weak self] in
            await self?.receiveAnswer(
                context: context,
                generation: generation,
                requestMode: requestMode,
                voiceReplies: voiceReplies
            )
        }
    }

    private func receiveAnswer(
        context: [ChatMessage],
        generation: ChatResponseGeneration,
        requestMode: ChatMode,
        voiceReplies: Bool
    ) async {
        let clock = ContinuousClock()
        var lastFlush = clock.now
        var answer = ""
        var finished = false
        let streamingSpeech = voiceReplies ? playback.beginStreamingResponse() : false

        do {
            let stream = try await streamRequest(context, requestMode)
            for try await event in stream {
                try Task.checkCancellation()
                guard isCurrent(generation) else { return }
                switch event {
                case .progress(let value):
                    progress = value
                    renderRevision += 1
                case .delta(let fragment):
                    answer += fragment
                    if streamingSpeech { playback.appendStreamingText(fragment) }
                    if progress?.phase != .generating {
                        progress = ChatProgress(
                            requestId: progress?.requestId ?? UUID().uuidString,
                            phase: .generating,
                            mode: progress?.mode ?? mode,
                            label: "응답을 받는 중"
                        )
                    }
                    if lastFlush.duration(to: clock.now) >= .milliseconds(40) {
                        publish(answer, for: generation)
                        lastFlush = clock.now
                    }
                case .finished:
                    finished = true
                }
            }
            guard finished, !answer.isEmpty else { throw LocalAIError.interrupted }
            guard isCurrent(generation),
                  let responseIndex = responseIndex(for: generation) else { return }
            publish(answer, for: generation)
            messages[responseIndex].deliveryState = .completed
            completeRequest(generation)
            if streamingSpeech { playback.finishStreamingResponse() }
        } catch {
            guard isCurrent(generation) else { return }
            if streamingSpeech { playback.stop() }
            let responseIndex = responseIndex(for: generation)
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                if let responseIndex {
                    messages[responseIndex].content = answer
                    messages[responseIndex].deliveryState = .cancelled
                    failedResponseID = messages[responseIndex].id
                }
            } else {
                if let responseIndex {
                    messages[responseIndex].content = answer
                    messages[responseIndex].deliveryState = .failed
                    failedResponseID = messages[responseIndex].id
                }
                errorMessage = error.localizedDescription
            }
            completeRequest(generation)
        }
    }

    private func publish(_ answer: String, for generation: ChatResponseGeneration) {
        guard isCurrent(generation), let index = responseIndex(for: generation) else { return }
        messages[index].content = answer
        renderRevision += 1
    }

    private func completeRequest(_ generation: ChatResponseGeneration) {
        guard isCurrent(generation) else { return }
        busy = false
        progress = nil
        activityStartedAt = nil
        activeResponseID = nil
        activeGeneration = nil
        activeTask = nil
        persist()
        renderRevision += 1
    }

    private func isCurrent(_ generation: ChatResponseGeneration) -> Bool {
        activeGeneration == generation && conversation.id == generation.conversationID
    }

    private func responseIndex(for generation: ChatResponseGeneration) -> Int? {
        guard isCurrent(generation) else { return nil }
        return messages.firstIndex(where: { $0.id == generation.responseID })
    }

    private func cancelActiveResponseForTransition() {
        guard let generation = activeGeneration else { return }
        activeTask?.cancel()
        playback.stop()

        if let index = responseIndex(for: generation) {
            if messages[index].content.isEmpty {
                messages.remove(at: index)
            } else {
                messages[index].deliveryState = .cancelled
            }
        }

        busy = false
        progress = nil
        activityStartedAt = nil
        activeResponseID = nil
        activeGeneration = nil
        activeTask = nil
        persist()
    }

    private func persist() {
        conversation.messages = messages
        conversation.mode = mode
        conversation.draft = text
        store.update(conversation)
        conversation = store.selected
    }
}

struct ChatView: View {
    @ObservedObject private var store: ConversationStore
    @StateObject private var model: ChatViewModel
    @ObservedObject private var inbox = ProactiveInbox.shared
    @ObservedObject private var playback = SpeechPlaybackController.shared
    @ObservedObject private var appRouter = AppRouter.shared
    @AppStorage("voiceReplies") private var voiceReplies = true
    @State private var showHistory = false
    @State private var showSettings = false
    @State private var autoScroll = true
    @FocusState private var composerFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let onRepairPairing: () -> Void

    init(store: ConversationStore, onRepairPairing: @escaping () -> Void) {
        self.store = store
        self.onRepairPairing = onRepairPairing
        _model = StateObject(wrappedValue: ChatViewModel(store: store))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.background.ignoresSafeArea()
                conversationBody
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomArea }
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showHistory = true } label: {
                        Image(systemName: "line.3.horizontal")
                            .font(.body.weight(.semibold))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("대화 목록")
                }
                ToolbarItem(placement: .principal) { modeMenu }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { appRouter.openCodex() } label: {
                        Image(systemName: "terminal.fill")
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Codex 작업")
                    .accessibilityHint("OpenAI Codex로 외부 전송할 계획을 검토하고 Face ID 또는 iPhone 암호로 승인하는 화면을 엽니다")
                    Button { model.newConversation() } label: {
                        Image(systemName: "square.and.pencil")
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("새 대화")
                    Button { showSettings = true } label: {
                        Image(systemName: "ellipsis.circle")
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("설정")
                }
            }
            .task {
                model.mergeInbox(inbox.messages)
                await model.start()
            }
            .onChange(of: inbox.messages) { _, messages in model.mergeInbox(messages) }
            .onChange(of: model.speech.transcript) { _, value in model.text = value }
            .onDisappear { model.saveDraft() }
            .sheet(isPresented: $showHistory) {
                ConversationListView(
                    store: store,
                    selectedID: store.selectedID,
                    onSelect: { conversation in
                        model.load(conversation)
                        showHistory = false
                    },
                    onNew: {
                        model.newConversation()
                        showHistory = false
                    },
                    onDelete: model.deleteConversation
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(
                    connection: model.connection,
                    approvalKeyState: model.approvalKeyState,
                    mode: Binding(get: { model.mode }, set: model.setMode),
                    playback: model.playback,
                    onRepairPairing: onRepairPairing
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $appRouter.showGrowthCenter) {
                GrowthCenterView(
                    approvalKeyState: model.approvalKeyState,
                    onRepairPairing: onRepairPairing
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $appRouter.showCodexTasks, onDismiss: {
                appRouter.clearCodexDraft()
            }) {
                CodexTaskFlowView(initialDraft: appRouter.pendingCodexDraft)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
        }
        .tint(AppTheme.accent)
    }

    private var conversationBody: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if model.messages.isEmpty {
                        welcome
                    } else {
                        ForEach(model.messages) { message in
                            MessageRow(
                                message: message,
                                progress: message.id == model.activeResponseID ? model.progress : nil,
                                onCopy: { UIPasteboard.general.string = message.content },
                                onSpeak: { model.speak(message) },
                                onRegenerate: { model.regenerate(responseID: message.id, voiceReplies: voiceReplies) }
                            )
                            .id(message.id)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(
                DragGesture(minimumDistance: 8).onChanged { value in
                    if value.translation.height > 8 { autoScroll = false }
                }
            )
            .onChange(of: model.renderRevision) { _, _ in
                guard autoScroll else { return }
                if reduceMotion {
                    proxy.scrollTo("bottom", anchor: .bottom)
                } else {
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !autoScroll {
                    Button {
                        autoScroll = true
                        if reduceMotion {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        } else {
                            withAnimation(.easeOut(duration: 0.18)) {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.subheadline.weight(.semibold))
                            .frame(width: 44, height: 44)
                            .background(.regularMaterial, in: Circle())
                            .shadow(radius: 8, y: 3)
                    }
                    .padding(14)
                    .accessibilityLabel("최신 메시지로 이동")
                }
            }
        }
    }

    private var modeMenu: some View {
        Menu {
            Picker("처리 방식", selection: Binding(get: { model.mode }, set: model.setMode)) {
                ForEach(ChatMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.symbol).tag(mode)
                }
            }
        } label: {
            VStack(spacing: 1) {
                Text("로컬AI")
                    .font(.headline)
                HStack(spacing: 4) {
                    Image(systemName: connectionSymbol)
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(connectionColor)
                    Text(model.busy ? (model.progress?.label ?? "처리 중") : model.mode.title)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                }
                .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("로컬AI")
        .accessibilityValue(model.busy ? (model.progress?.label ?? "처리 중") : "\(model.mode.title), \(model.connection.title)")
        .accessibilityHint("처리 방식을 변경하려면 이중 탭하세요")
    }

    private var connectionSymbol: String {
        if differentiateWithoutColor {
            return model.connection == .connected ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
        }
        return "circle.fill"
    }

    private var connectionColor: Color {
        model.connection == .connected ? AppTheme.accent : .orange
    }

    private var welcome: some View {
        VStack(spacing: 20) {
            Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 20 : 42)
            ZStack {
                Circle().fill(AppTheme.accentGradient).frame(width: 58, height: 58)
                Image(systemName: "sparkles")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(AppTheme.onAccent)
            }
            VStack(spacing: 8) {
                Text("무엇을 도와드릴까요?")
                    .font(.title2.weight(.semibold))
                Text("기본은 Mac 로컬이 답합니다. 다른 AI에게 대신 물어보려면 보내기 전 체크하세요.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 22)
            }
            LazyVGrid(columns: suggestionColumns, spacing: 10) {
                suggestion("집 상태 확인", symbol: "house")
                suggestion("오늘 할 일", symbol: "checklist")
                suggestion("문제 점검", symbol: "wrench.and.screwdriver")
                suggestion("자유롭게 대화", symbol: "bubble.left.and.bubble.right")
            }
            .padding(.horizontal, 16)
            Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 24 : 52)
        }
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
    }

    private var suggestionColumns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.flexible()), GridItem(.flexible())]
    }

    private func suggestion(_ title: String, symbol: String) -> some View {
        Button {
            model.text = title
            model.send(voiceReplies: voiceReplies)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol).foregroundStyle(AppTheme.accent)
                Text(title).foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .font(.body.weight(.medium))
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(AppTheme.secondaryBackground, in: RoundedRectangle(cornerRadius: 15))
        }
        .buttonStyle(.plain)
    }

    private var bottomArea: some View {
        VStack(spacing: 0) {
            if let error = model.errorMessage {
                errorBanner(error)
            }
            if model.busy, let progress = model.progress {
                ActivityBar(progress: progress, startedAt: model.activityStartedAt)
            }
            if playback.isSpeaking || playback.remoteState != nil {
                SpeechActivityBar(
                    label: playback.remoteState ?? "음성 재생 중",
                    onStop: model.stopSpeaking
                )
            }
            Toggle(isOn: $model.askOtherAIs) {
                Text("다른 AI에게 대신 물어보기")
                    .font(.footnote.weight(.semibold))
            }
            .toggleStyle(.switch)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .accessibilityHint("켜야만 다른 AI에게 대신 물어봅니다. 자동으로 켜지지 않습니다.")
            .disabled(model.busy)
            composer
        }
        .background(.bar)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.footnote).lineLimit(2)
            Spacer()
            if model.canRetry {
                Button("재시도") { model.retry(voiceReplies: voiceReplies) }
                    .font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.orange.opacity(0.1))
        .accessibilityElement(children: .combine)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 9) {
            Button {
                model.stopSpeaking()
                Task { await model.speech.toggle() }
            } label: {
                Image(systemName: model.speech.isListening ? "waveform" : "mic")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 46, height: 46)
                    .foregroundStyle(model.speech.isListening ? .white : AppTheme.accent)
                    .background(model.speech.isListening ? Color.red : AppTheme.secondaryBackground, in: Circle())
            }
            .disabled(model.busy)
            .accessibilityLabel(model.speech.isListening ? "음성 입력 중지" : "음성 입력")
            .accessibilityHint(model.speech.isListening ? "현재 받아쓰기를 끝냅니다" : "말한 내용을 메시지 입력란에 받아씁니다")

            TextField(model.speech.isListening ? "듣는 중…" : "메시지", text: $model.text, axis: .vertical)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(AppTheme.secondaryBackground, in: RoundedRectangle(cornerRadius: 22))
                .submitLabel(.send)
                .disabled(model.busy)
                .onSubmit {
                    guard canSend else { return }
                    model.send(voiceReplies: voiceReplies)
                }

            Button {
                if model.busy { model.stopGeneration() }
                else { model.send(voiceReplies: voiceReplies) }
            } label: {
                Image(systemName: model.busy ? "stop.fill" : "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .frame(width: 46, height: 46)
                    .foregroundStyle(canSend || model.busy ? AppTheme.onAccent : .secondary)
                    .background(canSend || model.busy ? AnyShapeStyle(AppTheme.accentGradient) : AnyShapeStyle(AppTheme.secondaryBackground), in: Circle())
            }
            .disabled(!model.busy && !canSend)
            .accessibilityLabel(model.busy ? "응답 중지" : "메시지 보내기")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private var canSend: Bool {
        !model.busy && !model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private struct SpeechActivityBar: View {
    let label: String
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "waveform")
                .foregroundStyle(AppTheme.accent)
                .accessibilityHidden(true)
            Text(label)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
            Spacer()
            Button("정지", action: onStop)
                .font(.footnote.weight(.semibold))
                .accessibilityLabel("음성 재생 정지")
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 9)
        .background(AppTheme.secondaryBackground.opacity(0.92))
        .accessibilityElement(children: .contain)
    }
}

private struct MessageRow: View {
    let message: ChatMessage
    let progress: ChatProgress?
    let onCopy: () -> Void
    let onSpeak: () -> Void
    let onRegenerate: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var avatarSize = 30

    var body: some View {
        if message.role == .user { userRow }
        else { assistantRow }
    }

    private var userRow: some View {
        HStack {
            Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 16 : 58)
            Text(message.content)
                .font(.body)
                .textSelection(.enabled)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(AppTheme.secondaryBackground, in: RoundedRectangle(cornerRadius: 19))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .contextMenu { Button("복사", systemImage: "doc.on.doc", action: onCopy) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("나")
        .accessibilityValue(message.content)
        .accessibilityAction(named: "복사", onCopy)
    }

    private var assistantRow: some View {
        HStack(alignment: .top, spacing: 11) {
            ZStack {
                Circle().fill(AppTheme.accentGradient)
                    .frame(width: min(avatarSize, 40), height: min(avatarSize, 40))
                Image(systemName: "sparkles")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.onAccent)
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 10) {
                if message.content.isEmpty, let progress {
                    InlineProgress(progress: progress)
                } else {
                    if message.deliveryState == .streaming {
                        Text(message.content)
                            .font(.body)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        MarkdownMessageView(source: message.content)
                    }
                    if message.deliveryState == .streaming, let progress {
                        InlineProgress(progress: progress)
                    }
                }

                if message.deliveryState == .cancelled {
                    Label("응답이 중단됨", systemImage: "stop.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if message.deliveryState == .failed {
                    Label("응답 중 오류", systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if !message.content.isEmpty && message.deliveryState != .streaming {
                    HStack(spacing: 2) {
                        actionButton("복사", symbol: "doc.on.doc", action: onCopy)
                        actionButton("읽기", symbol: "speaker.wave.2", action: onSpeak)
                        actionButton("다시 생성", symbol: "arrow.clockwise", action: onRegenerate)
                    }
                }
            }
            Spacer(minLength: 6)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .contextMenu {
            if !message.content.isEmpty {
                Button("복사", systemImage: "doc.on.doc", action: onCopy)
                Button("읽어주기", systemImage: "speaker.wave.2", action: onSpeak)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "답변 복사", onCopy)
        .accessibilityAction(named: "답변 읽어주기", onSpeak)
    }

    private func actionButton(_ label: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.subheadline)
                .frame(width: 44, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel(label)
    }
}

private struct InlineProgress: View {
    let progress: ChatProgress

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(progress.label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityHidden(true)
    }
}

private struct ActivityBar: View {
    let progress: ChatProgress
    let startedAt: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 9) {
                ProgressView().controlSize(.small)
                Text(progress.label)
                    .font(.footnote.weight(.medium))
                Spacer()
                if let startedAt {
                    Text(elapsed(from: startedAt, to: context.date))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 9)
            .background(AppTheme.secondaryBackground.opacity(0.92))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("현재 처리 상태")
        .accessibilityValue(progress.label)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private func elapsed(from start: Date, to end: Date) -> String {
        let seconds = max(0, Int(end.timeIntervalSince(start)))
        return seconds < 60 ? "\(seconds)초" : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

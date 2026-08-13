import AVFoundation
import SwiftUI
import UIKit

struct SettingsView: View {
    let connection: ConnectionState
    let approvalKeyState: ApprovalKeyState
    @Binding var mode: ChatMode
    @ObservedObject var playback: SpeechPlaybackController
    let onRepairPairing: () -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage("voiceReplies") private var voiceReplies = true
    @AppStorage("speakProactiveMessages") private var speakProactiveMessages = false
    @State private var showGrowthCenter = false
    @State private var confirmRepairPairing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("일상 잡담은 Telegram으로 해도 됩니다. 개인정보·기억 확인·아이폰/맥 제어·대행 질문은 이 앱 또는 맥 로컬 웹만 사용하세요.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("일상 대화 입구") {
                    NavigationLink {
                        CommunicationSecuritySettingsView()
                    } label: {
                        Label("Telegram 일반 대화 연결", systemImage: "paperplane.fill")
                    }
                    .accessibilityHint("짧은 일상 대화용입니다. 기기 제어와 개인정보는 이 앱에서 하세요")
                    Text("Telegram → Mac 로컬 모델만. 도구·승인·기억 확인은 막혀 있습니다.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("처리 방식") {
                    Picker("기본 모드", selection: $mode) {
                        ForEach(ChatMode.allCases) { item in
                            Label(item.title, systemImage: item.symbol).tag(item)
                        }
                    }
                    .pickerStyle(.menu)
                    Text(mode.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("음성") {
                    NavigationLink {
                        VoiceSettingsView(playback: playback)
                    } label: {
                        Label("목소리 선택과 미리듣기", systemImage: "waveform")
                    }
                    Toggle(isOn: $voiceReplies) {
                        Label("답변 자동으로 읽기", systemImage: "speaker.wave.2")
                    }
                    Toggle(isOn: $speakProactiveMessages) {
                        Label("먼저 온 소식 읽기", systemImage: "bell.and.waves.left.and.right")
                    }
                }

                Section("연결") {
                    statusRow(
                        title: "Mac 직접 연결",
                        value: connectionValue,
                        symbol: connection == .connected ? "lock.shield.fill" : "wifi.exclamationmark",
                        color: connection == .connected ? .green : .orange
                    )
                    statusRow(
                        title: "iPhone 승인 키",
                        value: approvalKeyState.title,
                        symbol: approvalKeyState == .ready ? "key.fill" : "key.slash.fill",
                        color: approvalKeyState == .ready ? .green : .orange
                    )
                    statusRow(title: "외부 공개", value: "꺼짐", symbol: "network.slash", color: .green)
                    statusRow(title: "전송 경로", value: "Tailscale 전용", symbol: "point.3.connected.trianglepath.dotted", color: .blue)
                    if approvalKeyState == .repairRequired {
                        Button("승인 연결 다시 페어링") { confirmRepairPairing = true }
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    statusRow(title: "일반 대화", value: "Mac 내부 처리", symbol: "house.fill", color: .green)
                    statusRow(title: "다른 AI 대행", value: "채팅 체크 + 필요 시 승인", symbol: "hand.raised.fill", color: .orange)
                    NavigationLink {
                        ConfirmedMemorySettingsView()
                    } label: {
                        Label("개인 기억 (확인 후 저장)", systemImage: "lock.fill")
                    }
                    .accessibilityHint("후보를 확인해야 장기기억에 들어갑니다")
                } header: {
                    Text("개인정보 보호")
                }

                Section("고급 (제어·승인·자동화)") {
                    NavigationLink {
                        CommunicationSecuritySettingsView()
                    } label: {
                        Label("Chrome 공유 · 통신 상세", systemImage: "network.badge.shield.half.filled")
                    }
                    .accessibilityHint("로그인된 웹 작업용 Chrome 공유는 고급 설정입니다")

                    Button { showGrowthCenter = true } label: {
                        Label(
                            approvalKeyState == .repairRequired ? "보안 승인 (재연결 필요)" : "보안 승인 · Codex · 성장",
                            systemImage: "checkmark.shield.fill"
                        )
                    }
                    .accessibilityHint("Codex와 성장 파이프라인은 고급 기능입니다")

                    Text("아이폰/맥 제어, 파일, 결제, Codex는 Telegram이 아니라 이 앱에서만 합니다.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    HStack {
                        Text("앱 버전")
                        Spacer()
                        Text(appVersion).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("설정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("완료") { dismiss() } }
            }
            .sheet(isPresented: $showGrowthCenter) {
                GrowthCenterView(
                    approvalKeyState: approvalKeyState,
                    onRepairPairing: onRepairPairing
                )
            }
            .confirmationDialog(
                "승인 연결을 다시 설정할까요?",
                isPresented: $confirmRepairPairing,
                titleVisibility: .visible
            ) {
                Button("다시 페어링", role: .destructive) {
                    playback.stop()
                    dismiss()
                    onRepairPairing()
                }
                Button("취소", role: .cancel) {}
            } message: {
                Text("현재 연결 토큰만 지우고 Mac과 새 승인 키를 등록합니다. 이 iPhone의 대화 내용은 지우지 않습니다.")
            }
        }
    }

    private var connectionValue: String {
        switch connection {
        case .checking: return "확인 중"
        case .connected, .thinking: return "연결됨"
        case .disconnected: return "연결 끊김"
        }
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    private func statusRow(title: String, value: String, symbol: String, color: Color) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                statusLabel(title: title, symbol: symbol, color: color)
                Spacer()
                statusValue(value)
            }
            VStack(alignment: .leading, spacing: 4) {
                statusLabel(title: title, symbol: symbol, color: color)
                statusValue(value)
                    .padding(.leading, 36)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func statusLabel(title: String, symbol: String, color: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 24)
            Text(title)
        }
    }

    private func statusValue(_ value: String) -> some View {
        Text(value)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
    }
}

struct ConfirmedMemorySettingsView: View {
    @State private var snapshot: ConfirmedMemorySnapshot?
    @State private var draft = ""
    @State private var loading = true
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var infoMessage: String?

    var body: some View {
        List {
            Section {
                Text("맥 웹과 같은 공통 기억입니다. 후보를 확인해야만 대화에 쓰입니다.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let snapshot {
                    Text("활성 \(snapshot.count)개 · 후보 \(snapshot.candidates.count)개")
                        .font(.subheadline.weight(.semibold))
                }
            }

            Section("새 기억 후보") {
                TextField("예: 커피는 아이스로", text: $draft, axis: .vertical)
                    .lineLimit(2...4)
                    .disabled(busy)
                Button("후보로 넣기") {
                    Task { await propose() }
                }
                .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let candidates = snapshot?.candidates, !candidates.isEmpty {
                Section("확인 대기") {
                    ForEach(candidates) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.text)
                            Button("장기기억으로 확인") {
                                Task { await confirm(item.id) }
                            }
                            .disabled(busy)
                        }
                    }
                }
            }

            if let active = snapshot?.active, !active.isEmpty {
                Section("활성 기억") {
                    ForEach(active) { item in
                        Text(item.text)
                    }
                }
            }

            if let infoMessage {
                Section {
                    Text(infoMessage).foregroundStyle(.secondary)
                }
            }
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.orange)
                }
            }
        }
        .navigationTitle("개인 기억")
        .refreshable { await reload() }
        .task { await reload() }
        .overlay {
            if loading {
                ProgressView("불러오는 중")
            }
        }
    }

    private func reload() async {
        loading = snapshot == nil
        errorMessage = nil
        defer { loading = false }
        do {
            snapshot = try await LocalAIClient.shared.fetchConfirmedMemory()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func propose() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await LocalAIClient.shared.proposeConfirmedMemory(text)
            draft = ""
            infoMessage = "후보로 저장했습니다. 아래에서 확인하세요."
            await reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func confirm(_ id: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await LocalAIClient.shared.confirmConfirmedMemory(id: id)
            infoMessage = "장기기억에 넣었습니다. 아이폰·맥 대화에 함께 쓰입니다."
            await reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct CommunicationSecuritySettingsView: View {
    @State private var status: CommunicationStatus?
    @State private var loading = true
    @State private var configuringTelegram = false
    @State private var telegramToken = ""
    @State private var errorMessage: String?
    @State private var confirmationMessage: String?
    @FocusState private var tokenFieldFocused: Bool

    var body: some View {
        List {
            policySection
            codexSection
            telegramSection
            browserSection
        }
        .navigationTitle("통신 및 웹 작업")
        .navigationBarTitleDisplayMode(.inline)
        .task { await refreshStatus() }
        .refreshable { await refreshStatus() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await refreshStatus() }
                } label: {
                    if loading {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(loading || configuringTelegram)
                .accessibilityLabel("통신 상태 새로고침")
            }
        }
        .alert("통신 설정 오류", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("확인", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "알 수 없는 오류")
        }
    }

    private var codexSection: some View {
        Section {
            communicationStatusRow(
                title: "Codex Worker",
                value: codexStatusValue,
                symbol: status?.codexBridge?.running == true ? "terminal.fill" : "terminal",
                color: status?.codexBridge?.running == true ? .green : .orange
            )
            Label("OpenAI 외부 전송 계획 확인 → Face ID 또는 iPhone 암호 승인 → 격리 실행 → 결과 수신 순서로만 동작합니다.", systemImage: "checkmark.shield.fill")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Label("Mac 원본 소스는 읽기 전용이며 변경하지 않습니다. 초안은 격리 복사본에만 임시 적용해 검증합니다.", systemImage: "doc.badge.shield.checkmark")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Label("격리 복사본은 완료 후 자동 정리하고, 실패 시 worker 시작 때 다시 정리를 시도합니다.", systemImage: "arrow.clockwise")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Label("종료된 작업과 검증 초안은 로컬 Mac에 7일 또는 최근 100개 중 먼저 도달한 한도까지 보존합니다.", systemImage: "clock")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } header: {
            Text("Codex 연결")
        } footer: {
            Text("표시된 작업문과 허용 목록 코드에서 알려진 식별자를 검사·치환한 복사본은 OpenAI Codex로 전송됩니다. 모델에는 추가 인터넷 도구와 Mac 원본 파일 도구를 제공하지 않습니다. 로컬 Codex 클라이언트는 기존 Codex 로그인 인증을 사용하며 별도 OS 프로세스 샌드박스는 현재 없습니다.")
        }
    }

    private var policySection: some View {
        Section {
            communicationStatusRow(
                title: "Telegram",
                value: "일반 대화만",
                symbol: "bubble.left.and.bubble.right.fill",
                color: .green
            )
            communicationStatusRow(
                title: "OpenAI Codex",
                value: "이 앱 승인 전용",
                symbol: "checkmark.shield.fill",
                color: AppTheme.accent
            )
            communicationStatusRow(
                title: "중요 지시",
                value: "이 앱에서만",
                symbol: "iphone.gen3.badge.play",
                color: AppTheme.accent
            )
            communicationStatusRow(
                title: "보호 작업",
                value: privilegedIngressValue,
                symbol: "checkmark.shield.fill",
                color: privilegedIngressColor
            )
        } header: {
            Text("보안 경계")
        } footer: {
            Text("역할 분리: Telegram = 일상 잡담·상태 확인. 이 앱/맥 웹 = 개인정보·기억 확인·아이폰·맥 연동 제어. Codex 외부 전송·실행, 로그인된 웹 작업, 이메일, 파일, 집 제어, 구매, 인증정보가 필요한 지시는 Telegram이 아니라 이 앱에서만 가능합니다.")
        }
    }

    private var telegramSection: some View {
        Section {
            communicationStatusRow(
                title: "현재 상태",
                value: telegramStatusValue,
                symbol: telegramStatusSymbol,
                color: telegramStatusColor
            )

            if let username = status?.telegram.botUsername, !username.isEmpty {
                communicationStatusRow(
                    title: "연결된 봇",
                    value: "@\(username)",
                    symbol: "at",
                    color: .blue
                )
            }

            SecureField("새 Bot Token", text: $telegramToken)
                .focused($tokenFieldFocused)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .privacySensitive()
                .disabled(configuringTelegram)
                .accessibilityHint("BotFather에서 받은 새 Telegram Bot Token을 입력합니다")

            HStack(spacing: 12) {
                Button {
                    pasteTelegramToken()
                } label: {
                    Label("붙여넣기", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(.bordered)
                .disabled(configuringTelegram)

                Button {
                    Task { await submitTelegramToken() }
                } label: {
                    if configuringTelegram {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("연결 중")
                        }
                    } else {
                        Text(status?.telegram.configured == true ? "새 토큰 적용" : "연결")
                    }
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .disabled(!telegramTokenIsValid || configuringTelegram)
            }

            if let confirmationMessage {
                Label(confirmationMessage, systemImage: "checkmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.green)
            }

            if let blockedSummary {
                Text("Telegram에서 차단: \(blockedSummary)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Telegram 일반 대화")
        } footer: {
            Text("토큰은 이 앱에 저장하지 않습니다. 전송을 시작하면 입력란을 즉시 비우고, Mac의 Keychain에서만 보관합니다. 새 토큰을 적용하면 Telegram의 대기 메시지도 폐기됩니다.")
        }
    }

    private var browserSection: some View {
        Section {
            communicationStatusRow(
                title: "Chrome 공유 탭",
                value: browserStatusValue,
                symbol: status?.browser.connected == true ? "checkmark.circle.fill" : "rectangle.stack.badge.plus",
                color: status?.browser.connected == true ? .green : .orange
            )

            if status?.browser.connected == true {
                Label("공유를 켠 탭만 로컬 AI가 볼 수 있습니다.", systemImage: "eye.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Label("Mac의 Chrome에서 사용할 탭을 연 뒤 OpenClaw 확장 프로그램으로 공유하세요.", systemImage: "puzzlepiece.extension")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            communicationStatusRow(
                title: "작업 정책",
                value: webTaskStageValue,
                symbol: "list.bullet.clipboard.fill",
                color: status?.webTasks == nil ? .secondary : .blue
            )

            if let actions = status?.webTasks?.preparedActions, !actions.isEmpty {
                Text("준비된 작업: \(preparedActionLabels(actions))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("웹 작업")
        } footer: {
            Text("Chrome 로그인 상태는 브라우저에 그대로 남고, Local AI에는 명시적으로 공유한 탭의 상태만 연결됩니다. 로그인된 웹 작업 지시는 Telegram이 아니라 이 앱에서 내려야 합니다.")
        }
    }

    private var telegramTokenIsValid: Bool {
        normalizedTelegramToken.range(
            of: #"^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$"#,
            options: .regularExpression
        ) != nil
    }

    private var normalizedTelegramToken: String {
        telegramToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var telegramStatusValue: String {
        guard let telegram = status?.telegram else { return loading ? "확인 중" : "미확인" }
        if telegram.running { return "연결됨 · 일반 대화만" }
        if telegram.configured && telegram.enabled { return "설정됨 · 시작 대기" }
        return "연결 안 됨"
    }

    private var codexStatusValue: String {
        guard let bridge = status?.codexBridge else { return loading ? "확인 중" : "미확인" }
        if bridge.running { return "연결됨 · 격리 실행" }
        if bridge.configured && bridge.enabled { return "설정됨 · 시작 대기" }
        return "연결 안 됨"
    }

    private var telegramStatusSymbol: String {
        status?.telegram.running == true ? "paperplane.circle.fill" : "paperplane.circle"
    }

    private var telegramStatusColor: Color {
        guard status != nil else { return .secondary }
        return status?.telegram.running == true ? .green : .orange
    }

    private var privilegedIngressValue: String {
        guard let status else { return loading ? "확인 중" : "미확인" }
        return status.privilegedIngress == "local_owner_app_only" ? "소유자 앱만" : "정책 확인 필요"
    }

    private var privilegedIngressColor: Color {
        guard let status else { return .secondary }
        return status.privilegedIngress == "local_owner_app_only" ? .green : .red
    }

    private var browserStatusValue: String {
        guard let browser = status?.browser else { return loading ? "확인 중" : "미확인" }
        guard browser.connected else { return "공유 안 됨" }
        return "연결됨 · \(browser.sharedTabs)개 탭"
    }

    private var webTaskStageValue: String {
        switch status?.webTasks?.stage {
        case "shared_tabs_required": return "준비됨 · 탭 공유 필요"
        case "live_ui_validation_required": return "탭 연결됨 · 화면 검증 필요"
        case "ready": return "사용 가능"
        case .some(_): return "정책 확인 필요"
        case .none: return "서버 업데이트 필요"
        }
    }

    private func preparedActionLabels(_ actions: [String]) -> String {
        let labels = [
            "coupang.search": "쿠팡 검색",
            "coupang.cart.add": "장바구니 추가",
            "mail.important.list": "중요 메일 목록",
            "mail.message.read": "메일 읽기",
        ]
        return actions.map { labels[$0] ?? $0 }.joined(separator: " · ")
    }

    private var blockedSummary: String? {
        guard let blocked = status?.blockedInTelegram, !blocked.isEmpty else { return nil }
        let labels = [
            "authenticated_web": "로그인 웹 작업",
            "email": "이메일",
            "files": "파일",
            "home_control": "집 제어",
            "purchases": "구매",
            "credentials": "인증정보",
        ]
        return blocked.map { labels[$0] ?? $0 }.joined(separator: " · ")
    }

    private func communicationStatusRow(title: String, value: String, symbol: String, color: Color) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                Label(title, systemImage: symbol)
                    .foregroundStyle(color)
                Spacer()
                Text(value)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }
            VStack(alignment: .leading, spacing: 5) {
                Label(title, systemImage: symbol)
                    .foregroundStyle(color)
                Text(value)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 30)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @MainActor
    private func refreshStatus() async {
        loading = true
        defer { loading = false }
        do {
            status = try await LocalAIClient.shared.fetchCommunicationStatus()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func submitTelegramToken() async {
        guard telegramTokenIsValid, !configuringTelegram else { return }
        var transientToken = normalizedTelegramToken
        telegramToken.removeAll(keepingCapacity: false)
        tokenFieldFocused = false
        confirmationMessage = nil
        configuringTelegram = true
        defer {
            transientToken.removeAll(keepingCapacity: false)
            telegramToken.removeAll(keepingCapacity: false)
            configuringTelegram = false
        }

        do {
            let result = try await LocalAIClient.shared.configureTelegram(botToken: transientToken)
            if UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) == transientToken {
                UIPasteboard.general.string = ""
            }
            confirmationMessage = "@\(result.botUsername) 연결 완료 · 일반 대화만 허용"
            status = try await LocalAIClient.shared.fetchCommunicationStatus()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func pasteTelegramToken() {
        guard let value = UIPasteboard.general.string else { return }
        telegramToken.removeAll(keepingCapacity: false)
        telegramToken = value.trimmingCharacters(in: .whitespacesAndNewlines)
        confirmationMessage = nil
        tokenFieldFocused = true
    }
}

struct VoiceSettingsView: View {
    @ObservedObject var playback: SpeechPlaybackController
    @AppStorage("speechVoiceIdentifier") private var selectedVoice = ""
    @AppStorage("speechProviderID") private var speechProviderID = "apple-avspeech-device"
    @AppStorage("speechRate") private var speechRate = 0.44
    @AppStorage("speechPitch") private var speechPitch = 0.97
    @State private var voices = SpeechOutput.koreanVoices
    @State private var catalog: TTSCatalog?
    @State private var catalogLoading = false
    @State private var catalogError: String?

    var body: some View {
        List {
            Section("음성 엔진") {
                providerRow(
                    id: "apple-avspeech-device",
                    name: "iPhone 고품질 음성",
                    detail: "인터넷 전송 없이 이 iPhone에서 재생",
                    symbol: "iphone.gen3",
                    available: true,
                    preview: {
                        guard let voiceID = voices.first?.id else { return }
                        playback.preview(voiceIdentifier: voiceID, rate: speechRate, pitch: speechPitch)
                    }
                )

                if let qwenProvider {
                    providerRow(
                        id: qwenProvider.id,
                        name: qwenProvider.displayName,
                        detail: providerDetail(qwenProvider),
                        symbol: "waveform.badge.sparkles",
                        available: qwenProvider.availability.state == "available",
                        preview: { playback.previewLocalVoice() }
                    )
                } else if catalogLoading {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Mac 신경망 음성 확인 중")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    HStack(spacing: 12) {
                        Image(systemName: "waveform.badge.exclamationmark")
                            .foregroundStyle(.secondary)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Mac 신경망 음성")
                            Text(catalogError ?? "현재 사용할 수 없음")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("다시 확인") { Task { await loadCatalog() } }
                            .font(.footnote.weight(.semibold))
                    }
                }
            }

            Section {
                voiceRow(
                    id: "",
                    name: "가장 자연스러운 음성",
                    detail: "iPhone에 설치된 최고 품질을 자동 선택",
                    previewID: voices.first?.id
                )
            }

            Section("iPhone 한국어 음성") {
                if voices.isEmpty {
                    ContentUnavailableView(
                        "한국어 음성 없음",
                        systemImage: "speaker.slash",
                        description: Text("iPhone 설정에서 한국어 음성을 설치한 뒤 다시 열어주세요.")
                    )
                } else {
                    ForEach(voices) { voice in
                        voiceRow(
                            id: voice.id,
                            name: voice.name,
                            detail: qualityLabel(voice.quality),
                            previewID: voice.id
                        )
                    }
                }
            }

            Section("말하기 조절") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text("속도"); Spacer(); Text(String(format: "%.2f", speechRate)).foregroundStyle(.secondary) }
                    Slider(value: $speechRate, in: 0.36...0.55, step: 0.01)
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text("음높이"); Spacer(); Text(String(format: "%.2f", speechPitch)).foregroundStyle(.secondary) }
                    Slider(value: $speechPitch, in: 0.85...1.15, step: 0.01)
                }
                Button("기본값으로 되돌리기") {
                    speechRate = 0.44
                    speechPitch = 0.97
                }
            }

        }
        .navigationTitle("목소리")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { playback.stop() }
        .task {
            guard !AppRuntime.isVisualTest else { return }
            await loadCatalog()
        }
        .toolbar {
            if playback.isSpeaking {
                ToolbarItem(placement: .primaryAction) {
                    Button("정지") { playback.stop() }
                }
            }
        }
    }

    @ViewBuilder
    private func voiceRow(id: String, name: String, detail: String, previewID: String?) -> some View {
        let isSelected = speechProviderID != "qwen3-tts-local" && selectedVoice == id
        HStack(spacing: 12) {
            Button {
                VoiceProviderRecommendationMigration.markUserSelection()
                speechProviderID = "apple-avspeech-device"
                selectedVoice = id
            } label: {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .frame(width: 44, height: 44)
                    .foregroundStyle(isSelected ? AppTheme.accent : .secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(name) 선택")

            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                guard let previewID else { return }
                if playback.previewingVoiceID == previewID { playback.stop() }
                else { playback.preview(voiceIdentifier: previewID, rate: speechRate, pitch: speechPitch) }
            } label: {
                Image(systemName: playback.previewingVoiceID == previewID ? "stop.fill" : "play.fill")
                    .frame(width: 44, height: 44)
                    .background(AppTheme.secondaryBackground, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(previewID == nil)
            .accessibilityLabel(playback.previewingVoiceID == previewID ? "미리듣기 정지" : "\(name) 미리듣기")
        }
        .contentShape(Rectangle())
        .onTapGesture {
            VoiceProviderRecommendationMigration.markUserSelection()
            speechProviderID = "apple-avspeech-device"
            selectedVoice = id
        }
    }

    @ViewBuilder
    private func providerRow(
        id: String,
        name: String,
        detail: String,
        symbol: String,
        available: Bool,
        preview: @escaping () -> Void
    ) -> some View {
        let isSelected = speechProviderID == id
        let isPreviewing = id == "qwen3-tts-local"
            ? playback.previewingVoiceID == "qwen3-sohee"
            : playback.previewingVoiceID != nil && playback.previewingVoiceID != "qwen3-sohee"
        HStack(spacing: 12) {
            Button {
                guard available else { return }
                VoiceProviderRecommendationMigration.markUserSelection()
                speechProviderID = id
            } label: {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .frame(width: 44, height: 44)
                    .foregroundStyle(isSelected ? AppTheme.accent : .secondary)
            }
            .buttonStyle(.plain)
            .disabled(!available)
            .accessibilityLabel("\(name) 선택")

            Image(systemName: symbol)
                .foregroundStyle(available ? AppTheme.accent : .secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                if isPreviewing { playback.stop() }
                else { preview() }
            } label: {
                Image(systemName: isPreviewing ? "stop.fill" : "play.fill")
                    .frame(width: 44, height: 44)
                    .background(AppTheme.secondaryBackground, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!available)
            .accessibilityLabel(isPreviewing ? "미리듣기 정지" : "\(name) 미리듣기")
        }
        .opacity(available ? 1 : 0.72)
    }

    private var qwenProvider: TTSCatalog.Provider? {
        catalog?.providers.first(where: { $0.id == "qwen3-tts-local" })
    }

    private func providerDetail(_ provider: TTSCatalog.Provider) -> String {
        switch provider.availability.state {
        case "available": return "Mac에서만 생성 · 실시간 스트리밍"
        case "unavailable": return "모델 설치 전 · iPhone 음성으로 자동 전환"
        default: return "현재 상태를 확인할 수 없음"
        }
    }

    @MainActor
    private func loadCatalog() async {
        catalogLoading = true
        defer { catalogLoading = false }
        do {
            catalog = try await LocalAIClient.shared.fetchTTSCatalog()
            catalogError = nil
            if let catalog { VoiceProviderRecommendationMigration.apply(catalog: catalog) }
        } catch {
            catalogError = "Mac 음성 상태를 확인하지 못했습니다"
        }
    }

    private func qualityLabel(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .premium: return "Premium · iPhone 로컬"
        case .enhanced: return "Enhanced · iPhone 로컬"
        default: return "기본 · iPhone 로컬"
        }
    }
}

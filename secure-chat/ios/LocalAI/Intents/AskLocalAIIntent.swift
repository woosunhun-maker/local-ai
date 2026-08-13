import AppIntents

struct AskLocalAIIntent: AppIntent {
    static let title: LocalizedStringResource = "로컬 AI에게 묻기"
    static let description = IntentDescription("Mac에서 실행 중인 나의 로컬 AI에게 안전하게 질문합니다.")

    @Parameter(title: "질문")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("로컬 AI에게 \(\.$question) 묻기")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let answer = try await LocalAIClient.shared.ask(question)
        return .result(dialog: IntentDialog(stringLiteral: answer))
    }
}

struct CheckLocalAIInboxIntent: AppIntent {
    static let title: LocalizedStringResource = "로컬 AI 소식 확인"
    static let description = IntentDescription("로컬 AI가 먼저 보낸 안전한 메시지를 확인합니다.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let messages = try await LocalAIClient.shared.fetchInbox()
        let answer = messages.isEmpty ? "새로운 소식이 없습니다." : messages.map(\.content).joined(separator: "\n")
        return .result(dialog: IntentDialog(stringLiteral: answer))
    }
}

struct RunLocalAITaskIntent: AppIntent {
    static let title: LocalizedStringResource = "로컬 AI에게 작업 시키기"
    static let description = IntentDescription("작업문과 허용 목록 코드에서 알려진 식별자를 검사·치환한 복사본을 OpenAI Codex로 보내 점검 또는 격리 변경 초안을 요청합니다.")
    static let openAppWhenRun = true

    @Parameter(title: "작업")
    var command: String

    static var parameterSummary: some ParameterSummary {
        Summary("로컬 AI에게 \(\.$command) 시키기")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        AppRouter.shared.openCodex(draft: command)
        return .result(dialog: "앱에서 OpenAI Codex 외부 전송 내용을 포함한 정확한 작업 계획을 확인한 뒤 Face ID 또는 iPhone 암호로 승인해주세요.")
    }
}

struct LocalAIShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskLocalAIIntent(),
            phrases: [
                "\(.applicationName)에게 물어봐",
                "\(.applicationName)와 대화하기",
            ],
            shortTitle: "로컬 AI에게 묻기",
            systemImageName: "waveform.and.mic"
        )
        AppShortcut(
            intent: CheckLocalAIInboxIntent(),
            phrases: [
                "\(.applicationName) 소식 확인",
                "\(.applicationName)이 보낸 말 확인",
            ],
            shortTitle: "로컬 AI 소식 확인",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
        AppShortcut(
            intent: RunLocalAITaskIntent(),
            phrases: [
                "\(.applicationName)에게 작업 시켜",
                "\(.applicationName)로 실행해",
            ],
            shortTitle: "로컬 AI에게 작업 시키기",
            systemImageName: "brain.head.profile"
        )
    }
}

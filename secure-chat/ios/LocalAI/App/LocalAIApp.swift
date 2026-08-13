import SwiftUI

enum AppRuntime {
    private static let process = ProcessInfo.processInfo

    static let isVisualTest: Bool = {
        return process.arguments.contains("-visual-test-chat") ||
            process.environment["LOCAL_AI_VISUAL_TEST"] == "1"
    }()

    static let isUnitTest = process.environment["XCTestConfigurationFilePath"] != nil
    static let suppressPermissionPrompts = isVisualTest || isUnitTest
}

@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()

    @Published var showGrowthCenter = false
    @Published var showCodexTasks = false
    @Published var showDevelopmentWork = false
    @Published var pendingCodexDraft: String?

    func openCodex(draft: String? = nil) {
        pendingCodexDraft = draft
        showCodexTasks = true
    }

    func openDevelopmentWork() {
        showDevelopmentWork = true
    }

    func clearCodexDraft() {
        pendingCodexDraft = nil
    }

    @discardableResult
    func open(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "localai" else { return false }
        switch url.host?.lowercased() {
        case "growth":
            showGrowthCenter = true
            return true
        case "codex":
            openCodex()
            return true
        case "dev", "cursor", "development":
            openDevelopmentWork()
            return true
        default:
            return false
        }
    }
}

@main
struct LocalAIApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .task {
                    guard !AppRuntime.suppressPermissionPrompts else { return }
                    await ProactiveInbox.shared.consumeAndSpeak()
                }
                .onOpenURL { url in
                    if AppRouter.shared.open(url) { return }
                    guard !AppRuntime.suppressPermissionPrompts else { return }
                    guard url.scheme == "localai", url.host == "inbox" else { return }
                    Task { await ProactiveInbox.shared.consumeAndSpeak() }
                }
        }
    }
}

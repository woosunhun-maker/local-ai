import SwiftUI

struct ContentView: View {
    @State private var paired: Bool
    @StateObject private var conversations = ConversationStore()

    init() {
        _paired = State(initialValue: AppRuntime.isVisualTest || LocalAIClient.shared.isPaired)
    }

    var body: some View {
        Group {
            if paired {
                ChatView(
                    store: conversations,
                    onRepairPairing: {
                        LocalAIClient.shared.forgetPairing()
                        paired = false
                    }
                )
                    .task {
                        guard !AppRuntime.isVisualTest else { return }
                        await VoiceProviderRecommendationMigration.runIfNeeded()
                        await NotificationService.requestPermission()
                    }
            } else {
                PairingView { paired = true }
            }
        }
    }
}

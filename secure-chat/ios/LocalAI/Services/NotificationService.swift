import AVFoundation
import Foundation
import UserNotifications

enum NotificationService {
    static func requestPermission() async {
        guard !AppRuntime.suppressPermissionPrompts else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }
}

@MainActor
final class ProactiveInbox: ObservableObject {
    static let shared = ProactiveInbox()

    @Published private(set) var messages: [ChatMessage] = []

    func consumeAndSpeak() async {
        guard LocalAIClient.shared.isPaired else { return }
        guard let pending = try? await LocalAIClient.shared.fetchInbox(), !pending.isEmpty else { return }
        for message in pending {
            messages.append(ChatMessage(role: .assistant, content: message.content))
        }
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "speakProactiveMessages") else { return }
        let combined = pending.map(\.content).joined(separator: "\n")
        let selectedVoice = UserDefaults.standard.string(forKey: "speechVoiceIdentifier")
        SpeechPlaybackController.shared.speak(combined, voiceIdentifier: selectedVoice)
    }
}

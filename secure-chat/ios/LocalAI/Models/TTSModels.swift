import Foundation

struct TTSCatalog: Decodable, Sendable {
    let version: Int
    let primaryProviderId: String
    let fallbackProviderId: String
    let providers: [Provider]

    struct Provider: Decodable, Identifiable, Sendable {
        let id: String
        let displayName: String
        let execution: String
        let availability: Availability
        let capabilities: Capabilities
        let voices: [Voice]?

        struct Availability: Decodable, Sendable {
            let state: String
            let reason: String?
        }

        struct Capabilities: Decodable, Sendable {
            let streaming: Bool
            let preview: Bool
            let instructionStyles: Bool?
            let clientSynthesis: Bool?
        }

        struct Voice: Decodable, Identifiable, Sendable {
            let id: String
            let displayName: String
            let locale: String
            let styles: [String]?
            let selectable: Bool
        }
    }
}

enum RemoteSpeechEvent: Sendable {
    case state(name: String, providerID: String?)
    case audio(RemoteAudioChunk)
    case clientSynthesis(text: String, voiceID: String?)
}

struct RemoteAudioChunk: Sendable {
    let data: Data
    let encoding: String
    let sampleRate: Double
    let channels: UInt32
    let sequence: Int
    let segmentIndex: Int
}

struct RemoteSpeechPlaybackFailure: LocalizedError {
    let message: String
    let receivedAudio: Bool

    init(_ error: Error, receivedAudio: Bool) {
        message = error.localizedDescription
        self.receivedAudio = receivedAudio
    }

    var errorDescription: String? { message }
}

enum RemoteSpeechFallbackPolicy {
    static func shouldUseApple(after error: Error) -> Bool {
        if error is CancellationError { return false }
        guard let failure = error as? RemoteSpeechPlaybackFailure else { return true }
        return !failure.receivedAudio
    }
}

@MainActor
enum VoiceProviderRecommendationMigration {
    static let completionKey = "tts.recommendedDefault.qwenSohee.v1.completed"
    static let providerKey = "speechProviderID"
    static let qwenProviderID = "qwen3-tts-local"
    static let qwenVoiceID = "qwen3-sohee"
    static let appleProviderID = "apple-avspeech-device"

    static func runIfNeeded(
        client: LocalAIClient = .shared,
        defaults: UserDefaults = .standard
    ) async {
        guard !defaults.bool(forKey: completionKey) else { return }
        do {
            let catalog = try await client.fetchTTSCatalog()
            apply(catalog: catalog, defaults: defaults)
        } catch {
            // A network error is not an availability decision. Retry on a later launch.
        }
    }

    static func apply(catalog: TTSCatalog, defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: completionKey) else { return }
        let qwen = catalog.providers.first(where: { $0.id == qwenProviderID })
        let soheeIsSelectable = qwen?.voices?.contains(where: {
            $0.id == qwenVoiceID && $0.selectable
        }) == true
        let shouldRecommendQwen = qwen?.availability.state == "available" && soheeIsSelectable
        defaults.set(shouldRecommendQwen ? qwenProviderID : appleProviderID, forKey: providerKey)
        defaults.set(true, forKey: completionKey)
    }

    static func markUserSelection(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: completionKey)
    }
}

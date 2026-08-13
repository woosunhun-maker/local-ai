import XCTest
@testable import LocalAI

@MainActor
final class VoiceProviderRecommendationMigrationTests: XCTestCase {
    func testFirstSuccessfulCatalogSelectsAvailableSoheeOnlyOnce() throws {
        let defaults = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let catalog = makeCatalog(qwenState: "available", soheeSelectable: true)

        VoiceProviderRecommendationMigration.apply(catalog: catalog, defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: VoiceProviderRecommendationMigration.providerKey), "qwen3-tts-local")

        defaults.set("apple-avspeech-device", forKey: VoiceProviderRecommendationMigration.providerKey)
        VoiceProviderRecommendationMigration.apply(catalog: catalog, defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: VoiceProviderRecommendationMigration.providerKey), "apple-avspeech-device")
    }

    func testUnavailableSoheeKeepsAppleAsFirstRunDefault() throws {
        let defaults = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        VoiceProviderRecommendationMigration.apply(
            catalog: makeCatalog(qwenState: "unavailable", soheeSelectable: false),
            defaults: defaults
        )

        XCTAssertEqual(defaults.string(forKey: VoiceProviderRecommendationMigration.providerKey), "apple-avspeech-device")
        XCTAssertTrue(defaults.bool(forKey: VoiceProviderRecommendationMigration.completionKey))
    }

    private var suiteName: String { "VoiceProviderRecommendationMigrationTests" }

    private func makeDefaults() throws -> UserDefaults {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    private func makeCatalog(qwenState: String, soheeSelectable: Bool) -> TTSCatalog {
        TTSCatalog(
            version: 1,
            primaryProviderId: "qwen3-tts-local",
            fallbackProviderId: "apple-avspeech-device",
            providers: [
                TTSCatalog.Provider(
                    id: "qwen3-tts-local",
                    displayName: "Qwen3-TTS Sohee",
                    execution: "mac_local",
                    availability: .init(state: qwenState, reason: nil),
                    capabilities: .init(
                        streaming: true,
                        preview: true,
                        instructionStyles: true,
                        clientSynthesis: false
                    ),
                    voices: [
                        .init(
                            id: "qwen3-sohee",
                            displayName: "Sohee",
                            locale: "ko-KR",
                            styles: ["natural"],
                            selectable: soheeSelectable
                        ),
                    ]
                ),
            ]
        )
    }
}

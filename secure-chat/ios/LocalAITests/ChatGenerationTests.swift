import XCTest
@testable import LocalAI

@MainActor
final class ChatGenerationTests: XCTestCase {
    func testSwitchingConversationInvalidatesOldStreamingResponse() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ConversationStore(directoryURL: directory)
        let originalID = store.selected.id
        let model = ChatViewModel(
            store: store,
            statusCheck: { AppStatus(ok: true, iosApp: nil) },
            approvalKeyCheck: { .ready },
            streamRequest: { _, _ in
                AsyncThrowingStream { continuation in
                    let producer = Task {
                        try? await Task.sleep(for: .milliseconds(60))
                        continuation.yield(.delta("old partial"))
                        try? await Task.sleep(for: .milliseconds(500))
                        continuation.yield(.delta(" stale"))
                        continuation.yield(.finished)
                        continuation.finish()
                    }
                    continuation.onTermination = { @Sendable _ in producer.cancel() }
                }
            }
        )

        model.text = "first question"
        model.send(voiceReplies: false)
        for _ in 0..<30 {
            if model.messages.last?.content == "old partial" { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.messages.last?.content, "old partial")

        model.newConversation()
        let replacementID = store.selected.id
        XCTAssertNotEqual(replacementID, originalID)
        XCTAssertTrue(model.messages.isEmpty)

        try await Task.sleep(for: .milliseconds(240))
        XCTAssertEqual(store.selected.id, replacementID)
        XCTAssertTrue(model.messages.isEmpty)

        let original = try XCTUnwrap(store.conversations.first(where: { $0.id == originalID }))
        XCTAssertEqual(original.messages.first?.content, "first question")
        XCTAssertEqual(original.messages.last?.content, "old partial")
        XCTAssertEqual(original.messages.last?.deliveryState, .cancelled)
    }

    func testApprovalKeyFailureDoesNotMarkChatDisconnected() async {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ConversationStore(directoryURL: directory)
        let model = ChatViewModel(
            store: store,
            statusCheck: { AppStatus(ok: true, iosApp: nil) },
            approvalKeyCheck: { .repairRequired },
            streamRequest: { _, _ in AsyncThrowingStream { $0.finish() } }
        )

        await model.start()

        XCTAssertEqual(model.connection, .connected)
        XCTAssertEqual(model.approvalKeyState, .repairRequired)
    }

    func testGrowthDeepLinkRoutesOnlyExpectedURL() {
        let router = AppRouter.shared
        router.showGrowthCenter = false

        XCTAssertTrue(router.open(URL(string: "localai://growth")!))
        XCTAssertTrue(router.showGrowthCenter)

        router.showGrowthCenter = false
        XCTAssertFalse(router.open(URL(string: "https://example.com/growth")!))
        XCTAssertFalse(router.showGrowthCenter)
    }

    func testCodexDeepLinkRoutesToProtectedTaskFlow() {
        let router = AppRouter.shared
        router.showCodexTasks = false
        router.clearCodexDraft()

        XCTAssertTrue(router.open(URL(string: "localai://codex")!))
        XCTAssertTrue(router.showCodexTasks)
        XCTAssertNil(router.pendingCodexDraft)

        router.showCodexTasks = false
    }
}

final class CommunicationStatusModelTests: XCTestCase {
    func testDecodesCommunicationStatusContract() throws {
        let data = Data("""
        {
          "telegram": {
            "configured": true,
            "enabled": true,
            "running": true,
            "mode": "general_chat_only",
            "botUsername": "local_ai_bot"
          },
          "codexBridge": {
            "configured": true,
            "enabled": true,
            "running": true,
            "mode": "owner_app_approval_only",
            "status": "ready"
          },
          "browser": {
            "profile": "shared_chrome_tabs",
            "connected": true,
            "sharedTabs": 2
          },
          "webTasks": {
            "policy": "default_deny_v1",
            "stage": "live_ui_validation_required",
            "preparedActions": ["coupang.search", "mail.important.list"],
            "blockedFinalActions": ["checkout", "payment"]
          },
          "privilegedIngress": "local_owner_app_only",
          "blockedInTelegram": ["authenticated_web", "email", "files"]
        }
        """.utf8)

        let status = try JSONDecoder().decode(CommunicationStatus.self, from: data)

        XCTAssertEqual(status.telegram.botUsername, "local_ai_bot")
        XCTAssertTrue(status.telegram.running)
        XCTAssertEqual(status.codexBridge?.mode, "owner_app_approval_only")
        XCTAssertTrue(status.codexBridge?.running == true)
        XCTAssertEqual(status.browser.sharedTabs, 2)
        XCTAssertEqual(status.webTasks?.policy, "default_deny_v1")
        XCTAssertEqual(status.webTasks?.preparedActions, ["coupang.search", "mail.important.list"])
        XCTAssertEqual(status.privilegedIngress, "local_owner_app_only")
        XCTAssertEqual(status.blockedInTelegram, ["authenticated_web", "email", "files"])
    }

    func testDecodesUnconfiguredOptionalTelegramFields() throws {
        let data = Data("""
        {
          "telegram": {
            "configured": false,
            "enabled": false,
            "running": false,
            "mode": "general_chat_only",
            "botUsername": null
          },
          "browser": {
            "profile": "shared_chrome_tabs",
            "connected": false,
            "sharedTabs": 0
          },
          "privilegedIngress": "local_owner_app_only",
          "blockedInTelegram": []
        }
        """.utf8)

        let status = try JSONDecoder().decode(CommunicationStatus.self, from: data)

        XCTAssertNil(status.telegram.botUsername)
        XCTAssertNil(status.telegram.status)
        XCTAssertFalse(status.browser.connected)
        XCTAssertNil(status.webTasks)
    }
}

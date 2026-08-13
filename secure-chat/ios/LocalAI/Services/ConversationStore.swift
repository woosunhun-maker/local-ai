import Foundation

@MainActor
final class ConversationStore: ObservableObject {
    @Published private(set) var conversations: [Conversation] = []
    @Published private(set) var selectedID: UUID?

    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(fileManager: FileManager = .default, directoryURL: URL? = nil) {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = directoryURL ?? base.appending(path: "LocalAI", directoryHint: .isDirectory)
        try? fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedDirectory = directory
        try? protectedDirectory.setResourceValues(values)
        fileURL = directory.appending(path: "conversations.json")

        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        load()
        if conversations.isEmpty { conversations = [Conversation()] }
        selectedID = conversations.max(by: { $0.updatedAt < $1.updatedAt })?.id
    }

    var selected: Conversation {
        get {
            conversations.first(where: { $0.id == selectedID }) ?? conversations[0]
        }
        set {
            if let index = conversations.firstIndex(where: { $0.id == newValue.id }) {
                conversations[index] = newValue
            } else {
                conversations.append(newValue)
            }
            selectedID = newValue.id
            sortAndSave()
        }
    }

    @discardableResult
    func createConversation() -> Conversation {
        let conversation = Conversation()
        conversations.insert(conversation, at: 0)
        selectedID = conversation.id
        save()
        return conversation
    }

    func select(_ id: UUID) -> Conversation? {
        guard let conversation = conversations.first(where: { $0.id == id }) else { return nil }
        selectedID = id
        return conversation
    }

    func update(_ conversation: Conversation) {
        var value = conversation
        value.updatedAt = Date()
        if value.title == "새 대화", let first = value.messages.first(where: { $0.role == .user }) {
            value.title = Self.title(from: first.content)
        }
        selected = value
    }

    func delete(_ id: UUID) -> Conversation {
        conversations.removeAll { $0.id == id }
        if conversations.isEmpty { conversations = [Conversation()] }
        if selectedID == id { selectedID = conversations[0].id }
        save()
        return selected
    }

    func rename(_ id: UUID, title: String) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        conversations[index].title = String(cleaned.prefix(60))
        conversations[index].updatedAt = Date()
        sortAndSave()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? decoder.decode([Conversation].self, from: data) else { return }
        conversations = decoded
    }

    private func sortAndSave() {
        conversations.sort { $0.updatedAt > $1.updatedAt }
        save()
    }

    private func save() {
        guard let data = try? encoder.encode(conversations) else { return }
        do {
            try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: fileURL.path)
        } catch {
            assertionFailure("대화 저장 실패: \(error.localizedDescription)")
        }
    }

    private static func title(from source: String) -> String {
        let singleLine = source.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return singleLine.isEmpty ? "새 대화" : String(singleLine.prefix(32))
    }
}

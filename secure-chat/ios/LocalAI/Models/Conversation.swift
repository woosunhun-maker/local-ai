import Foundation

struct Conversation: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    var title: String
    let createdAt: Date
    var updatedAt: Date
    var mode: ChatMode
    var messages: [ChatMessage]
    var draft: String

    init(
        id: UUID = UUID(),
        title: String = "새 대화",
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        mode: ChatMode = .auto,
        messages: [ChatMessage] = [],
        draft: String = ""
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.mode = mode
        self.messages = messages
        self.draft = draft
    }

    var preview: String {
        messages.last(where: { !$0.content.isEmpty })?.content
            .replacingOccurrences(of: "\n", with: " ")
            .prefix(90)
            .description ?? "대화를 시작하세요"
    }
}

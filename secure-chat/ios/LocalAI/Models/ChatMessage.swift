import Foundation

struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable {
        case user
        case assistant
        case system
    }

    enum DeliveryState: String, Codable, Sendable {
        case sent
        case streaming
        case completed
        case failed
        case cancelled
    }

    let id: UUID
    let role: Role
    var content: String
    let createdAt: Date
    var deliveryState: DeliveryState

    init(
        id: UUID = UUID(),
        role: Role,
        content: String,
        createdAt: Date = Date(),
        deliveryState: DeliveryState? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.createdAt = createdAt
        self.deliveryState = deliveryState ?? (role == .assistant ? .completed : .sent)
    }
}

struct ProactiveMessage: Decodable, Identifiable {
    let id: String
    let content: String
    let createdAt: Date
}

import Foundation

struct GrowthStatus: Decodable, Sendable {
    let mode: String
    let externalTransfer: String
    let autoApply: Bool
    let pendingConsultations: Int
    let pendingProposals: Int
    let proposals: Int
    let dlpPolicy: String
    let blockedCategories: String
}

struct GrowthProposalSummary: Decodable, Identifiable, Sendable {
    let id: String
    let revision: Int
    let updatedAt: String
    let status: String
    let title: String
    let summary: String
    let scopes: [String]
    let trust: String
}

import SwiftUI

struct ConversationListView: View {
    @ObservedObject var store: ConversationStore
    let selectedID: UUID?
    let onSelect: (Conversation) -> Void
    let onNew: () -> Void
    let onDelete: (UUID) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var renameTarget: Conversation?
    @State private var renameText = ""
    @State private var deleteTarget: Conversation?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var filtered: [Conversation] {
        guard !searchText.isEmpty else { return store.conversations }
        return store.conversations.filter {
            $0.title.localizedCaseInsensitiveContains(searchText) ||
            $0.preview.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if filtered.isEmpty {
                    if searchText.isEmpty {
                        ContentUnavailableView(
                            "저장된 대화 없음",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("새 대화를 시작하면 이 iPhone에만 안전하게 저장됩니다.")
                        )
                    } else {
                        ContentUnavailableView.search(text: searchText)
                    }
                } else {
                    ForEach(filtered) { conversation in
                        Button { onSelect(conversation) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: conversation.id == selectedID ? "bubble.left.fill" : "bubble.left")
                                    .foregroundStyle(conversation.id == selectedID ? AppTheme.accent : .secondary)
                                    .frame(width: 24)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 5) {
                                    ViewThatFits(in: .horizontal) {
                                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                                            conversationTitle(conversation)
                                            Spacer(minLength: 4)
                                            conversationDate(conversation)
                                        }
                                        VStack(alignment: .leading, spacing: 2) {
                                            conversationTitle(conversation)
                                            conversationDate(conversation)
                                        }
                                    }
                                    Text(conversation.preview)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                if conversation.id == selectedID {
                                    Image(systemName: "checkmark")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(AppTheme.accent)
                                        .accessibilityHidden(true)
                                }
                            }
                            .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(conversation.title)
                        .accessibilityValue("\(conversation.preview), \(conversation.updatedAt.formatted(.relative(presentation: .named)))")
                        .accessibilityHint(conversation.id == selectedID ? "현재 대화" : "이 대화를 엽니다")
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleteTarget = conversation } label: {
                                Label("삭제", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button("이름 변경", systemImage: "pencil") {
                                renameTarget = conversation
                                renameText = conversation.title
                            }
                            Button("삭제", systemImage: "trash", role: .destructive) {
                                deleteTarget = conversation
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .searchable(text: $searchText, prompt: "대화 검색")
            .navigationTitle("대화")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(action: onNew) { Label("새 대화", systemImage: "square.and.pencil") }
                }
            }
            .alert("대화 이름 변경", isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            )) {
                TextField("대화 이름", text: $renameText)
                Button("취소", role: .cancel) { renameTarget = nil }
                Button("저장") {
                    if let id = renameTarget?.id { store.rename(id, title: renameText) }
                    renameTarget = nil
                }
            }
            .confirmationDialog(
                "‘\(deleteTarget?.title ?? "대화")’을 삭제할까요?",
                isPresented: Binding(
                    get: { deleteTarget != nil },
                    set: { if !$0 { deleteTarget = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("대화 삭제", role: .destructive) {
                    if let id = deleteTarget?.id { onDelete(id) }
                    deleteTarget = nil
                }
                Button("취소", role: .cancel) { deleteTarget = nil }
            } message: {
                Text("이 iPhone에 저장된 대화 내용이 삭제되며 되돌릴 수 없습니다.")
            }
        }
    }

    private func conversationTitle(_ conversation: Conversation) -> some View {
        Text(conversation.title)
            .font(.body.weight(conversation.id == selectedID ? .semibold : .regular))
            .foregroundStyle(.primary)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
    }

    private func conversationDate(_ conversation: Conversation) -> some View {
        Text(conversation.updatedAt, format: .relative(presentation: .named))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}

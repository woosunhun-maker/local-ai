import SwiftUI

@MainActor
final class TalkModel: ObservableObject {
    @Published var room = HouseRoom(messages: [], jobLabel: nil, updatedAt: Date())
    @Published var draft = ""
    @Published var link: LinkState = .checking
    @Published var statusLine: String?
    @Published var errorText: String?
    @Published var sending = false

    private var streamTask: Task<Void, Never>?
    private var liveReplyID: UUID?

    func start() async {
        await refresh(keepMessages: false)
    }

    func refresh(keepMessages: Bool) async {
        if !sending { link = .checking }
        do {
            try await HouseClient.shared.ping()
            let remote = try await HouseClient.shared.room()
            if !sending {
                room = remote
                statusLine = remote.jobLabel
            } else if !keepMessages || room.messages.isEmpty {
                room.updatedAt = remote.updatedAt
            }
            link = .linked
            errorText = nil
        } catch HouseError.notPaired {
            link = .broken
            errorText = HouseError.notPaired.errorDescription
        } catch HouseError.rejected(401) {
            HouseClient.shared.forget()
            link = .broken
            errorText = HouseError.rejected(401).errorDescription
        } catch {
            link = .broken
            if !keepMessages || room.messages.isEmpty {
                errorText = error.localizedDescription
            }
        }
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        draft = ""
        errorText = nil
        statusLine = "맥으로 보내는 중"
        sending = true

        let user = HouseMessage(id: UUID(), role: .user, text: text, createdAt: Date(), delivery: .sent)
        let reply = HouseMessage(id: UUID(), role: .assistant, text: "", createdAt: Date(), delivery: .streaming)
        room.messages.append(user)
        room.messages.append(reply)
        room.updatedAt = Date()
        liveReplyID = reply.id

        streamTask = Task { [weak self] in
            await self?.listen(replyID: reply.id, text: text)
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        sending = false
        statusLine = nil
    }

    private func listen(replyID: UUID, text: String) async {
        var answer = ""
        var finished = false
        do {
            let stream = try await HouseClient.shared.say(text: text)
            for try await event in stream {
                try Task.checkCancellation()
                switch event {
                case .status(let label):
                    statusLine = label
                case .delta(let fragment):
                    answer += fragment
                    statusLine = nil
                    patch(replyID) { $0.text = answer }
                case .finished:
                    finished = true
                }
            }
            guard finished, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw HouseError.interrupted
            }
            patch(replyID) {
                $0.text = answer
                $0.delivery = .done
            }
            link = .linked
        } catch is CancellationError {
            patch(replyID) {
                if $0.text.isEmpty { $0.text = "중단했습니다." }
                $0.delivery = .failed
            }
        } catch HouseError.rejected(401) {
            HouseClient.shared.forget()
            link = .broken
            errorText = HouseError.rejected(401).errorDescription
            patch(replyID) {
                if $0.text.isEmpty { $0.text = "답을 받지 못했습니다." }
                $0.delivery = .failed
            }
        } catch {
            errorText = error.localizedDescription
            patch(replyID) {
                if $0.text.isEmpty { $0.text = "답을 받지 못했습니다." }
                $0.delivery = .failed
            }
        }
        sending = false
        statusLine = nil
        streamTask = nil
        liveReplyID = nil
    }

    private func patch(_ messageID: UUID, mutate: (inout HouseMessage) -> Void) {
        guard let index = room.messages.firstIndex(where: { $0.id == messageID }) else { return }
        mutate(&room.messages[index])
    }
}

struct TalkView: View {
    let onUnpair: () -> Void
    @StateObject private var model = TalkModel()
    @FocusState private var composerFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            HouseColor.paper.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                Rectangle()
                    .fill(HouseColor.rule)
                    .frame(height: 1)
                messages
                if let error = model.errorText {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(HouseColor.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 10)
                }
                composer
            }
        }
        .task {
            await model.start()
            composerFocused = true
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await model.refresh(keepMessages: true) }
                composerFocused = true
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("H")
                    .font(.system(.title3, design: .serif).weight(.medium))
                    .foregroundStyle(HouseColor.ink)
                Text("집")
                    .font(.caption)
                    .foregroundStyle(HouseColor.mute)
            }
            Spacer()
            HStack(spacing: 6) {
                HouseDot(live: model.link == .linked)
                Text(model.link.title)
                    .font(.caption)
                    .foregroundStyle(HouseColor.mute)
            }
            Menu {
                Button("다시 붙기") {
                    Task { await model.refresh(keepMessages: true) }
                }
                Button("이 아이폰 연결 끊기", role: .destructive, action: onUnpair)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.medium))
                    .foregroundStyle(HouseColor.ink)
                    .frame(width: 36, height: 36)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if model.room.messages.isEmpty {
                        emptyState
                    }
                    ForEach(model.room.messages) { message in
                        letter(message)
                            .id(message.id)
                    }
                    if let status = model.statusLine {
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(HouseColor.mute)
                            .id("status")
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 28)
            }
            .onChange(of: model.room.messages.last?.text) { _, _ in
                if let last = model.room.messages.last?.id {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
            .onTapGesture { composerFocused = true }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("H")
                .font(.system(size: 40, weight: .medium, design: .serif))
                .foregroundStyle(HouseColor.ink)
            Text("맥에 말하면 됩니다.")
                .font(.title3)
                .foregroundStyle(HouseColor.ink)
            Text("이 화면은 문일 뿐이고, 기억은 맥에 있습니다.")
                .font(.subheadline)
                .foregroundStyle(HouseColor.mute)
        }
        .padding(.top, 32)
    }

    private func letter(_ message: HouseMessage) -> some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
            Text(message.role == .user ? "나" : "H")
                .font(.caption.weight(.medium))
                .foregroundStyle(HouseColor.mute)
            Text(message.text.isEmpty ? "…" : message.text)
                .font(message.role == .assistant ? .system(.body, design: .serif) : .body)
                .foregroundStyle(message.role == .user ? HouseColor.paper : HouseColor.ink)
                .lineSpacing(5)
                .padding(.horizontal, message.role == .user ? 14 : 0)
                .padding(.vertical, message.role == .user ? 10 : 0)
                .background {
                    if message.role == .user {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(HouseColor.mine)
                    }
                }
                .frame(maxWidth: 300, alignment: message.role == .user ? .trailing : .leading)
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    }

    private var composer: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(HouseColor.rule)
                .frame(height: 1)
            HStack(alignment: .bottom, spacing: 10) {
                TextField("맥에게", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .submitLabel(.send)
                    .focused($composerFocused)
                    .onSubmit {
                        model.send()
                        composerFocused = true
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(HouseColor.sheet, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                Button {
                    if model.sending {
                        model.stop()
                    } else {
                        model.send()
                    }
                    composerFocused = true
                } label: {
                    Image(systemName: model.sending ? "stop.fill" : "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(HouseColor.paper)
                        .frame(width: 40, height: 40)
                        .background(HouseColor.ink, in: Circle())
                }
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.sending)
                .opacity(model.link == .linked || model.sending ? 1 : 0.35)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(HouseColor.paper)
        }
    }
}

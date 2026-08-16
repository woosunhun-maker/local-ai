import SwiftUI

@MainActor
final class TalkModel: ObservableObject {
    @Published var talks: [HouseTalk] = []
    @Published var selectedID: UUID?
    @Published var draft = ""
    @Published var link: LinkState = .checking
    @Published var statusLine: String?
    @Published var errorText: String?
    @Published var sending = false

    private var streamTask: Task<Void, Never>?

    var current: HouseTalk? {
        talks.first(where: { $0.id == selectedID })
    }

    func start() async {
        await refresh()
    }

    func refresh() async {
        link = .checking
        do {
            try await HouseClient.shared.ping()
            var remote = try await HouseClient.shared.talks()
            if remote.isEmpty {
                remote = [try await HouseClient.shared.createTalk()]
            }
            talks = remote
            if selectedID == nil || !talks.contains(where: { $0.id == selectedID }) {
                selectedID = talks.first?.id
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
            errorText = error.localizedDescription
        }
    }

    func newTalk() async {
        do {
            let talk = try await HouseClient.shared.createTalk()
            talks.insert(talk, at: 0)
            selectedID = talk.id
            draft = ""
            link = .linked
        } catch {
            errorText = error.localizedDescription
        }
    }

    func select(_ id: UUID) {
        stop()
        selectedID = id
        draft = ""
        statusLine = nil
        errorText = nil
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let talkID = selectedID, !text.isEmpty, !sending else { return }
        draft = ""
        errorText = nil
        statusLine = "맥으로 보내는 중"
        sending = true

        let user = HouseMessage(id: UUID(), role: .user, text: text, createdAt: Date(), delivery: .sent)
        let reply = HouseMessage(id: UUID(), role: .assistant, text: "", createdAt: Date(), delivery: .streaming)
        upsert(talkID) { talk in
            talk.messages.append(user)
            talk.messages.append(reply)
            if talk.title == "새 대화" {
                talk.title = String(text.prefix(32))
            }
            talk.updatedAt = Date()
        }

        streamTask = Task { [weak self] in
            await self?.listen(talkID: talkID, replyID: reply.id, text: text)
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        sending = false
        statusLine = nil
    }

    private func listen(talkID: UUID, replyID: UUID, text: String) async {
        var answer = ""
        var finished = false
        do {
            let stream = try await HouseClient.shared.say(talkId: talkID, text: text)
            for try await event in stream {
                try Task.checkCancellation()
                switch event {
                case .status(let label):
                    statusLine = label
                case .delta(let fragment):
                    answer += fragment
                    statusLine = nil
                    patch(talkID, messageID: replyID) { $0.text = answer }
                case .finished:
                    finished = true
                }
            }
            guard finished, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw HouseError.interrupted
            }
            patch(talkID, messageID: replyID) {
                $0.text = answer
                $0.delivery = .done
            }
        } catch is CancellationError {
            patch(talkID, messageID: replyID) {
                if $0.text.isEmpty { $0.text = "중단했습니다." }
                $0.delivery = .failed
            }
        } catch {
            errorText = error.localizedDescription
            patch(talkID, messageID: replyID) {
                if $0.text.isEmpty { $0.text = "답을 받지 못했습니다." }
                $0.delivery = .failed
            }
        }
        sending = false
        statusLine = nil
        streamTask = nil
    }

    private func upsert(_ id: UUID, mutate: (inout HouseTalk) -> Void) {
        guard let index = talks.firstIndex(where: { $0.id == id }) else { return }
        mutate(&talks[index])
    }

    private func patch(_ talkID: UUID, messageID: UUID, mutate: (inout HouseMessage) -> Void) {
        guard let talkIndex = talks.firstIndex(where: { $0.id == talkID }),
              let messageIndex = talks[talkIndex].messages.firstIndex(where: { $0.id == messageID }) else { return }
        mutate(&talks[talkIndex].messages[messageIndex])
    }
}

struct TalkView: View {
    let onUnpair: () -> Void
    @StateObject private var model = TalkModel()
    @State private var showTalks = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        ZStack {
            HouseColor.background.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                messages
                if let error = model.errorText {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(HouseColor.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                }
                composer
            }
        }
        .task { await model.start() }
        .sheet(isPresented: $showTalks) {
            talkList
                .presentationDetents([.medium, .large])
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button { showTalks = true } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.body.weight(.semibold))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("H")
                    .font(.headline.weight(.semibold))
                Text(model.current?.title ?? "집")
                    .font(.caption)
                    .foregroundStyle(HouseColor.muted)
                    .lineLimit(1)
            }
            Spacer()
            Text(model.link.title)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(model.link == .linked ? HouseColor.accent.opacity(0.18) : HouseColor.card)
                .clipShape(Capsule())
        }
        .foregroundStyle(HouseColor.ink)
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let talk = model.current, talk.messages.isEmpty, model.link == .linked {
                        Text("맥에 말하면 됩니다. 이 폰에는 대화를 저장하지 않습니다.")
                            .font(.subheadline)
                            .foregroundStyle(HouseColor.muted)
                            .padding(.top, 24)
                    }
                    if let talk = model.current {
                        ForEach(talk.messages) { message in
                            messageBubble(message)
                                .id(message.id)
                        }
                    }
                    if let status = model.statusLine {
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(HouseColor.muted)
                            .id("status")
                    }
                }
                .padding(20)
            }
            .onChange(of: model.current?.messages.last?.text) { _, _ in
                if let last = model.current?.messages.last?.id {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
        }
    }

    private func messageBubble(_ message: HouseMessage) -> some View {
        HStack {
            if message.role == .user { Spacer(minLength: 48) }
            Text(message.text.isEmpty ? "…" : message.text)
                .font(.body)
                .foregroundStyle(message.role == .user ? Color.white : HouseColor.ink)
                .padding(14)
                .background(
                    message.role == .user ? HouseColor.accent : HouseColor.card,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
            if message.role == .assistant { Spacer(minLength: 48) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("맥에게 말하기", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .focused($composerFocused)
                .padding(12)
                .background(HouseColor.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            Button {
                composerFocused = false
                if model.sending {
                    model.stop()
                } else {
                    model.send()
                }
            } label: {
                Image(systemName: model.sending ? "stop.fill" : "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(HouseColor.accent, in: Circle())
            }
            .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.sending)
            .opacity(model.link == .linked ? 1 : 0.4)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(HouseColor.background)
    }

    private var talkList: some View {
        NavigationStack {
            List {
                ForEach(model.talks) { talk in
                    Button {
                        model.select(talk.id)
                        showTalks = false
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(talk.title)
                                .foregroundStyle(HouseColor.ink)
                            Text(talk.updatedAt.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption)
                                .foregroundStyle(HouseColor.muted)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(HouseColor.background)
            .navigationTitle("맥에 있는 대화")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("다시 연결") { onUnpair() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("새 대화") {
                        Task {
                            await model.newTalk()
                            showTalks = false
                        }
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

enum HouseColor {
    static let background = Color(red: 0.07, green: 0.08, blue: 0.09)
    static let card = Color(red: 0.14, green: 0.15, blue: 0.16)
    static let ink = Color(red: 0.93, green: 0.93, blue: 0.90)
    static let muted = Color(red: 0.62, green: 0.62, blue: 0.58)
    static let accent = Color(red: 0.72, green: 0.48, blue: 0.28)
    static let warn = Color(red: 0.92, green: 0.62, blue: 0.38)
}

struct HouseButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(HouseColor.accent.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .foregroundStyle(.white)
    }
}

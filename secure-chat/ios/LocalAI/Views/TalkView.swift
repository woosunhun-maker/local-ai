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
        .task { await model.start() }
        .sheet(isPresented: $showTalks) {
            talkList
                .presentationDetents([.medium, .large])
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            Button { showTalks = true } label: {
                Image(systemName: "square.stack")
                    .font(.body.weight(.medium))
                    .foregroundStyle(HouseColor.ink)
                    .frame(width: 36, height: 36)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("H")
                    .font(.system(.title3, design: .serif).weight(.medium))
                    .foregroundStyle(HouseColor.ink)
                Text(model.current?.title == "새 대화" ? "집" : (model.current?.title ?? "집"))
                    .font(.caption)
                    .foregroundStyle(HouseColor.mute)
                    .lineLimit(1)
            }
            Spacer()
            HStack(spacing: 6) {
                HouseDot(live: model.link == .linked)
                Text(model.link.title)
                    .font(.caption)
                    .foregroundStyle(HouseColor.mute)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if let talk = model.current, talk.messages.isEmpty {
                        emptyState
                    }
                    if let talk = model.current {
                        ForEach(talk.messages) { message in
                            letter(message)
                                .id(message.id)
                        }
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
            .onChange(of: model.current?.messages.last?.text) { _, _ in
                if let last = model.current?.messages.last?.id {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
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
                    .focused($composerFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(HouseColor.sheet, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                Button {
                    if model.sending {
                        model.stop()
                    } else {
                        model.send()
                    }
                } label: {
                    Image(systemName: model.sending ? "stop.fill" : "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(HouseColor.paper)
                        .frame(width: 40, height: 40)
                        .background(HouseColor.ink, in: Circle())
                }
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.sending)
                .opacity(model.link == .linked ? 1 : 0.35)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(HouseColor.paper)
        }
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
                                .font(.system(.body, design: .serif))
                                .foregroundStyle(HouseColor.ink)
                            Text(talk.updatedAt.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption)
                                .foregroundStyle(HouseColor.mute)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(HouseColor.paper)
            .navigationTitle("맥에 있는 말")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("다시 연결") { onUnpair() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("새 말") {
                        Task {
                            await model.newTalk()
                            showTalks = false
                        }
                    }
                }
            }
        }
        .preferredColorScheme(.light)
    }
}

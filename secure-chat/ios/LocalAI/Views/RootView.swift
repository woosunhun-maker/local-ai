import SwiftUI

struct RootView: View {
    @State private var paired = HouseClient.shared.isPaired
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if paired {
                TalkView(onUnpair: {
                    HouseClient.shared.forget()
                    paired = false
                })
            } else {
                PairView { paired = true }
            }
        }
        .preferredColorScheme(.light)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                paired = HouseClient.shared.isPaired
            }
        }
        .onOpenURL { url in
            Task { await openMirror(url) }
        }
    }

    private func openMirror(_ url: URL) async {
        guard let link = MirrorLink(url: url) else { return }
        if let pin = link.pin {
            do {
                try await HouseClient.shared.pair(pin: pin)
                paired = true
            } catch {
                // PIN이 이미 쓰였거나 만료돼도, 키체인에 토큰이 있으면 말은 보낸다.
                paired = HouseClient.shared.isPaired
            }
        }
        guard let text = link.text, HouseClient.shared.isPaired else {
            paired = HouseClient.shared.isPaired
            return
        }
        do {
            paired = true
            let stream = try await HouseClient.shared.say(text: text)
            for try await _ in stream { }
        } catch {
            paired = HouseClient.shared.isPaired
        }
    }
}

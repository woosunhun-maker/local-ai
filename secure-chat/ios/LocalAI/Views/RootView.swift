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
        do {
            if let pin = link.pin {
                try await HouseClient.shared.pair(pin: pin)
                paired = true
            }
            if let text = link.text, HouseClient.shared.isPaired {
                paired = true
                let stream = try await HouseClient.shared.say(text: text)
                for try await _ in stream { }
            }
        } catch {
            paired = HouseClient.shared.isPaired
        }
    }
}

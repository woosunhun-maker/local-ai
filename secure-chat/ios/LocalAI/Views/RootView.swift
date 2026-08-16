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
    }
}

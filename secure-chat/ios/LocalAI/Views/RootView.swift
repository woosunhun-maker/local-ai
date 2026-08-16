import SwiftUI

struct RootView: View {
    @State private var paired = HouseClient.shared.isPaired

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
        .preferredColorScheme(.dark)
    }
}

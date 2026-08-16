import SwiftUI

struct PairView: View {
    let onPaired: () -> Void

    @State private var pin = ""
    @State private var waiting = false
    @State private var busy = false
    @State private var errorText: String?
    @FocusState private var pinFocused: Bool

    var body: some View {
        ZStack {
            HouseColor.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("H")
                        .font(.system(size: 44, weight: .semibold, design: .serif))
                    Text("이 집의 문")
                        .font(.title3)
                        .foregroundStyle(HouseColor.muted)
                    Text("같은 집 와이파이에서 맥과만 붙습니다.\n대화는 맥에만 남고, 이 폰에는 쌓지 않습니다.")
                        .font(.subheadline)
                        .foregroundStyle(HouseColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(waiting ? "맥 화면에서 허용을 기다리는 중…" : "이 맥에 연결") {
                    requestJoin()
                }
                .buttonStyle(HouseButtonStyle())
                .disabled(busy)

                VStack(alignment: .leading, spacing: 10) {
                    Text("맥에 뜬 숫자 4자리")
                        .font(.caption)
                        .foregroundStyle(HouseColor.muted)
                    HStack(spacing: 12) {
                        TextField("0000", text: $pin)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .multilineTextAlignment(.center)
                            .font(.title2.monospacedDigit().weight(.semibold))
                            .focused($pinFocused)
                            .onChange(of: pin) { _, value in
                                pin = String(value.filter(\.isNumber).prefix(4))
                            }
                        Button("넣기") { submitPin() }
                            .disabled(busy || pin.count != 4)
                    }
                    .padding(14)
                    .background(HouseColor.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }

                if waiting {
                    ProgressView()
                        .tint(HouseColor.accent)
                }

                Spacer()
            }
            .padding(28)
        }
        .alert("연결 실패", isPresented: Binding(
            get: { errorText != nil },
            set: { if !$0 { errorText = nil } }
        )) {
            Button("확인", role: .cancel) {}
        } message: {
            Text(errorText ?? "")
        }
    }

    private func requestJoin() {
        guard !busy else { return }
        busy = true
        waiting = true
        Task {
            do {
                let joinId = try await HouseClient.shared.requestJoin()
                for _ in 0..<90 {
                    if try await HouseClient.shared.waitJoin(id: joinId) != nil {
                        onPaired()
                        return
                    }
                    try await Task.sleep(for: .seconds(2))
                }
                errorText = "맥에서 허용이 안 됐습니다. 다시 눌러 주세요."
            } catch {
                errorText = error.localizedDescription
            }
            busy = false
            waiting = false
        }
    }

    private func submitPin() {
        guard !busy, pin.count == 4 else { return }
        busy = true
        pinFocused = false
        Task {
            do {
                try await HouseClient.shared.pair(pin: pin)
                onPaired()
            } catch {
                errorText = error.localizedDescription
                busy = false
            }
        }
    }
}

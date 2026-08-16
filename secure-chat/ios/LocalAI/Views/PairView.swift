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
            HouseColor.paper.ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer(minLength: 36)
                VStack(spacing: 14) {
                    Text("H")
                        .font(.system(size: 64, weight: .medium, design: .serif))
                        .foregroundStyle(HouseColor.ink)
                    Text("집")
                        .font(.title3)
                        .foregroundStyle(HouseColor.mute)
                    Text("같은 와이파이에서 맥과만 만납니다.\n말은 맥에 남고, 이 폰에는 쌓지 않습니다.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(HouseColor.mute)
                        .lineSpacing(4)
                }

                Spacer(minLength: 40)

                Button(waiting ? "맥에서 이 폰을 허용해 주세요" : "이 맥에 연결") {
                    requestJoin()
                }
                .buttonStyle(HouseButtonStyle())
                .disabled(busy)
                .padding(.horizontal, 8)

                VStack(alignment: .leading, spacing: 12) {
                    Text("또는 맥에 뜬 숫자")
                        .font(.caption)
                        .foregroundStyle(HouseColor.mute)
                    HStack(spacing: 10) {
                        ForEach(0..<4, id: \.self) { index in
                            pinSlot(at: index)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { pinFocused = true }
                    TextField("", text: $pin)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .focused($pinFocused)
                        .frame(width: 1, height: 1)
                        .opacity(0.01)
                        .onChange(of: pin) { _, value in
                            pin = String(value.filter(\.isNumber).prefix(4))
                            if pin.count == 4 { submitPin() }
                        }
                }
                .padding(.top, 28)

                if waiting {
                    ProgressView()
                        .padding(.top, 24)
                        .tint(HouseColor.ink)
                }

                Spacer()
            }
            .padding(32)
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

    private func pinSlot(at index: Int) -> some View {
        let digit = pin.dropFirst(index).first.map(String.init) ?? ""
        return Text(digit)
            .font(.title.monospacedDigit().weight(.medium))
            .foregroundStyle(HouseColor.ink)
            .frame(maxWidth: .infinity)
            .frame(height: 64)
            .background(HouseColor.sheet, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(pinFocused && pin.count == index ? HouseColor.ink : HouseColor.rule, lineWidth: 1)
            )
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

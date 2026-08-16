import SwiftUI

enum HouseColor {
    /// 따뜻한 종이
    static let paper = Color(red: 0.965, green: 0.953, blue: 0.933)
    /// 조금 더 짙은 지
    static let sheet = Color(red: 0.933, green: 0.918, blue: 0.890)
    /// 본문 잉크
    static let ink = Color(red: 0.145, green: 0.137, blue: 0.122)
    /// 보조 글
    static let mute = Color(red: 0.45, green: 0.42, blue: 0.38)
    /// 선
    static let rule = Color(red: 0.82, green: 0.78, blue: 0.72)
    /// 내가 한 말
    static let mine = Color(red: 0.18, green: 0.22, blue: 0.27)
    /// 연결됨
    static let live = Color(red: 0.22, green: 0.48, blue: 0.36)
    /// 끊김
    static let warn = Color(red: 0.62, green: 0.28, blue: 0.18)
}

struct HouseButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(HouseColor.ink.opacity(configuration.isPressed ? 0.78 : 1), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .foregroundStyle(HouseColor.paper)
    }
}

struct HouseDot: View {
    let live: Bool

    var body: some View {
        Circle()
            .fill(live ? HouseColor.live : HouseColor.warn)
            .frame(width: 7, height: 7)
    }
}

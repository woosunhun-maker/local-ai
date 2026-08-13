import SwiftUI

enum AppTheme {
    static let background = Color(uiColor: .systemBackground)
    static let secondaryBackground = Color(uiColor: .secondarySystemBackground)
    static let tertiaryBackground = Color(uiColor: .tertiarySystemBackground)
    static let separator = Color(uiColor: .separator)
    static let elevated = secondaryBackground
    static let assistantBubble = tertiaryBackground
    static let accent = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return UIColor(red: 0.30, green: 0.86, blue: 0.72, alpha: 1)
        }
        return UIColor(red: 0.00, green: 0.43, blue: 0.36, alpha: 1)
    })
    static let onAccent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? .black : .white
    })
    static let cornerRadius: CGFloat = 18

    static let accentGradient = LinearGradient(
        colors: [accent.opacity(0.96), accent.opacity(0.78)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    static let ambientGradient = LinearGradient(
        colors: [accent.opacity(0.14), .clear],
        startPoint: .topLeading,
        endPoint: .center
    )
}

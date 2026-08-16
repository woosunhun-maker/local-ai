import Foundation

struct MirrorLink: Equatable {
    let pin: String?
    let text: String?

    init?(url: URL) {
        guard url.scheme == "localai" else { return nil }
        let host = url.host ?? url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard host == "mirror" || host == "pair" || host == "say" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let pin = items.first(where: { $0.name == "pin" })?.value
        let text = items.first(where: { $0.name == "text" })?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let pin, pin.range(of: #"^\d{4}$"#, options: .regularExpression) == nil {
            return nil
        }
        let clipped = text.map { String($0.prefix(200)) }
        if pin == nil, clipped == nil || clipped?.isEmpty == true { return nil }
        self.pin = pin
        self.text = clipped?.isEmpty == true ? nil : clipped
    }
}

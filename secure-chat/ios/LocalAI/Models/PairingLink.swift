import Foundation

struct PairingLink: Equatable {
    static let allowedHost = "macstudio.tail4ad006.ts.net"

    let secret: String

    init(payload: String) throws {
        guard let url = URL(string: payload),
              url.scheme == "https",
              url.host == Self.allowedHost,
              let fragment = url.fragment,
              let secret = URLComponents(string: "?\(fragment)")?.queryItems?.first(where: { $0.name == "pair" })?.value,
              secret.count >= 16 else {
            throw LocalAIError.invalidPairingCode
        }
        self.secret = secret
    }
}

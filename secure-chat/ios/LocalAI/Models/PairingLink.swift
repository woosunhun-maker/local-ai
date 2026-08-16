import Foundation

struct PairingLink: Equatable {
    static let allowedHosts = Set([
        "192.168.50.235",
        "macstudio.tail4ad006.ts.net",
    ])

    let secret: String

    init(payload: String) throws {
        guard let url = URL(string: payload),
              let host = url.host,
              Self.allowedHosts.contains(host),
              url.scheme == "http" || url.scheme == "https",
              (url.scheme == "https") || host == "192.168.50.235",
              let fragment = url.fragment,
              let secret = URLComponents(string: "?\(fragment)")?.queryItems?.first(where: { $0.name == "pair" })?.value,
              secret.count >= 16 else {
            throw HouseError.invalidPairingCode
        }
        self.secret = secret
    }
}

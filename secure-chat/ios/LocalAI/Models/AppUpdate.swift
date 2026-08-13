import Foundation

struct IosAppReleaseInfo: Decodable, Equatable, Sendable {
    let marketingVersion: String
    let build: String
    let updatePolicy: String
    let note: String?

    enum CodingKeys: String, CodingKey {
        case marketingVersion = "marketing_version"
        case build
        case updatePolicy = "update_policy"
        case note
    }
}

struct AppStatus: Decodable, Equatable, Sendable {
    let ok: Bool
    let iosApp: IosAppReleaseInfo?
}

struct AppUpdateState: Equatable, Sendable {
    let localVersion: String
    let localBuild: String
    let recommendedVersion: String
    let recommendedBuild: String
    let note: String?
    let updatePolicy: String

    var isBehind: Bool {
        let local = Int(localBuild)
        let recommended = Int(recommendedBuild)
        if let local, let recommended {
            return local < recommended
        }
        return localBuild != recommendedBuild && localBuild < recommendedBuild
    }

    var bannerText: String {
        "Mac에 새 앱 빌드 \(recommendedVersion) (\(recommendedBuild))가 있습니다. 현재 \(localVersion) (\(localBuild)). Personal Team은 앱이 스스로 설치하지 않으며 Mac에서 다시 올려야 합니다."
    }

    static func from(recommended: IosAppReleaseInfo?) -> AppUpdateState? {
        guard let recommended else { return nil }
        let localVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let localBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return AppUpdateState(
            localVersion: localVersion,
            localBuild: localBuild,
            recommendedVersion: recommended.marketingVersion,
            recommendedBuild: recommended.build,
            note: recommended.note,
            updatePolicy: recommended.updatePolicy
        )
    }
}

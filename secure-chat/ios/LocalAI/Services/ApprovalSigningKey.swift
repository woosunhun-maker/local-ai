import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum ApprovalSigningKeyError: LocalizedError {
    case secureEnclaveUnavailable
    case authenticationUnavailable
    case authenticationCancelled

    var errorDescription: String? {
        switch self {
        case .secureEnclaveUnavailable:
            return "Secure Enclave를 사용할 수 없어 승인 서명을 잠갔습니다. 기기를 확인한 뒤 다시 페어링해주세요."
        case .authenticationUnavailable:
            return "Face ID 또는 iPhone 암호로 소유자를 확인할 수 없습니다."
        case .authenticationCancelled:
            return "소유자 인증이 취소되어 승인을 완료하지 않았습니다."
        }
    }
}

/// 일반 승인(Envelope, cursor.develop, growth 등) — Codex와 동일하게 Face ID/암호 필수.
/// v2 키는 Secure Enclave `.userPresence`로 생성해, 잠금 해제만으로는 서명할 수 없다.
actor ApprovalSigningKey {
    static let shared = ApprovalSigningKey()

    /// v1은 userPresence 없이 WhenUnlocked만 사용해 Face ID를 건너뛸 수 있었음 → v2로 교체
    private let secureService = "local.privateai.approval.secure-enclave.v2"
    private let fallbackService = "local.privateai.approval.simulator.v2"
    private let account = "device-approval-key"

    func publicKeyDER() async throws -> Data {
        #if targetEnvironment(simulator)
        return try fallbackPrivateKey().publicKey.derRepresentation
        #else
        guard SecureEnclave.isAvailable else { throw ApprovalSigningKeyError.secureEnclaveUnavailable }
        let context = try await authenticatedContext(
            reason: "Local AI 승인 키를 등록하거나 확인합니다."
        )
        return try securePrivateKey(authenticationContext: context).publicKey.derRepresentation
        #endif
    }

    func sign(_ challenge: ApprovalChallenge, decision: ApprovalDecision) async throws -> Data {
        let payload = challenge.signingPayload(decision: decision)
        #if targetEnvironment(simulator)
        // 시뮬레이터는 SE/Face ID가 없어 개발·XCTest용 fallback만 사용
        return try fallbackPrivateKey().signature(for: payload).derRepresentation
        #else
        guard SecureEnclave.isAvailable else { throw ApprovalSigningKeyError.secureEnclaveUnavailable }
        let context = try await authenticatedContext(
            reason: decision == .approved
                ? "검토한 승인 요청을 허용합니다."
                : "승인 요청 거부를 서명합니다."
        )
        return try securePrivateKey(authenticationContext: context)
            .signature(for: payload)
            .derRepresentation
        #endif
    }

    private func authenticatedContext(reason: String) async throws -> LAContext {
        let context = LAContext()
        context.localizedCancelTitle = "취소"
        context.localizedFallbackTitle = "iPhone 암호 사용"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw ApprovalSigningKeyError.authenticationUnavailable
        }
        do {
            let granted = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: reason
            )
            guard granted else { throw ApprovalSigningKeyError.authenticationUnavailable }
            return context
        } catch let authenticationError as LAError {
            switch authenticationError.code {
            case .userCancel, .appCancel, .systemCancel:
                throw ApprovalSigningKeyError.authenticationCancelled
            default:
                throw ApprovalSigningKeyError.authenticationUnavailable
            }
        }
    }

    #if !targetEnvironment(simulator)
    private func securePrivateKey(authenticationContext: LAContext) throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let representation = try ApprovalKeyMaterialStore.read(service: secureService, account: account) {
            return try SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: representation,
                authenticationContext: authenticationContext
            )
        }
        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .userPresence],
            &accessError
        ) else {
            if let accessError { throw accessError.takeRetainedValue() }
            throw ApprovalSigningKeyError.authenticationUnavailable
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(
            accessControl: accessControl,
            authenticationContext: authenticationContext
        )
        try ApprovalKeyMaterialStore.write(key.dataRepresentation, service: secureService, account: account)
        return key
    }
    #endif

    #if targetEnvironment(simulator)
    private func fallbackPrivateKey() throws -> P256.Signing.PrivateKey {
        if let representation = try ApprovalKeyMaterialStore.read(service: fallbackService, account: account),
           let key = try? P256.Signing.PrivateKey(rawRepresentation: representation) {
            return key
        }
        let key = P256.Signing.PrivateKey()
        try ApprovalKeyMaterialStore.write(key.rawRepresentation, service: fallbackService, account: account)
        return key
    }
    #endif
}

private enum ApprovalKeyMaterialStore {
    static func read(service: String, account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw ApprovalKeyMaterialStatusError(status: status)
        }
        return data
    }

    static func write(_ data: Data, service: String, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw ApprovalKeyMaterialStatusError(status: updateStatus) }

        var insertion = query
        attributes.forEach { insertion[$0.key] = $0.value }
        let addStatus = SecItemAdd(insertion as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw ApprovalKeyMaterialStatusError(status: addStatus) }
    }
}

private struct ApprovalKeyMaterialStatusError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "보안 키 저장소 오류 (\(status))" }
}

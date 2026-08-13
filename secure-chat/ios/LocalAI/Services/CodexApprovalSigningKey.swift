import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum CodexApprovalSigningKeyError: LocalizedError {
    case secureEnclaveUnavailable
    case authenticationUnavailable
    case authenticationCancelled

    var errorDescription: String? {
        switch self {
        case .secureEnclaveUnavailable:
            return "Secure Enclave를 사용할 수 없어 Codex 승인을 차단했습니다."
        case .authenticationUnavailable:
            return "Face ID 또는 iPhone 암호로 소유자를 확인할 수 없습니다."
        case .authenticationCancelled:
            return "소유자 인증이 취소되어 작업을 실행하지 않았습니다."
        }
    }
}

actor CodexApprovalSigningKey {
    static let shared = CodexApprovalSigningKey()

    private let secureService = "local.privateai.codex-approval.secure-enclave.v1"
    private let fallbackService = "local.privateai.codex-approval.simulator.v1"
    private let account = "codex-owner-approval-key"

    func publicKeyDER() throws -> Data {
        #if targetEnvironment(simulator)
        return try fallbackPrivateKey().publicKey.derRepresentation
        #else
        guard SecureEnclave.isAvailable else { throw CodexApprovalSigningKeyError.secureEnclaveUnavailable }
        return try securePrivateKey(authenticationContext: LAContext()).publicKey.derRepresentation
        #endif
    }

    func sign(_ challenge: ApprovalChallenge, decision: ApprovalDecision) async throws -> Data {
        let payload = challenge.signingPayload(decision: decision)
        let context = try await authenticatedContext(for: decision)
        #if targetEnvironment(simulator)
        return try fallbackPrivateKey().signature(for: payload).derRepresentation
        #else
        guard SecureEnclave.isAvailable else { throw CodexApprovalSigningKeyError.secureEnclaveUnavailable }
        return try securePrivateKey(authenticationContext: context)
            .signature(for: payload)
            .derRepresentation
        #endif
    }

    private func authenticatedContext(for decision: ApprovalDecision) async throws -> LAContext {
        let context = LAContext()
        context.localizedCancelTitle = "취소"
        context.localizedFallbackTitle = "iPhone 암호 사용"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw CodexApprovalSigningKeyError.authenticationUnavailable
        }
        do {
            let granted = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: decision == .approved
                    ? "검토한 Codex 작업 계획을 실행합니다."
                    : "Codex 작업 거부를 서명합니다."
            )
            guard granted else { throw CodexApprovalSigningKeyError.authenticationUnavailable }
            return context
        } catch let authenticationError as LAError {
            switch authenticationError.code {
            case .userCancel, .appCancel, .systemCancel:
                throw CodexApprovalSigningKeyError.authenticationCancelled
            default:
                throw CodexApprovalSigningKeyError.authenticationUnavailable
            }
        }
    }

    #if !targetEnvironment(simulator)
    private func securePrivateKey(authenticationContext: LAContext) throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let representation = try CodexKeyMaterialStore.read(service: secureService, account: account) {
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
            throw CodexApprovalSigningKeyError.authenticationUnavailable
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(
            accessControl: accessControl,
            authenticationContext: authenticationContext
        )
        try CodexKeyMaterialStore.write(key.dataRepresentation, service: secureService, account: account)
        return key
    }
    #endif

    #if targetEnvironment(simulator)
    private func fallbackPrivateKey() throws -> P256.Signing.PrivateKey {
        if let representation = try CodexKeyMaterialStore.read(service: fallbackService, account: account) {
            return try P256.Signing.PrivateKey(rawRepresentation: representation)
        }
        let key = P256.Signing.PrivateKey()
        try CodexKeyMaterialStore.write(key.rawRepresentation, service: fallbackService, account: account)
        return key
    }
    #endif
}

private enum CodexKeyMaterialStore {
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
            throw CodexKeyMaterialStatusError(status: status)
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
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw CodexKeyMaterialStatusError(status: update) }
        var insertion = query
        attributes.forEach { insertion[$0.key] = $0.value }
        let added = SecItemAdd(insertion as CFDictionary, nil)
        guard added == errSecSuccess else { throw CodexKeyMaterialStatusError(status: added) }
    }
}

private struct CodexKeyMaterialStatusError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Codex 보안 키 저장소 오류 (\(status))" }
}

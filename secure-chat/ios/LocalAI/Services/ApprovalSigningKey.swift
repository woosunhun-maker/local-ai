import CryptoKit
import Foundation
import Security

enum ApprovalSigningKeyError: LocalizedError {
    case secureEnclaveUnavailable

    var errorDescription: String? {
        "Secure Enclave를 사용할 수 없어 승인 서명을 잠갔습니다. 기기를 확인한 뒤 다시 페어링해주세요."
    }
}

actor ApprovalSigningKey {
    static let shared = ApprovalSigningKey()

    private let secureService = "local.privateai.approval.secure-enclave.v1"
    private let fallbackService = "local.privateai.approval.simulator.v1"
    private let account = "device-approval-key"

    func publicKeyDER() throws -> Data {
        #if targetEnvironment(simulator)
        return try fallbackPrivateKey().publicKey.derRepresentation
        #else
        guard SecureEnclave.isAvailable else { throw ApprovalSigningKeyError.secureEnclaveUnavailable }
        return try securePrivateKey().publicKey.derRepresentation
        #endif
    }

    func sign(_ challenge: ApprovalChallenge, decision: ApprovalDecision) throws -> Data {
        let payload = challenge.signingPayload(decision: decision)
        #if targetEnvironment(simulator)
        return try fallbackPrivateKey().signature(for: payload).derRepresentation
        #else
        guard SecureEnclave.isAvailable else { throw ApprovalSigningKeyError.secureEnclaveUnavailable }
        return try securePrivateKey().signature(for: payload).derRepresentation
        #endif
    }

    private func securePrivateKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let representation = try KeyMaterialStore.read(service: secureService, account: account),
           let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: representation) {
            return key
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey()
        try KeyMaterialStore.write(key.dataRepresentation, service: secureService, account: account)
        return key
    }

    #if targetEnvironment(simulator)
    private func fallbackPrivateKey() throws -> P256.Signing.PrivateKey {
        if let representation = try KeyMaterialStore.read(service: fallbackService, account: account),
           let key = try? P256.Signing.PrivateKey(rawRepresentation: representation) {
            return key
        }
        let key = P256.Signing.PrivateKey()
        try KeyMaterialStore.write(key.rawRepresentation, service: fallbackService, account: account)
        return key
    }
    #endif
}

private enum KeyMaterialStore {
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
            throw OSStatusError(status: status)
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
        guard updateStatus == errSecItemNotFound else { throw OSStatusError(status: updateStatus) }

        var insertion = query
        attributes.forEach { insertion[$0.key] = $0.value }
        let addStatus = SecItemAdd(insertion as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw OSStatusError(status: addStatus) }
    }
}

private struct OSStatusError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "보안 키 저장소 오류 (\(status))" }
}

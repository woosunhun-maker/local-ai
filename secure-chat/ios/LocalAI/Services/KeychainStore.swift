import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum KeychainStore {
    private static let service = "com.hun.localai.device"
    private static let account = "device-token"

    static func saveToken(_ token: String) throws {
        guard let data = token.data(using: .utf8) else { throw HouseError.invalidCredential }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else {
            throw HouseError.invalidCredential
        }
    }

    static func token() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func removeToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum ApprovalKeyStore {
    private static let service = "com.hun.localai.approval-key"
    private static let account = "p256-v1"

    static func publicKeyDER() throws -> String {
        try loadOrCreate().publicKey.derRepresentation.base64EncodedString()
    }

    static func sign(_ message: String) async throws -> String {
        let context = LAContext()
        let reason = "이 일을 맥이 한 번만 하게 승인합니다."
        let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        guard ok else { throw HouseError.invalidCredential }
        let signature = try loadOrCreate().signature(for: Data(message.utf8))
        return signature.derRepresentation.base64EncodedString()
    }

    private static func loadOrCreate() throws -> P256.Signing.PrivateKey {
        if let existing = load() { return existing }
        let created = P256.Signing.PrivateKey()
        try save(created)
        return created
    }

    private static func load() -> P256.Signing.PrivateKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let key = try? P256.Signing.PrivateKey(rawRepresentation: data) else { return nil }
        return key
    }

    private static func save(_ key: P256.Signing.PrivateKey) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = key.rawRepresentation
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else {
            throw HouseError.invalidCredential
        }
    }
}

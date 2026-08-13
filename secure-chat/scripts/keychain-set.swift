import Foundation
import Security

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage\n".utf8))
    exit(2)
}

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
var value = FileHandle.standardInput.readDataToEndOfFile()
while value.last == 0x0A || value.last == 0x0D { value.removeLast() }
guard !value.isEmpty, value.count <= 4096 else { exit(3) }

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]
let update: [String: Any] = [
    kSecValueData as String: value,
    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
]

let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
if updateStatus == errSecSuccess { exit(0) }
guard updateStatus == errSecItemNotFound else { exit(4) }

var insertion = query
update.forEach { insertion[$0.key] = $0.value }
let addStatus = SecItemAdd(insertion as CFDictionary, nil)
guard addStatus == errSecSuccess else { exit(5) }

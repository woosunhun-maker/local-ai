import CryptoKit
import Foundation

enum CodexContract {
    static let planSchema = "local-ai.codex-task-plan.v3"
    static let executionMode = "isolated_inspect_and_draft"
    static let codexVersion = "codex-cli 0.147.0-alpha.1.2"
    static let model = "gpt-5.6-sol"
    static let reasoningEffort = "high"
    static let provider = "openai_codex"
    static let transferredData = ["task_instruction", "known_identifier_scrubbed_code_snapshot"]
    static let approvalDataCategories = ["known_identifier_scrubbed_code_snapshot", "task_instruction"]
    static let sourcePolicy = "allowlisted_known_identifier_scrubbed_code_v2"
    static let ownerSourcePermission = "read_only"
    static let draftValidation = "trusted_apply_isolated_copy_only"
    static let clientAuthentication = "codex_auth_used"
    static let maximumRequestLength = 2_000
    static let maximumSourceFileCount = 4_096
    static let maximumSourceTotalBytes = 2 * 1_024 * 1_024
    static let maximumPatchBytes = 32 * 1_024
    static let maximumChangedPaths = 20

    private static let allowedSourceRootDirectories: Set<String> = ["ios", "public", "scripts", "src", "test"]
    private static let allowedSourceRootFiles: Set<String> = ["README.md", "package.json"]
    private static let allowedTextExtensions: Set<String> = [
        ".c", ".cc", ".cfg", ".conf", ".cpp", ".css", ".csv", ".entitlements",
        ".h", ".hpp", ".htm", ".html", ".java", ".js", ".json", ".jsx", ".kt",
        ".kts", ".md", ".mjs", ".mm", ".pbxproj", ".plist", ".properties", ".py",
        ".rb", ".rs", ".sb", ".sh", ".sql", ".swift", ".text", ".toml", ".ts",
        ".tsx", ".txt", ".webmanifest", ".xcconfig", ".xcworkspacedata", ".xcscheme",
        ".xml", ".yaml", ".yml", ".zsh",
    ]
    private static let allowedExtensionlessFiles: Set<String> = [
        "brewfile", "dockerfile", "gemfile", "license", "makefile",
        "notice", "procfile", "readme", "rakefile", "security", "yarn.lock",
    ]
    private static let excludedDirectoryNames: Set<String> = [
        ".build", ".codex", ".git", ".gradle", ".idea", ".next", ".swiftpm",
        ".venv", "__pycache__", "build", "deriveddata", "dist", "node_modules", "xcuserdata",
    ]
    private static let excludedFileExtensions: Set<String> = [
        ".a", ".app", ".bin", ".class", ".dmg", ".dylib", ".gif", ".gz", ".heic",
        ".ico", ".jar", ".jpeg", ".jpg", ".jsonl", ".lockb", ".log", ".mov",
        ".mp3", ".mp4", ".ndjson", ".o", ".out", ".pdf", ".pid", ".png",
        ".pyc", ".sqlite", ".sqlite3", ".sock", ".tar", ".tiff", ".wav", ".xcarchive",
        ".xcuserstate", ".zip",
    ]
    private static let patchHunkHeaderExpression = try! NSRegularExpression(
        pattern: #"^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?$"#
    )

    private struct PatchSection {
        let path: String
        var hasIndex = false
        var isNewFile = false
        var hasOldHeader = false
        var oldIsDevNull = false
        var hasNewHeader = false
        var hasHunk = false
    }

    private struct PatchHunk {
        let oldCount: Int
        let newCount: Int
        var oldSeen = 0
        var newSeen = 0
    }

    static func normalizeRequest(_ value: String) throws -> String {
        let normalized = value.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.utf16.count <= maximumRequestLength,
              !containsUnsafeText(normalized) else {
            throw LocalAIError.malformedResponse
        }
        return normalized
    }

    static func requestIsValid(_ value: String) -> Bool {
        (try? normalizeRequest(value)) != nil
    }

    static func isTaskID(_ value: String) -> Bool {
        value.range(
            of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#,
            options: .regularExpression
        ) != nil
    }

    static func isIdempotencyKey(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{16,128}$"#, options: .regularExpression) != nil
    }

    static func isDigest(_ value: String) -> Bool {
        value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
    }

    static func date(from value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    static func containsUnsafeText(_ value: String) -> Bool {
        value.unicodeScalars.contains { scalar in
            let code = scalar.value
            let blockedControl =
                (code <= 0x08) || code == 0x0B || code == 0x0C ||
                (0x0E...0x1F).contains(code) || (0x7F...0x9F).contains(code)
            return blockedControl || scalar.properties.generalCategory == .format
        }
    }

    static func isAllowedChangedPath(_ value: String) -> Bool {
        guard value.utf16.count <= 180,
              value == value.precomposedStringWithCanonicalMapping,
              value.range(of: #"^[A-Za-z0-9_./@+-]+$"#, options: .regularExpression) != nil,
              !value.hasPrefix("/"), !value.contains("\\") else {
            return false
        }
        let components = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !components.isEmpty,
              !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            return false
        }
        if components.count == 1 { return allowedSourceRootFiles.contains(value) }
        guard let root = components.first, allowedSourceRootDirectories.contains(root) else { return false }
        for directory in components.dropLast() {
            let lowered = directory.lowercased()
            if lowered == ".env" || lowered.hasPrefix(".env.") || excludedDirectoryNames.contains(lowered) {
                return false
            }
        }
        guard let filename = components.last else { return false }
        let lowered = filename.lowercased()
        if lowered == "agents.md" || lowered == "agents.override.md" ||
            lowered == ".gitattributes" || lowered == ".gitmodules" ||
            lowered == ".env" || lowered.hasPrefix(".env.") || lowered == ".ds_store" ||
            lowered.hasSuffix(".db") || lowered.hasSuffix(".db-shm") || lowered.hasSuffix(".db-wal") {
            return false
        }
        let pathExtension = (lowered as NSString).pathExtension
        let dottedExtension = pathExtension.isEmpty ? "" : ".\(pathExtension)"
        if dottedExtension == ".md" || excludedFileExtensions.contains(dottedExtension) { return false }
        return allowedTextExtensions.contains(dottedExtension) || allowedExtensionlessFiles.contains(lowered)
    }

    static func pathsExtractedFromPatch(_ patch: String) -> [String]? {
        guard !patch.isEmpty,
              Data(patch.utf8).count <= maximumPatchBytes,
              patch == patch.precomposedStringWithCanonicalMapping,
              patch.hasSuffix("\n"), !patch.hasPrefix("\u{FEFF}"),
              !patch.contains("\r"), !patch.contains("\u{FFFD}"),
              !containsUnsafeText(patch) else {
            return nil
        }
        let lines = String(patch.dropLast()).components(separatedBy: "\n")
        guard lines.first?.hasPrefix("diff --git a/") == true,
              lines.allSatisfy({ $0.utf16.count <= 12_000 }) else { return nil }

        var paths: [String] = []
        var section: PatchSection?
        var hunk: PatchHunk?
        var hunkCount = 0
        var changedLineCount = 0
        var previousHunkData = false

        func hunkIsComplete(_ value: PatchHunk?) -> Bool {
            guard let value else { return false }
            return value.oldSeen == value.oldCount && value.newSeen == value.newCount
        }

        func sectionIsComplete(_ value: PatchSection?, hunk: PatchHunk?) -> Bool {
            guard let value,
                  hunk == nil || hunkIsComplete(hunk),
                  value.hasIndex, value.hasOldHeader, value.hasNewHeader, value.hasHunk,
                  value.isNewFile == value.oldIsDevNull else {
                return false
            }
            return true
        }

        for line in lines {
            if line.hasPrefix("diff --git ") {
                guard section == nil || sectionIsComplete(section, hunk: hunk) else { return nil }
                let prefix = "diff --git a/"
                guard line.hasPrefix(prefix) else { return nil }
                let remainder = line.dropFirst(prefix.count)
                guard let separator = remainder.range(of: " b/") else { return nil }
                let oldPath = String(remainder[..<separator.lowerBound])
                let newPath = String(remainder[separator.upperBound...])
                guard oldPath == newPath, !oldPath.hasPrefix("-"),
                      isAllowedChangedPath(oldPath), !paths.contains(oldPath),
                      paths.count < maximumChangedPaths else { return nil }
                paths.append(oldPath)
                section = PatchSection(path: oldPath)
                hunk = nil
                continue
            }

            guard var currentSection = section else { return nil }
            if line.hasPrefix("@@ ") {
                guard currentSection.hasOldHeader, currentSection.hasNewHeader,
                      hunk == nil || hunkIsComplete(hunk),
                      let counts = patchHunkCounts(line),
                      counts.old != 0 || counts.new != 0 else { return nil }
                hunkCount += 1
                guard hunkCount <= 100 else { return nil }
                hunk = PatchHunk(oldCount: counts.old, newCount: counts.new)
                currentSection.hasHunk = true
                section = currentSection
                previousHunkData = false
                continue
            }

            if var currentHunk = hunk {
                if line == "\\ No newline at end of file" {
                    guard previousHunkData else { return nil }
                    previousHunkData = false
                    continue
                }
                guard let prefix = line.first else { return nil }
                switch prefix {
                case " ":
                    currentHunk.oldSeen += 1
                    currentHunk.newSeen += 1
                case "-":
                    currentHunk.oldSeen += 1
                    changedLineCount += 1
                case "+":
                    currentHunk.newSeen += 1
                    changedLineCount += 1
                default:
                    return nil
                }
                guard currentHunk.oldSeen <= currentHunk.oldCount,
                      currentHunk.newSeen <= currentHunk.newCount,
                      changedLineCount <= 2_000 else { return nil }
                hunk = currentHunk
                previousHunkData = true
                continue
            }

            if line == "new file mode 100644",
               !currentSection.hasIndex, !currentSection.hasOldHeader, !currentSection.isNewFile {
                currentSection.isNewFile = true
            } else if line.range(
                of: #"^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: 100644)?$"#,
                options: .regularExpression
            ) != nil, !currentSection.hasIndex, !currentSection.hasOldHeader {
                currentSection.hasIndex = true
            } else if line.hasPrefix("--- "),
                      !currentSection.hasOldHeader, !currentSection.hasNewHeader {
                guard line == "--- a/\(currentSection.path)" || line == "--- /dev/null" else { return nil }
                currentSection.hasOldHeader = true
                currentSection.oldIsDevNull = line == "--- /dev/null"
            } else if line.hasPrefix("+++ "),
                      currentSection.hasOldHeader, !currentSection.hasNewHeader {
                guard line == "+++ b/\(currentSection.path)" else { return nil }
                currentSection.hasNewHeader = true
            } else {
                return nil
            }
            section = currentSection
        }

        guard !paths.isEmpty, sectionIsComplete(section, hunk: hunk) else { return nil }
        return paths
    }

    static func canonicalPlanPayload(_ plan: CodexTaskPlan) -> String {
        let transferredData = plan.execution.transferredData.map(jsonString).joined(separator: ",")
        return "{" +
            "\"schema\":\(jsonString(plan.schema))," +
            "\"taskId\":\(jsonString(plan.taskId))," +
            "\"ownerDeviceHash\":\(jsonString(plan.ownerDeviceHash))," +
            "\"idempotencyKey\":\(jsonString(plan.idempotencyKey))," +
            "\"intent\":\(jsonString(plan.intent.rawValue))," +
            "\"request\":\(jsonString(plan.request))," +
            "\"sourceManifestSha256\":\(jsonString(plan.sourceManifestSha256))," +
            "\"sourceFileCount\":\(plan.sourceFileCount)," +
            "\"sourceTotalBytes\":\(plan.sourceTotalBytes)," +
            "\"execution\":{" +
            "\"mode\":\(jsonString(plan.execution.mode))," +
            "\"codexVersion\":\(jsonString(plan.execution.codexVersion))," +
            "\"model\":\(jsonString(plan.execution.model))," +
            "\"reasoningEffort\":\(jsonString(plan.execution.reasoningEffort))," +
            "\"provider\":\(jsonString(plan.execution.provider))," +
            "\"externalTransfer\":\(plan.execution.externalTransfer)," +
            "\"transferredData\":[\(transferredData)]," +
            "\"sourcePolicy\":\(jsonString(plan.execution.sourcePolicy))," +
            "\"ownerSourcePermission\":\(jsonString(plan.execution.ownerSourcePermission))," +
            "\"draftValidation\":\(jsonString(plan.execution.draftValidation))," +
            "\"toolNetwork\":\(plan.execution.toolNetwork)," +
            "\"modelHostFileTools\":\(plan.execution.modelHostFileTools)," +
            "\"osProcessSandbox\":\(plan.execution.osProcessSandbox)," +
            "\"clientAuthentication\":\(jsonString(plan.execution.clientAuthentication))," +
            "\"sourceApply\":\(plan.execution.sourceApply)}}"
    }

    private static func jsonString(_ value: String) -> String {
        var encoded = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x08: encoded += #"\b"#
            case 0x09: encoded += #"\t"#
            case 0x0A: encoded += #"\n"#
            case 0x0C: encoded += #"\f"#
            case 0x0D: encoded += #"\r"#
            case 0x22: encoded += #"\""#
            case 0x5C: encoded += #"\\"#
            case 0x00...0x1F:
                encoded += String(format: "\\u%04x", scalar.value)
            default:
                encoded.unicodeScalars.append(scalar)
            }
        }
        encoded += "\""
        return encoded
    }

    private static func patchHunkCounts(_ line: String) -> (old: Int, new: Int)? {
        let fullRange = NSRange(location: 0, length: line.utf16.count)
        guard let match = patchHunkHeaderExpression.firstMatch(in: line, range: fullRange),
              match.range == fullRange else { return nil }
        let value = line as NSString

        func integer(at index: Int, default defaultValue: Int? = nil) -> Int? {
            let range = match.range(at: index)
            if range.location == NSNotFound { return defaultValue }
            return Int(value.substring(with: range))
        }

        guard integer(at: 1) != nil, integer(at: 3) != nil,
              let oldCount = integer(at: 2, default: 1),
              let newCount = integer(at: 4, default: 1) else { return nil }
        return (oldCount, newCount)
    }
}

enum CodexTaskIntent: String, Codable, CaseIterable, Identifiable, Sendable {
    case inspect
    case draft

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inspect: return "점검"
        case .draft: return "변경 초안"
        }
    }

    var detail: String {
        switch self {
        case .inspect: return "OpenAI Codex가 허용 목록 코드에서 알려진 식별자를 검사·치환한 복사본을 읽고 문제와 개선점만 보고합니다."
        case .draft: return "OpenAI Codex가 격리 복사본에서만 초안을 만들며 실제 Mac 소스에는 적용하지 않습니다."
        }
    }
}

enum CodexTaskStatus: String, Codable, Sendable {
    case awaitingApproval = "awaiting_approval"
    case queued
    case running
    case succeeded
    case failed
    case interruptedUncertain = "interrupted_uncertain"
    case rejected
    case expired

    var title: String {
        switch self {
        case .awaitingApproval: return "승인 대기"
        case .queued: return "실행 대기"
        case .running: return "실행 중"
        case .succeeded: return "완료"
        case .failed: return "실패"
        case .interruptedUncertain: return "중단됨·확인 필요"
        case .rejected: return "거부됨"
        case .expired: return "만료됨"
        }
    }

    var isTerminal: Bool {
        switch self {
        case .succeeded, .failed, .interruptedUncertain, .rejected, .expired: return true
        case .awaitingApproval, .queued, .running: return false
        }
    }
}

private struct CodexAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

struct CodexTaskResult: Codable, Equatable, Sendable {
    let code: String
    let summary: String
    let changedFileCount: Int
    let changedPaths: [String]
    let patch: String?
    let patchSha256: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case code, summary, changedFileCount, changedPaths, patch, patchSha256
    }

    init(
        code: String,
        summary: String,
        changedFileCount: Int,
        changedPaths: [String],
        patch: String?,
        patchSha256: String?
    ) {
        self.code = code
        self.summary = summary
        self.changedFileCount = changedFileCount
        self.changedPaths = changedPaths
        self.patch = patch
        self.patchSha256 = patchSha256
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.container(keyedBy: CodexAnyCodingKey.self)
        let actualKeys = Set(raw.allKeys.map(\.stringValue))
        let expectedKeys = Set(CodingKeys.allCases.map(\.rawValue))
        guard actualKeys == expectedKeys else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Unexpected Codex result keys"
            ))
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        summary = try container.decode(String.self, forKey: .summary)
        changedFileCount = try container.decode(Int.self, forKey: .changedFileCount)
        changedPaths = try container.decode([String].self, forKey: .changedPaths)
        patch = try container.decodeIfPresent(String.self, forKey: .patch)
        patchSha256 = try container.decodeIfPresent(String.self, forKey: .patchSha256)
    }

    func validated(intent: CodexTaskIntent, status: CodexTaskStatus) throws -> Self {
        let normalizedSummary = summary.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.range(of: #"^[A-Za-z0-9._-]{1,64}$"#, options: .regularExpression) != nil,
              !normalizedSummary.isEmpty, normalizedSummary == summary,
              summary.utf16.count <= 1_500,
              !CodexContract.containsUnsafeText(summary),
              (0...CodexContract.maximumChangedPaths).contains(changedFileCount),
              changedPaths.count == changedFileCount,
              changedPaths == changedPaths.sorted(),
              Set(changedPaths).count == changedPaths.count,
              changedPaths.allSatisfy(CodexContract.isAllowedChangedPath) else {
            throw LocalAIError.malformedResponse
        }
        let hasValidatedChanges = intent == .draft && status == .succeeded && changedFileCount > 0
        if hasValidatedChanges {
            guard let patch, let patchSha256,
                  CodexContract.isDigest(patchSha256),
                  SHA256.hash(data: Data(patch.utf8)).map({ String(format: "%02x", $0) }).joined() == patchSha256,
                  let patchPaths = CodexContract.pathsExtractedFromPatch(patch),
                  patchPaths.sorted() == changedPaths else {
                throw LocalAIError.malformedResponse
            }
        } else if changedFileCount != 0 || !changedPaths.isEmpty || patch != nil || patchSha256 != nil {
            throw LocalAIError.malformedResponse
        }
        return self
    }
}

struct CodexTask: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let status: CodexTaskStatus
    let intent: CodexTaskIntent
    let planSha256: String
    let approvalRequestId: String
    let createdAt: String
    let updatedAt: String
    let startedAt: String?
    let finishedAt: String?
    let result: CodexTaskResult?

    func validated() throws -> Self {
        guard CodexContract.isTaskID(id), approvalRequestId == id,
              CodexContract.isDigest(planSha256),
              let created = CodexContract.date(from: createdAt),
              let updated = CodexContract.date(from: updatedAt),
              updated >= created else {
            throw LocalAIError.malformedResponse
        }

        switch status {
        case .awaitingApproval, .queued:
            guard startedAt == nil, finishedAt == nil, result == nil else {
                throw LocalAIError.malformedResponse
            }
        case .running:
            guard let startedAt, let started = CodexContract.date(from: startedAt),
                  started >= created, updated >= started,
                  finishedAt == nil, result == nil else {
                throw LocalAIError.malformedResponse
            }
        case .rejected, .expired:
            guard startedAt == nil, result == nil,
                  let finishedAt, let finished = CodexContract.date(from: finishedAt),
                  finished >= created, updated >= finished else {
                throw LocalAIError.malformedResponse
            }
        case .succeeded, .failed, .interruptedUncertain:
            guard let startedAt, let started = CodexContract.date(from: startedAt),
                  let finishedAt, let finished = CodexContract.date(from: finishedAt),
                  started >= created, finished >= started, updated >= finished,
                  let result else {
                throw LocalAIError.malformedResponse
            }
            _ = try result.validated(intent: intent, status: status)
        }
        return self
    }

    func hasSameIdentity(as other: CodexTask) -> Bool {
        id == other.id && intent == other.intent &&
            planSha256 == other.planSha256 && approvalRequestId == other.approvalRequestId
    }
}

struct CodexExecutionContract: Codable, Equatable, Sendable {
    let mode: String
    let codexVersion: String
    let model: String
    let reasoningEffort: String
    let provider: String
    let externalTransfer: Bool
    let transferredData: [String]
    let sourcePolicy: String
    let ownerSourcePermission: String
    let draftValidation: String
    let toolNetwork: Bool
    let modelHostFileTools: Bool
    let osProcessSandbox: Bool
    let clientAuthentication: String
    let sourceApply: Bool
}

struct CodexTaskPlan: Codable, Equatable, Sendable {
    let schema: String
    let taskId: String
    let ownerDeviceHash: String
    let idempotencyKey: String
    let intent: CodexTaskIntent
    let request: String
    let sourceManifestSha256: String
    let sourceFileCount: Int
    let sourceTotalBytes: Int
    let execution: CodexExecutionContract
}

struct CodexTaskPlanExpectation: Equatable, Sendable {
    let intent: CodexTaskIntent
    let request: String
    let idempotencyKey: String

    init(intent: CodexTaskIntent, request: String, idempotencyKey: String) throws {
        let normalized = try CodexContract.normalizeRequest(request)
        guard CodexContract.isIdempotencyKey(idempotencyKey) else {
            throw LocalAIError.malformedResponse
        }
        self.intent = intent
        self.request = normalized
        self.idempotencyKey = idempotencyKey
    }
}

struct CodexTaskCreationAttempt: Equatable, Sendable {
    let expectation: CodexTaskPlanExpectation

    static func prepare(
        reusing current: Self?,
        intent: CodexTaskIntent,
        request: String
    ) throws -> Self {
        let normalized = try CodexContract.normalizeRequest(request)
        if let current,
           current.expectation.intent == intent,
           current.expectation.request == normalized {
            return current
        }
        return try Self(expectation: CodexTaskPlanExpectation(
            intent: intent,
            request: normalized,
            idempotencyKey: UUID().uuidString
        ))
    }
}

struct CodexTaskCreateResponse: Decodable, Sendable {
    let task: CodexTask
    let approval: PendingApproval?

    func validated(
        expected: CodexTaskPlanExpectation,
        now: Date = Date()
    ) throws -> Self {
        let validatedTask = try task.validated()
        guard validatedTask.intent == expected.intent else {
            throw LocalAIError.malformedResponse
        }
        if validatedTask.status == .awaitingApproval {
            guard let approval else { throw LocalAIError.malformedResponse }
            _ = try approval.validatedCodexPlan(for: validatedTask, expected: expected, now: now)
        } else if approval != nil {
            throw LocalAIError.malformedResponse
        }
        return Self(task: validatedTask, approval: approval)
    }
}

struct CodexTaskDetailResponse: Decodable, Sendable {
    let task: CodexTask
    let approval: PendingApproval?
}

struct CodexTaskListResponse: Decodable, Sendable {
    let tasks: [CodexTask]
}

struct CodexTaskDecisionResponse: Decodable, Sendable {
    let id: String
    let status: String
    let payloadSha256: String
    let task: CodexTask
}

extension PendingApproval {
    func validatedCodexPlan(
        for task: CodexTask,
        expected: CodexTaskPlanExpectation? = nil,
        now: Date = Date()
    ) throws -> CodexTaskPlan {
        _ = try task.validated()
        guard task.status == .awaitingApproval,
              kind == "codex.execute", status == "pending",
              CodexContract.isTaskID(id), id == task.approvalRequestId,
              CodexContract.isDigest(payloadSha256), payloadHashMatches,
              payloadSha256 == task.planSha256,
              nonce.range(of: #"^[A-Za-z0-9_-]{32,128}$"#, options: .regularExpression) != nil,
              let created = CodexContract.date(from: createdAt),
              let expires = CodexContract.date(from: expiresAt),
              expires > created, expires.timeIntervalSince(created) <= 24 * 60 * 60,
              expires > now,
              payload.utf16.count <= 16_000 else {
            throw LocalAIError.payloadIntegrityMismatch
        }
        guard dataCategories == CodexContract.approvalDataCategories else {
            throw LocalAIError.payloadIntegrityMismatch
        }

        let data = Data(payload.utf8)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == [
                  "schema", "taskId", "ownerDeviceHash", "idempotencyKey", "intent", "request",
                  "sourceManifestSha256", "sourceFileCount", "sourceTotalBytes", "execution",
              ],
              let execution = root["execution"] as? [String: Any],
              Set(execution.keys) == [
                  "mode", "codexVersion", "model", "reasoningEffort", "provider", "externalTransfer",
                  "transferredData", "sourcePolicy", "ownerSourcePermission", "draftValidation",
                  "toolNetwork", "modelHostFileTools", "osProcessSandbox", "clientAuthentication", "sourceApply",
              ] else {
            throw LocalAIError.payloadIntegrityMismatch
        }

        let plan = try JSONDecoder().decode(CodexTaskPlan.self, from: data)
        guard plan.schema == CodexContract.planSchema,
              plan.taskId == task.id,
              CodexContract.isDigest(plan.ownerDeviceHash),
              CodexContract.isIdempotencyKey(plan.idempotencyKey),
              plan.intent == task.intent,
              plan.request == (try CodexContract.normalizeRequest(plan.request)),
              CodexContract.isDigest(plan.sourceManifestSha256),
              (0...CodexContract.maximumSourceFileCount).contains(plan.sourceFileCount),
              (0...CodexContract.maximumSourceTotalBytes).contains(plan.sourceTotalBytes),
              plan.execution.mode == CodexContract.executionMode,
              plan.execution.codexVersion == CodexContract.codexVersion,
              plan.execution.model == CodexContract.model,
              plan.execution.reasoningEffort == CodexContract.reasoningEffort,
              plan.execution.provider == CodexContract.provider,
              plan.execution.externalTransfer == true,
              plan.execution.transferredData == CodexContract.transferredData,
              plan.execution.sourcePolicy == CodexContract.sourcePolicy,
              plan.execution.ownerSourcePermission == CodexContract.ownerSourcePermission,
              plan.execution.draftValidation == CodexContract.draftValidation,
              plan.execution.toolNetwork == false,
              plan.execution.modelHostFileTools == false,
              plan.execution.osProcessSandbox == false,
              plan.execution.clientAuthentication == CodexContract.clientAuthentication,
              plan.execution.sourceApply == false,
              CodexContract.canonicalPlanPayload(plan) == payload else {
            throw LocalAIError.payloadIntegrityMismatch
        }
        if let expected {
            guard plan.intent == expected.intent,
                  plan.request == expected.request,
                  plan.idempotencyKey == expected.idempotencyKey else {
                throw LocalAIError.payloadIntegrityMismatch
            }
        }
        return plan
    }
}

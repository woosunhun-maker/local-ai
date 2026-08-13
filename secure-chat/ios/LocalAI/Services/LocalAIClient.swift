import Foundation

enum ChatMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case auto
    case fast
    case deep

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return "로컬 기본"
        case .fast: return "빠른 대화"
        case .deep: return "도구/깊은 작업"
        }
    }

    var subtitle: String {
        switch self {
        case .auto: return "로컬만 답함. 다른 AI 대행은 보내기 전 체크"
        case .fast: return "로컬에서 빠르게 답변"
        case .deep: return "명시적으로 고른 경우만 도구·깊은 추론 (자동 전환 없음)"
        }
    }

    var symbol: String {
        switch self {
        case .auto: return "wand.and.stars"
        case .fast: return "bolt.fill"
        case .deep: return "brain.head.profile"
        }
    }
}

struct TelegramCommunicationStatus: Decodable, Equatable, Sendable {
    let configured: Bool
    let enabled: Bool
    let running: Bool
    let mode: String
    let botUsername: String?
    let status: String?
}

struct BrowserCommunicationStatus: Decodable, Equatable, Sendable {
    let profile: String
    let connected: Bool
    let sharedTabs: Int
}

struct CodexBridgeCommunicationStatus: Decodable, Equatable, Sendable {
    let configured: Bool
    let enabled: Bool
    let running: Bool
    let mode: String
    let status: String?
}

struct WebTaskCommunicationStatus: Decodable, Equatable, Sendable {
    let policy: String
    let stage: String
    let preparedActions: [String]
    let blockedFinalActions: [String]
}

struct CommunicationStatus: Decodable, Equatable, Sendable {
    let telegram: TelegramCommunicationStatus
    let codexBridge: CodexBridgeCommunicationStatus?
    let browser: BrowserCommunicationStatus
    let webTasks: WebTaskCommunicationStatus?
    let privilegedIngress: String
    let blockedInTelegram: [String]
}

struct ConfirmedMemoryItem: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let text: String
    let status: String
    let shareExternal: Bool

    enum CodingKeys: String, CodingKey {
        case id, text, status
        case shareExternal = "share_external"
    }
}

struct ConfirmedMemorySnapshot: Decodable, Equatable, Sendable {
    let active: [ConfirmedMemoryItem]
    let candidates: [ConfirmedMemoryItem]
    let count: Int
}

struct TelegramConfigurationResult: Decodable, Equatable, Sendable {
    let configured: Bool
    let enabled: Bool
    let botUsername: String
    let mode: String
}

enum LocalAIError: LocalizedError {
    case invalidPairingCode
    case invalidCredential
    case notPaired
    case rejected(Int)
    case malformedResponse
    case server(String)
    case interrupted
    case payloadIntegrityMismatch

    var errorDescription: String? {
        switch self {
        case .invalidPairingCode: return "이 Mac에서 만든 유효한 페어링 QR이 아닙니다."
        case .invalidCredential: return "기기 보안 키를 저장할 수 없습니다."
        case .notPaired: return "먼저 Mac과 페어링해야 합니다."
        case .rejected(let code):
            switch code {
            case 401: return "Mac 연결 인증이 만료됐습니다. 다시 페어링해주세요."
            case 403: return "기기 서명을 확인하지 못해 요청을 거부했습니다."
            case 404: return "요청이 만료됐거나 더 이상 존재하지 않습니다."
            case 409: return "이미 처리됐거나 현재 상태와 충돌하는 요청입니다."
            case 429: return "요청이 너무 많습니다. 잠시 후 다시 시도해주세요."
            case 502...599: return "Mac의 로컬 AI 서비스가 일시적으로 응답하지 않습니다."
            default: return "Mac이 요청을 거부했습니다. (HTTP \(code))"
            }
        case .malformedResponse: return "Mac의 응답 형식을 읽지 못했습니다."
        case .server(let message): return message
        case .interrupted: return "응답이 끝나기 전에 연결이 중단됐습니다."
        case .payloadIntegrityMismatch: return "승인할 내용의 해시가 일치하지 않아 처리를 차단했습니다."
        }
    }
}

actor LocalAIClient {
    static let shared = LocalAIClient()

    private let baseURL = URL(string: "https://macstudio.tail4ad006.ts.net")!
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = true
            configuration.timeoutIntervalForRequest = 30
            configuration.timeoutIntervalForResource = 620
            self.session = URLSession(configuration: configuration)
        }
    }

    nonisolated var isPaired: Bool { KeychainStore.token() != nil }

    nonisolated func forgetPairing() {
        KeychainStore.removeToken()
    }

    func pair(using payload: String) async throws {
        let pairingLink = try PairingLink(payload: payload)

        struct PairRequest: Encodable { let secret: String; let deviceName: String }
        struct PairResponse: Decodable { let deviceToken: String }
        let response: PairResponse = try await request(
            path: "/api/pair",
            method: "POST",
            body: PairRequest(secret: pairingLink.secret, deviceName: "iPhone Native Local AI"),
            authenticated: false
        )
        try KeychainStore.saveToken(response.deviceToken)
    }

    func ask(_ question: String, mode: ChatMode = .auto) async throws -> String {
        try await ask(messages: [ChatMessage(role: .user, content: question)], mode: mode)
    }

    func ask(messages: [ChatMessage], mode: ChatMode = .auto) async throws -> String {
        struct WireMessage: Codable { let role: String; let content: String }
        struct ChatRequest: Encodable { let messages: [WireMessage]; let stream: Bool; let mode: ChatMode }
        struct ChatResponse: Decodable {
            struct Choice: Decodable { struct Message: Decodable { let content: String }; let message: Message }
            let choices: [Choice]
        }
        let context = messages
            .filter { $0.role == .user || $0.role == .assistant }
            .suffix(40)
            .map { WireMessage(role: $0.role.rawValue, content: $0.content) }
        guard !context.isEmpty else { throw LocalAIError.malformedResponse }
        let response: ChatResponse = try await request(
            path: "/api/chat",
            method: "POST",
            body: ChatRequest(messages: Array(context), stream: false, mode: mode)
        )
        guard let answer = response.choices.first?.message.content, !answer.isEmpty else {
            throw LocalAIError.malformedResponse
        }
        return answer
    }

    func stream(messages: [ChatMessage], mode: ChatMode = .auto) throws -> AsyncThrowingStream<ChatStreamEvent, Error> {
        struct WireMessage: Encodable { let role: String; let content: String }
        struct ChatRequest: Encodable { let messages: [WireMessage]; let stream: Bool; let mode: ChatMode }
        struct StreamChunk: Decodable {
            struct Choice: Decodable {
                struct Delta: Decodable { let content: String? }
                let delta: Delta
            }
            let choices: [Choice]
        }
        struct StreamError: Decodable { let message: String }

        let context = messages
            .filter { $0.role == .user || $0.role == .assistant }
            .suffix(40)
            .map { WireMessage(role: $0.role.rawValue, content: $0.content) }
        guard !context.isEmpty else { throw LocalAIError.malformedResponse }
        guard let token = KeychainStore.token() else { throw LocalAIError.notPaired }

        var request = URLRequest(url: baseURL.appending(path: "/api/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(ChatRequest(messages: Array(context), stream: true, mode: mode))
        let session = self.session

        return AsyncThrowingStream { continuation in
            let networkTask = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw LocalAIError.malformedResponse }
                    guard (200..<300).contains(http.statusCode) else { throw LocalAIError.rejected(http.statusCode) }
                    var eventName = "message"
                    var dataLines: [String] = []
                    var receivedDone = false

                    func emitEvent() throws -> Bool {
                        guard !dataLines.isEmpty else {
                            eventName = "message"
                            return false
                        }
                        let payload = dataLines.joined(separator: "\n")
                        defer {
                            eventName = "message"
                            dataLines.removeAll(keepingCapacity: true)
                        }
                        if payload == "[DONE]" || eventName == "done" {
                            return true
                        }
                        guard let data = payload.data(using: .utf8) else { return false }
                        if eventName == "status" {
                            continuation.yield(.progress(try JSONDecoder().decode(ChatProgress.self, from: data)))
                            return false
                        }
                        if eventName == "error" {
                            let failure = try JSONDecoder().decode(StreamError.self, from: data)
                            throw LocalAIError.server(failure.message)
                        }
                        if let chunk = try? JSONDecoder().decode(StreamChunk.self, from: data),
                           let content = chunk.choices.first?.delta.content,
                           !content.isEmpty {
                            continuation.yield(.delta(content))
                        }
                        return false
                    }

                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        if line.isEmpty {
                            if try emitEvent(), !receivedDone {
                                receivedDone = true
                                continuation.yield(.finished)
                            }
                        } else if line.hasPrefix("event:") {
                            eventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            dataLines.append(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    if try emitEvent(), !receivedDone {
                        receivedDone = true
                        continuation.yield(.finished)
                    }
                    guard receivedDone else { throw LocalAIError.interrupted }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in networkTask.cancel() }
        }
    }

    func checkStatus() async throws {
        _ = try await fetchAppStatus()
    }

    func fetchAppStatus() async throws -> AppStatus {
        let status: AppStatus = try await request(path: "/api/status")
        guard status.ok else { throw LocalAIError.malformedResponse }
        return status
    }

    func checkApprovalKeyStatus() async -> ApprovalKeyState {
        do {
            try await registerApprovalKey()
            return .ready
        } catch LocalAIError.rejected(let code) where code == 401 || code == 409 {
            return .repairRequired
        } catch is ApprovalSigningKeyError {
            return .repairRequired
        } catch {
            return .unavailable
        }
    }

    func registerApprovalKey() async throws {
        struct Registration: Encodable { let publicKeyDER: String }
        struct RegistrationResponse: Decodable { let created: Bool }
        let publicKey = try await ApprovalSigningKey.shared.publicKeyDER()
        let _: RegistrationResponse = try await request(
            path: "/api/approval-key",
            method: "POST",
            body: Registration(publicKeyDER: publicKey.base64EncodedString())
        )
    }

    func fetchPendingApprovals() async throws -> [PendingApproval] {
        struct ApprovalList: Decodable { let requests: [PendingApproval] }
        let result: ApprovalList = try await request(path: "/api/approvals")
        return result.requests
    }

    func fetchDevelopmentRuns(limit: Int = 30) async throws -> [DevelopmentRunSummary] {
        let bounded = min(max(limit, 1), 100)
        struct RunList: Decodable { let runs: [DevelopmentRunSummary] }
        let result: RunList = try await request(path: "/api/development/runs?limit=\(bounded)")
        return result.runs
    }

    func fetchOwnerTasks(limit: Int = 40) async throws -> [OwnerTaskSummary] {
        let bounded = min(max(limit, 1), 100)
        struct TaskList: Decodable { let tasks: [OwnerTaskSummary] }
        let result: TaskList = try await request(path: "/api/tasks?limit=\(bounded)")
        return result.tasks
    }

    func decide(_ requestValue: PendingApproval, decision: ApprovalDecision) async throws {
        struct DecisionRequest: Encodable {
            let decision: ApprovalDecision
            let signatureDER: String
        }
        struct DecisionResponse: Decodable {
            let id: String
            let status: String
            let payloadSha256: String
        }
        guard decision == .rejected || requestValue.payloadHashMatches else {
            throw LocalAIError.payloadIntegrityMismatch
        }
        let signature = try await ApprovalSigningKey.shared.sign(requestValue.challenge, decision: decision)
        let response: DecisionResponse = try await request(
            path: "/api/approvals/\(requestValue.id)/decision",
            method: "POST",
            body: DecisionRequest(decision: decision, signatureDER: signature.base64EncodedString())
        )
        guard response.id == requestValue.id,
              response.payloadSha256 == requestValue.payloadSha256,
              response.status == decision.rawValue else {
            throw LocalAIError.malformedResponse
        }
    }

    func registerCodexApprovalKey() async throws {
        struct Registration: Encodable { let publicKeyDER: String }
        struct RegistrationResponse: Decodable { let created: Bool }
        let publicKey = try await CodexApprovalSigningKey.shared.publicKeyDER()
        let _: RegistrationResponse = try await request(
            path: "/api/codex/approval-key",
            method: "POST",
            body: Registration(publicKeyDER: publicKey.base64EncodedString())
        )
    }

    func createCodexTask(
        intent: CodexTaskIntent,
        request taskRequest: String,
        idempotencyKey: String
    ) async throws -> CodexTaskCreateResponse {
        struct CreateRequest: Encodable {
            let intent: CodexTaskIntent
            let request: String
            let idempotencyKey: String
        }
        let expectation = try CodexTaskPlanExpectation(
            intent: intent,
            request: taskRequest,
            idempotencyKey: idempotencyKey
        )
        let response: CodexTaskCreateResponse = try await request(
            path: "/api/codex/tasks",
            method: "POST",
            body: CreateRequest(
                intent: intent,
                request: expectation.request,
                idempotencyKey: expectation.idempotencyKey
            )
        )
        return try response.validated(expected: expectation)
    }

    func fetchCodexTasks(limit: Int = 20) async throws -> [CodexTask] {
        let bounded = min(max(limit, 1), 50)
        let response: CodexTaskListResponse = try await request(path: "/api/codex/tasks?limit=\(bounded)")
        return try response.tasks.map { try $0.validated() }
    }

    func fetchCodexTask(id: String) async throws -> CodexTaskDetailResponse {
        guard CodexContract.isTaskID(id) else { throw LocalAIError.malformedResponse }
        let response: CodexTaskDetailResponse = try await request(path: "/api/codex/tasks/\(id)")
        let validatedTask = try response.task.validated()
        guard validatedTask.id == id else { throw LocalAIError.malformedResponse }
        if validatedTask.status == .awaitingApproval {
            guard let approval = response.approval else { throw LocalAIError.malformedResponse }
            _ = try approval.validatedCodexPlan(for: validatedTask)
        } else if response.approval != nil {
            throw LocalAIError.malformedResponse
        }
        return CodexTaskDetailResponse(task: validatedTask, approval: response.approval)
    }

    func decideCodexTask(
        task: CodexTask,
        approval: PendingApproval,
        expectedPlan: CodexTaskPlan,
        decision: ApprovalDecision
    ) async throws -> CodexTaskDetailResponse {
        struct DecisionRequest: Encodable {
            let decision: ApprovalDecision
            let signatureDER: String
        }
        let validatedPlan = try approval.validatedCodexPlan(for: task)
        guard validatedPlan == expectedPlan else { throw LocalAIError.payloadIntegrityMismatch }
        let signature = try await CodexApprovalSigningKey.shared.sign(approval.challenge, decision: decision)
        do {
            let response: CodexTaskDecisionResponse = try await request(
                path: "/api/codex/approvals/\(approval.id)/decision",
                method: "POST",
                body: DecisionRequest(decision: decision, signatureDER: signature.base64EncodedString())
            )
            guard response.id == approval.id,
                  response.payloadSha256 == approval.payloadSha256,
                  response.status == decision.rawValue else {
                throw LocalAIError.malformedResponse
            }
            let decidedTask = try response.task.validated()
            try validateCodexDecisionTask(decidedTask, original: task, decision: decision)
            return CodexTaskDetailResponse(task: decidedTask, approval: nil)
        } catch LocalAIError.rejected(let code) where code == 409 {
            let recovered = try await fetchCodexTask(id: task.id)
            try validateCodexDecisionTask(recovered.task, original: task, decision: decision)
            return recovered
        }
    }

    private func validateCodexDecisionTask(
        _ value: CodexTask,
        original: CodexTask,
        decision: ApprovalDecision
    ) throws {
        guard value.hasSameIdentity(as: original) else { throw LocalAIError.payloadIntegrityMismatch }
        switch decision {
        case .approved:
            guard value.status == .queued || value.status == .running ||
                    value.status == .succeeded || value.status == .failed ||
                    value.status == .interruptedUncertain else {
                throw LocalAIError.malformedResponse
            }
        case .rejected:
            guard value.status == .rejected else { throw LocalAIError.malformedResponse }
        }
    }

    func fetchTTSCatalog() async throws -> TTSCatalog {
        try await request(path: "/api/tts/catalog")
    }

    func fetchGrowthStatus() async throws -> GrowthStatus {
        try await request(path: "/api/growth/status")
    }

    func fetchGrowthProposals() async throws -> [GrowthProposalSummary] {
        struct ProposalList: Decodable { let proposals: [GrowthProposalSummary] }
        let result: ProposalList = try await request(path: "/api/growth/proposals")
        return result.proposals
    }

    func fetchCommunicationStatus() async throws -> CommunicationStatus {
        try await request(path: "/api/communication/status")
    }

    func fetchConfirmedMemory() async throws -> ConfirmedMemorySnapshot {
        try await request(path: "/api/memory")
    }

    func proposeConfirmedMemory(_ text: String) async throws -> ConfirmedMemoryItem {
        struct ProposeRequest: Encodable { let text: String }
        return try await request(
            path: "/api/memory/propose",
            method: "POST",
            body: ProposeRequest(text: text)
        )
    }

    func confirmConfirmedMemory(id: String, shareExternal: Bool = false) async throws -> ConfirmedMemoryItem {
        struct ConfirmRequest: Encodable {
            let id: String
            let share_external: Bool
        }
        return try await request(
            path: "/api/memory/confirm",
            method: "POST",
            body: ConfirmRequest(id: id, share_external: shareExternal)
        )
    }

    func configureTelegram(botToken: String, ownerID: String? = nil) async throws -> TelegramConfigurationResult {
        struct TelegramConfigurationRequest: Encodable {
            var botToken: String
            let ownerId: String?
        }

        var payload = TelegramConfigurationRequest(botToken: botToken, ownerId: ownerID)
        defer { payload.botToken.removeAll(keepingCapacity: false) }
        return try await request(
            path: "/api/communication/telegram",
            method: "POST",
            body: payload
        )
    }

    func streamSpeech(
        text: String,
        providerID: String? = nil,
        voiceID: String? = nil,
        style: String = "natural"
    ) throws -> AsyncThrowingStream<RemoteSpeechEvent, Error> {
        struct SpeechRequest: Encodable {
            let text: String
            let providerId: String?
            let voiceId: String?
            let style: String
            let allowClientFallback: Bool
        }
        struct WireEvent: Decodable {
            let type: String
            let state: String?
            let providerId: String?
            let voiceId: String?
            let text: String?
            let data: String?
            let encoding: String?
            let sampleRate: Double?
            let channels: UInt32?
            let sequence: Int?
            let segmentIndex: Int?
            let errorCode: String?
        }

        guard let token = KeychainStore.token() else { throw LocalAIError.notPaired }
        var request = URLRequest(url: baseURL.appending(path: "/api/tts/stream"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(SpeechRequest(
            text: text,
            providerId: providerID,
            voiceId: voiceID,
            style: style,
            allowClientFallback: true
        ))
        let session = self.session

        return AsyncThrowingStream { continuation in
            let networkTask = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw LocalAIError.malformedResponse }
                    guard (200..<300).contains(http.statusCode) else { throw LocalAIError.rejected(http.statusCode) }
                    for try await line in bytes.lines where !line.isEmpty {
                        try Task.checkCancellation()
                        guard let data = line.data(using: .utf8) else { continue }
                        let event = try JSONDecoder().decode(WireEvent.self, from: data)
                        switch event.type {
                        case "state":
                            if event.state == "error" {
                                throw LocalAIError.server("음성 생성 중 오류가 발생했습니다. (\(event.errorCode ?? "tts_failed"))")
                            }
                            continuation.yield(.state(name: event.state ?? "unknown", providerID: event.providerId))
                        case "audio":
                            guard let encoded = event.data,
                                  let audio = Data(base64Encoded: encoded),
                                  let encoding = event.encoding,
                                  let sampleRate = event.sampleRate,
                                  let channels = event.channels,
                                  let sequence = event.sequence,
                                  let segmentIndex = event.segmentIndex else {
                                throw LocalAIError.malformedResponse
                            }
                            continuation.yield(.audio(RemoteAudioChunk(
                                data: audio,
                                encoding: encoding,
                                sampleRate: sampleRate,
                                channels: channels,
                                sequence: sequence,
                                segmentIndex: segmentIndex
                            )))
                        case "client_synthesis":
                            guard let fallbackText = event.text else { throw LocalAIError.malformedResponse }
                            continuation.yield(.clientSynthesis(text: fallbackText, voiceID: event.voiceId))
                        default:
                            continue
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in networkTask.cancel() }
        }
    }

    func fetchInbox() async throws -> [ProactiveMessage] {
        struct InboxResponse: Decodable { let messages: [ProactiveMessage] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let response: InboxResponse = try await request(path: "/api/inbox", decoder: decoder)
        return response.messages
    }

    private func request<Response: Decodable>(
        path: String,
        method: String = "GET",
        body: Encodable? = nil,
        authenticated: Bool = true,
        decoder: JSONDecoder = JSONDecoder()
    ) async throws -> Response {
        guard let endpoint = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw LocalAIError.malformedResponse
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authenticated {
            guard let token = KeychainStore.token() else { throw LocalAIError.notPaired }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body { request.httpBody = try JSONEncoder().encode(AnyEncodable(body)) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw LocalAIError.malformedResponse }
        if http.statusCode == 401, authenticated { KeychainStore.removeToken() }
        guard (200..<300).contains(http.statusCode) else { throw LocalAIError.rejected(http.statusCode) }
        return try decoder.decode(Response.self, from: data)
    }
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void
    init(_ value: Encodable) { encodeValue = value.encode }
    func encode(to encoder: Encoder) throws { try encodeValue(encoder) }
}

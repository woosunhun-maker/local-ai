import Foundation

actor HouseClient {
    static let shared = HouseClient()

    /// 집 안에서는 LAN 프록시로 맥에 붙는다. 대화 원문은 이 기기 밖으로 나가지 않는다.
    let baseURL = URL(string: "http://192.168.50.235:18791")!
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = true
            configuration.timeoutIntervalForRequest = 20
            configuration.timeoutIntervalForResource = 620
            self.session = URLSession(configuration: configuration)
        }
    }

    nonisolated var isPaired: Bool { KeychainStore.token() != nil }

    nonisolated func forget() {
        KeychainStore.removeToken()
    }

    func pair(pin: String, deviceName: String = "아이폰") async throws {
        let code = pin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.range(of: #"^\d{4}$"#, options: .regularExpression) != nil else {
            throw HouseError.invalidPairingCode
        }
        struct Body: Encodable { let pin: String; let deviceName: String }
        struct Reply: Decodable { let deviceToken: String }
        let reply: Reply = try await request(
            path: "/api/pair",
            method: "POST",
            body: Body(pin: code, deviceName: deviceName),
            authenticated: false
        )
        try KeychainStore.saveToken(reply.deviceToken)
    }

    func pair(using payload: String) async throws {
        let link = try PairingLink(payload: payload)
        struct Body: Encodable { let secret: String; let deviceName: String }
        struct Reply: Decodable { let deviceToken: String }
        let reply: Reply = try await request(
            path: "/api/pair",
            method: "POST",
            body: Body(secret: link.secret, deviceName: "아이폰"),
            authenticated: false
        )
        try KeychainStore.saveToken(reply.deviceToken)
    }

    func requestJoin(deviceName: String = "아이폰") async throws -> String {
        struct Body: Encodable { let deviceName: String }
        struct Reply: Decodable { let id: String }
        let reply: Reply = try await request(
            path: "/api/join-request",
            method: "POST",
            body: Body(deviceName: deviceName),
            authenticated: false
        )
        return reply.id
    }

    func waitJoin(id: String) async throws -> String? {
        struct Reply: Decodable { let status: String; let deviceToken: String? }
        let reply: Reply = try await request(
            path: "/api/join-wait?id=\(id)",
            authenticated: false
        )
        if reply.status == "ready", let token = reply.deviceToken {
            try KeychainStore.saveToken(token)
            return token
        }
        return nil
    }

    func ping() async throws {
        var lastError: Error = HouseError.malformedResponse
        for attempt in 0..<3 {
            do {
                struct Status: Decodable { let ok: Bool }
                let status: Status = try await request(path: "/api/status")
                guard status.ok else { throw HouseError.malformedResponse }
                return
            } catch HouseError.notPaired {
                throw HouseError.notPaired
            } catch HouseError.rejected(401) {
                throw HouseError.rejected(401)
            } catch {
                lastError = error
                if attempt < 2 {
                    try await Task.sleep(for: .milliseconds(400))
                }
            }
        }
        throw lastError
    }

    func room() async throws -> HouseRoom {
        let dto: RoomDTO = try await request(path: "/api/room")
        return dto.asRoom
    }

    func say(text: String) throws -> AsyncThrowingStream<HouseStreamEvent, Error> {
        struct Body: Encodable {
            let text: String
            let clientRequestId: String
        }
        guard let token = KeychainStore.token() else { throw HouseError.notPaired }
        var request = URLRequest(url: baseURL.appending(path: "/api/room/say"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(
            Body(text: text, clientRequestId: UUID().uuidString.lowercased())
        )
        let session = self.session

        return AsyncThrowingStream { continuation in
            let work = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw HouseError.malformedResponse }
                    guard (200..<300).contains(http.statusCode) else { throw HouseError.rejected(http.statusCode) }
                    var eventName = "message"
                    var lines: [String] = []
                    var finished = false

                    func flush() throws -> Bool {
                        guard !lines.isEmpty else {
                            eventName = "message"
                            return false
                        }
                        let payload = lines.joined(separator: "\n")
                        defer {
                            eventName = "message"
                            lines.removeAll(keepingCapacity: true)
                        }
                        if eventName == "error" {
                            throw HouseError.server(HouseSSE.errorMessage(from: payload) ?? "맥이 답을 만들지 못했습니다.")
                        }
                        for event in HouseSSE.events(from: payload, eventName: eventName) {
                            if event == .finished { return true }
                            continuation.yield(event)
                        }
                        return false
                    }

                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        if line.isEmpty {
                            if try flush(), !finished {
                                finished = true
                                continuation.yield(.finished)
                            }
                        } else if line.hasPrefix("event:") {
                            eventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            lines.append(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    if try flush(), !finished {
                        finished = true
                        continuation.yield(.finished)
                    }
                    guard finished else { throw HouseError.interrupted }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in work.cancel() }
        }
    }

    private func request<Response: Decodable>(
        path: String,
        method: String = "GET",
        body: Encodable? = nil,
        authenticated: Bool = true
    ) async throws -> Response {
        guard let endpoint = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw HouseError.malformedResponse
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authenticated {
            guard let token = KeychainStore.token() else { throw HouseError.notPaired }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HouseError.malformedResponse }
        if http.statusCode == 401, authenticated { KeychainStore.removeToken() }
        guard (200..<300).contains(http.statusCode) else { throw HouseError.rejected(http.statusCode) }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

private struct RoomDTO: Decodable {
    let messages: [RoomMessageDTO]
    let jobs: [RoomJobDTO]?
    let updatedAt: String
}

private struct RoomMessageDTO: Decodable {
    let id: UUID
    let role: String
    let content: String
    let at: String
}

private struct RoomJobDTO: Decodable {
    let id: UUID
    let status: String
    let label: String
}

private extension RoomDTO {
    var asRoom: HouseRoom {
        HouseRoom(
            messages: messages.compactMap(\.asMessage),
            jobLabel: jobs?.last(where: { $0.status == "running" })?.label,
            updatedAt: HouseDate.parse(updatedAt)
        )
    }
}

private extension RoomMessageDTO {
    var asMessage: HouseMessage? {
        guard let role = HouseMessage.Role(rawValue: role) else { return nil }
        return HouseMessage(
            id: id,
            role: role,
            text: content,
            createdAt: HouseDate.parse(at),
            delivery: .done
        )
    }
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void
    init(_ value: Encodable) { encodeValue = value.encode }
    func encode(to encoder: Encoder) throws { try encodeValue(encoder) }
}

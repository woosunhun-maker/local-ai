import AVFoundation
import Speech

@MainActor
final class SpeechController: NSObject, ObservableObject {
    @Published var transcript = ""
    @Published var isListening = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ko-KR"))
    private let audioEngine = AVAudioEngine()
    private var task: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var tapInstalled = false

    func toggle() async {
        if isListening { stop(); return }
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { return }
        let microphone = await AVAudioApplication.requestRecordPermission()
        guard microphone else { return }
        start()
    }

    func stop() {
        guard isListening else { return }
        audioEngine.stop()
        removeTapIfNeeded()
        request?.endAudio()
        isListening = false
    }

    private func start() {
        cancelCurrentRecognition()
        transcript = ""
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        request.contextualStrings = [
            "로컬AI", "로컬 AI", "나의 Local AI", "홈 어시스턴트", "아카라", "Aqara",
            "OpenClaw", "Tailscale", "코덱스", "승인", "거부",
        ]
        if recognizer?.supportsOnDeviceRecognition == true {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try? session.setActive(true)

        let node = audioEngine.inputNode
        let format = node.outputFormat(forBus: 0)
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        tapInstalled = true
        audioEngine.prepare()
        do {
            try audioEngine.start()
            isListening = true
            task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    if let result { self?.transcript = result.bestTranscription.formattedString }
                    if error != nil || result?.isFinal == true {
                        self?.finishRecognition(cancelTask: error != nil)
                    }
                }
            }
        } catch {
            finishRecognition(cancelTask: true)
        }
    }

    private func cancelCurrentRecognition() {
        if audioEngine.isRunning { audioEngine.stop() }
        removeTapIfNeeded()
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        isListening = false
    }

    private func finishRecognition(cancelTask: Bool) {
        if audioEngine.isRunning { audioEngine.stop() }
        removeTapIfNeeded()
        request?.endAudio()
        if cancelTask { task?.cancel() }
        request = nil
        task = nil
        isListening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func removeTapIfNeeded() {
        guard tapInstalled else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        tapInstalled = false
    }
}

struct SpeechVoiceOption: Identifiable {
    let id: String
    let name: String
    let quality: AVSpeechSynthesisVoiceQuality

    var displayName: String {
        switch quality {
        case .premium: return "\(name) · 최고 품질"
        case .enhanced: return "\(name) · 고품질"
        default: return name
        }
    }
}

enum SpeechOutput {
    static var koreanVoices: [SpeechVoiceOption] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.lowercased().hasPrefix("ko") }
            .map { SpeechVoiceOption(id: $0.identifier, name: $0.name, quality: $0.quality) }
            .sorted {
                if $0.quality.rawValue != $1.quality.rawValue { return $0.quality.rawValue > $1.quality.rawValue }
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
    }

    static func makeUtterance(
        _ text: String,
        voiceIdentifier: String? = nil,
        rate: Double? = nil,
        pitch: Double? = nil
    ) -> AVSpeechUtterance {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)

        let utterance = AVSpeechUtterance(string: speechFriendlyText(text))
        utterance.voice = preferredVoice(identifier: voiceIdentifier)
        let storedRate = UserDefaults.standard.object(forKey: "speechRate") as? Double
        let storedPitch = UserDefaults.standard.object(forKey: "speechPitch") as? Double
        utterance.rate = Float(rate ?? storedRate ?? 0.44)
        utterance.pitchMultiplier = Float(pitch ?? storedPitch ?? 0.97)
        utterance.preUtteranceDelay = 0.06
        utterance.postUtteranceDelay = 0.08
        return utterance
    }

    private static func preferredVoice(identifier: String?) -> AVSpeechSynthesisVoice? {
        if let identifier, !identifier.isEmpty, let selected = AVSpeechSynthesisVoice(identifier: identifier) {
            return selected
        }
        guard let best = koreanVoices.first else { return AVSpeechSynthesisVoice(language: "ko-KR") }
        return AVSpeechSynthesisVoice(identifier: best.id)
    }

    private static func speechFriendlyText(_ source: String) -> String {
        var text = source
        text = text.replacingOccurrences(of: "```[\\s\\S]*?```", with: " 코드는 화면에서 확인해주세요. ", options: .regularExpression)
        text = text.replacingOccurrences(of: "`([^`]*)`", with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\[([^]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: "https?://\\S+", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "(?m)^\\s*[-*•]\\s+", with: ". ", options: .regularExpression)
        text = text.replacingOccurrences(of: "[#*_~>]", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

@MainActor
final class SpeechPlaybackController: NSObject, ObservableObject, @preconcurrency AVSpeechSynthesizerDelegate {
    static let shared = SpeechPlaybackController()

    @Published private(set) var isSpeaking = false
    @Published private(set) var previewingVoiceID: String?
    @Published private(set) var remoteState: String?
    @Published private(set) var lastError: String?

    private let synthesizer = AVSpeechSynthesizer()
    private let pcmPlayer = PCMStreamPlayer()
    private var remoteTask: Task<Void, Never>?
    private var streamContinuation: AsyncStream<String>.Continuation?
    private var sentenceBuffer = SpeechSentenceBuffer()

    override init() {
        super.init()
        synthesizer.delegate = self
        pcmPlayer.onIdle = { [weak self] in
            guard let self, self.remoteTask == nil, !self.synthesizer.isSpeaking else { return }
            self.isSpeaking = false
            if self.lastError == nil { self.remoteState = nil }
        }
    }

    func speak(_ text: String, voiceIdentifier: String? = nil) {
        stop()
        previewingVoiceID = nil
        if UserDefaults.standard.string(forKey: "speechProviderID") == "qwen3-tts-local" {
            speakRemotely(text, voiceIdentifier: "qwen3-sohee")
        } else {
            speakOnDevice(text, voiceIdentifier: voiceIdentifier)
        }
    }

    func preview(voiceIdentifier: String, rate: Double, pitch: Double) {
        stop()
        previewingVoiceID = voiceIdentifier
        let sample = "안녕하세요. 이제 더 자연스럽고 편안한 목소리로 대화할게요."
        synthesizer.speak(SpeechOutput.makeUtterance(sample, voiceIdentifier: voiceIdentifier, rate: rate, pitch: pitch))
        isSpeaking = true
    }

    func previewLocalVoice(style: String = "natural") {
        stop()
        previewingVoiceID = "qwen3-sohee"
        speakRemotely(
            "안녕하세요. 이제 더 자연스럽고 편안한 목소리로 대화할게요.",
            voiceIdentifier: "qwen3-sohee",
            style: style
        )
    }

    @discardableResult
    func beginStreamingResponse() -> Bool {
        stop()
        sentenceBuffer = SpeechSentenceBuffer()
        let useMacVoice = UserDefaults.standard.string(forKey: "speechProviderID") == "qwen3-tts-local"
        let stream = AsyncStream<String> { continuation in
            self.streamContinuation = continuation
        }
        isSpeaking = true
        remoteState = "첫 문장을 기다리는 중"
        remoteTask = Task { [weak self] in
            guard let self else { return }
            for await sentence in stream {
                if Task.isCancelled { break }
                if useMacVoice {
                    do {
                        try await self.playRemoteSegment(sentence, voiceIdentifier: "qwen3-sohee", style: "natural")
                    } catch is CancellationError {
                        break
                    } catch {
                        self.lastError = error.localizedDescription
                        if RemoteSpeechFallbackPolicy.shouldUseApple(after: error) {
                            self.remoteState = "iPhone 음성으로 전환"
                            let selected = UserDefaults.standard.string(forKey: "speechVoiceIdentifier")
                            self.speakOnDevice(sentence, voiceIdentifier: selected, enqueue: true)
                        } else {
                            self.streamContinuation?.finish()
                            self.streamContinuation = nil
                            self.pcmPlayer.stop()
                            self.isSpeaking = false
                            self.remoteState = "Mac 음성 재생 오류 · 정지됨"
                            break
                        }
                    }
                } else {
                    self.remoteState = "iPhone 음성 재생 중"
                    let selected = UserDefaults.standard.string(forKey: "speechVoiceIdentifier")
                    self.speakOnDevice(sentence, voiceIdentifier: selected, enqueue: true)
                }
            }
            self.remoteTask = nil
            if !self.synthesizer.isSpeaking && !self.pcmPlayer.isPlaying {
                self.isSpeaking = false
                if self.lastError == nil { self.remoteState = nil }
            }
        }
        return true
    }

    func appendStreamingText(_ fragment: String) {
        for sentence in sentenceBuffer.append(fragment) {
            streamContinuation?.yield(sentence)
        }
    }

    func finishStreamingResponse() {
        if let remainder = sentenceBuffer.flush() {
            streamContinuation?.yield(remainder)
        }
        streamContinuation?.finish()
        streamContinuation = nil
    }

    func stop() {
        streamContinuation?.finish()
        streamContinuation = nil
        sentenceBuffer = SpeechSentenceBuffer()
        remoteTask?.cancel()
        remoteTask = nil
        pcmPlayer.stop()
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        isSpeaking = false
        previewingVoiceID = nil
        remoteState = nil
        lastError = nil
    }

    private func speakOnDevice(_ text: String, voiceIdentifier: String?, enqueue: Bool = false) {
        if !enqueue, synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        synthesizer.speak(SpeechOutput.makeUtterance(text, voiceIdentifier: voiceIdentifier))
        isSpeaking = true
    }

    private func speakRemotely(_ text: String, voiceIdentifier: String, style: String = "natural") {
        remoteState = "Mac 음성 준비 중"
        lastError = nil
        isSpeaking = true
        remoteTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.playRemoteSegment(text, voiceIdentifier: voiceIdentifier, style: style)
            } catch is CancellationError {
                // Explicit stop is a normal state transition.
            } catch {
                self.lastError = error.localizedDescription
                if RemoteSpeechFallbackPolicy.shouldUseApple(after: error) {
                    self.remoteState = "iPhone 음성으로 전환"
                    let selected = UserDefaults.standard.string(forKey: "speechVoiceIdentifier")
                    self.speakOnDevice(text, voiceIdentifier: selected)
                } else {
                    self.pcmPlayer.stop()
                    self.isSpeaking = false
                    self.remoteState = "Mac 음성 재생 오류 · 정지됨"
                }
            }
            self.remoteTask = nil
            if !self.synthesizer.isSpeaking && !self.pcmPlayer.isPlaying {
                self.isSpeaking = false
                if self.lastError == nil { self.remoteState = nil }
            }
        }
    }

    private func playRemoteSegment(_ text: String, voiceIdentifier: String, style: String) async throws {
        var receivedAudio = false
        do {
            let stream = try await LocalAIClient.shared.streamSpeech(
                text: text,
                providerID: "qwen3-tts-local",
                voiceID: voiceIdentifier,
                style: style
            )
            for try await event in stream {
                try Task.checkCancellation()
                switch event {
                case .state(let name, _):
                    switch name {
                    case "preparing": remoteState = "Mac 음성 준비 중"
                    case "synthesizing": remoteState = "음성 생성 중"
                    case "client_fallback": remoteState = "iPhone 음성으로 전환"
                    case "completed": remoteState = nil
                    case "cancelled": remoteState = nil
                    default: break
                    }
                case .audio(let chunk):
                    receivedAudio = true
                    remoteState = "재생 중"
                    try pcmPlayer.enqueue(chunk)
                case .clientSynthesis(let fallbackText, _):
                    guard !receivedAudio else {
                        throw RemoteSpeechPlaybackFailure(
                            LocalAIError.server("Mac 음성 재생 중 iPhone 음성 전환이 요청됐습니다."),
                            receivedAudio: true
                        )
                    }
                    let selected = UserDefaults.standard.string(forKey: "speechVoiceIdentifier")
                    speakOnDevice(fallbackText, voiceIdentifier: selected, enqueue: true)
                    return
                }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let failure as RemoteSpeechPlaybackFailure {
            throw failure
        } catch {
            throw RemoteSpeechPlaybackFailure(error, receivedAudio: receivedAudio)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        isSpeaking = synthesizer.isSpeaking || pcmPlayer.isPlaying || remoteTask != nil
        if !isSpeaking {
            previewingVoiceID = nil
            remoteState = nil
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        isSpeaking = synthesizer.isSpeaking || pcmPlayer.isPlaying || remoteTask != nil
        if !isSpeaking {
            previewingVoiceID = nil
            remoteState = nil
        }
    }
}

struct SpeechSentenceBuffer {
    private var buffer = ""
    private var markdownBuffer = ""
    private var insideCodeFence = false

    mutating func append(_ fragment: String) -> [String] {
        markdownBuffer.append(fragment)
        consumeMarkdown(final: false)
        var output: [String] = []
        while let boundary = nextBoundary() {
            let sentence = String(buffer[..<boundary]).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(..<boundary)
            if !sentence.isEmpty { output.append(sentence) }
        }
        if buffer.count > 260, let split = buffer.prefix(240).lastIndex(where: { $0.isWhitespace }) {
            let sentence = String(buffer[...split]).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(...split)
            if !sentence.isEmpty { output.append(sentence) }
        }
        return output
    }

    mutating func flush() -> String? {
        consumeMarkdown(final: true)
        let value = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer = ""
        markdownBuffer = ""
        insideCodeFence = false
        return value.isEmpty ? nil : value
    }

    private mutating func consumeMarkdown(final: Bool) {
        while !markdownBuffer.isEmpty {
            if insideCodeFence {
                if let closingFence = markdownBuffer.range(of: "```") {
                    markdownBuffer.removeSubrange(..<closingFence.upperBound)
                    insideCodeFence = false
                    appendSpeechSeparator()
                    continue
                }
                if final {
                    markdownBuffer.removeAll(keepingCapacity: true)
                } else {
                    markdownBuffer = trailingFencePrefix(in: markdownBuffer)
                }
                return
            }

            if let openingFence = markdownBuffer.range(of: "```") {
                buffer.append(contentsOf: markdownBuffer[..<openingFence.lowerBound])
                markdownBuffer.removeSubrange(..<openingFence.upperBound)
                insideCodeFence = true
                appendSpeechSeparator()
                continue
            }

            if final {
                buffer.append(markdownBuffer)
                markdownBuffer.removeAll(keepingCapacity: true)
            } else {
                let carry = trailingFencePrefix(in: markdownBuffer)
                let safeCount = markdownBuffer.count - carry.count
                if safeCount > 0 {
                    let safeEnd = markdownBuffer.index(markdownBuffer.startIndex, offsetBy: safeCount)
                    buffer.append(contentsOf: markdownBuffer[..<safeEnd])
                }
                markdownBuffer = carry
            }
            return
        }
    }

    private func trailingFencePrefix(in source: String) -> String {
        let count = min(2, source.reversed().prefix(while: { $0 == "`" }).count)
        return count == 0 ? "" : String(repeating: "`", count: count)
    }

    private mutating func appendSpeechSeparator() {
        if let last = buffer.last, !last.isWhitespace { buffer.append(" ") }
    }

    private func nextBoundary() -> String.Index? {
        var index = buffer.startIndex
        while index < buffer.endIndex {
            let character = buffer[index]
            let next = buffer.index(after: index)
            if character == "\n" { return next }
            if ".!?。！？".contains(character) {
                if character == "." {
                    let previous = index > buffer.startIndex ? buffer[buffer.index(before: index)] : nil
                    let following = next < buffer.endIndex ? buffer[next] : nil
                    if previous?.isNumber == true && (following == nil || following?.isNumber == true) {
                        index = next
                        continue
                    }
                }
                if next < buffer.endIndex { return next }
            }
            index = next
        }
        return nil
    }
}

@MainActor
private final class PCMStreamPlayer {
    var onIdle: (() -> Void)?
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var format: AVAudioFormat?
    private var pendingBuffers = 0

    var isPlaying: Bool { player.isPlaying || pendingBuffers > 0 }

    init() {
        engine.attach(player)
    }

    func enqueue(_ chunk: RemoteAudioChunk) throws {
        guard chunk.encoding == "pcm_s16le", chunk.channels > 0 else {
            throw LocalAIError.server("지원하지 않는 로컬 음성 형식입니다.")
        }
        let nextFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: chunk.sampleRate,
            channels: AVAudioChannelCount(chunk.channels),
            interleaved: true
        )
        guard let nextFormat else { throw LocalAIError.malformedResponse }
        let bytesPerFrame = Int(nextFormat.streamDescription.pointee.mBytesPerFrame)
        guard bytesPerFrame > 0, chunk.data.count >= bytesPerFrame else { return }
        let frameCount = AVAudioFrameCount(chunk.data.count / bytesPerFrame)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: nextFormat, frameCapacity: frameCount) else {
            throw LocalAIError.malformedResponse
        }
        buffer.frameLength = frameCount
        guard let destination = buffer.mutableAudioBufferList.pointee.mBuffers.mData else {
            throw LocalAIError.malformedResponse
        }
        chunk.data.withUnsafeBytes { bytes in
            if let source = bytes.baseAddress {
                memcpy(destination, source, min(chunk.data.count, Int(buffer.mutableAudioBufferList.pointee.mBuffers.mDataByteSize)))
            }
        }

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        if format?.sampleRate != nextFormat.sampleRate || format?.channelCount != nextFormat.channelCount {
            player.stop()
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: nextFormat)
            format = nextFormat
        }
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        pendingBuffers += 1
        player.scheduleBuffer(buffer) { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.pendingBuffers = max(0, self.pendingBuffers - 1)
                if self.pendingBuffers == 0 { self.onIdle?() }
            }
        }
        if !player.isPlaying { player.play() }
    }

    func stop() {
        player.stop()
        pendingBuffers = 0
        onIdle?()
    }
}

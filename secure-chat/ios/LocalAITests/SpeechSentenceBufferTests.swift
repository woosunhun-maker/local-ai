import XCTest
@testable import LocalAI

final class SpeechSentenceBufferTests: XCTestCase {
    func testEmitsKoreanSentencesAcrossStreamingFragments() {
        var buffer = SpeechSentenceBuffer()
        XCTAssertTrue(buffer.append("첫 문장입").isEmpty)
        XCTAssertEqual(buffer.append("니다. 다음"), ["첫 문장입니다."])
        XCTAssertEqual(buffer.append(" 문장입니다! 계속"), ["다음 문장입니다!"])
        XCTAssertEqual(buffer.flush(), "계속")
    }

    func testDoesNotSplitInsideDecimal() {
        var buffer = SpeechSentenceBuffer()
        XCTAssertTrue(buffer.append("지연은 0.").isEmpty)
        XCTAssertEqual(buffer.append("32초입니다. 다음"), ["지연은 0.32초입니다."])
        XCTAssertEqual(buffer.flush(), "다음")
    }

    func testOmitsFencedCodeAcrossStreamingFragments() {
        var buffer = SpeechSentenceBuffer()

        XCTAssertEqual(buffer.append("설명입니다.\n```swi"), ["설명입니다."])
        XCTAssertEqual(
            buffer.append("ft\nprint(\"읽으면 안 됩니다.\")\n```\n다음 설명입니다. 계속"),
            ["다음 설명입니다."]
        )
        XCTAssertEqual(buffer.flush(), "계속")
    }

    func testRecognizesFenceSplitAcrossTokenBoundaries() {
        var buffer = SpeechSentenceBuffer()

        XCTAssertTrue(buffer.append("안전한 문장입니다.``").isEmpty)
        XCTAssertEqual(buffer.append("`secret!``"), ["안전한 문장입니다."])
        XCTAssertTrue(buffer.append("` 마지막 문장입니다.").isEmpty)
        XCTAssertEqual(buffer.flush(), "마지막 문장입니다.")
    }

    func testRemoteFailureBeforeAudioAllowsAppleFallback() {
        let failure = RemoteSpeechPlaybackFailure(TestFailure.example, receivedAudio: false)
        XCTAssertTrue(RemoteSpeechFallbackPolicy.shouldUseApple(after: failure))
    }

    func testRemoteFailureAfterAudioBlocksDuplicateAppleFallback() {
        let failure = RemoteSpeechPlaybackFailure(TestFailure.example, receivedAudio: true)
        XCTAssertFalse(RemoteSpeechFallbackPolicy.shouldUseApple(after: failure))
    }

    private enum TestFailure: Error {
        case example
    }
}

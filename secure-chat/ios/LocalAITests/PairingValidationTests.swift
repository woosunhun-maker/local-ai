import XCTest
@testable import LocalAI

final class PairingValidationTests: XCTestCase {
    func testAcceptsLanAndTailnetPairingURL() throws {
        let lan = try PairingLink(payload: "http://192.168.50.235:18791/#pair=1234567890abcdef")
        XCTAssertEqual(lan.secret, "1234567890abcdef")
        let tailnet = try PairingLink(payload: "https://macstudio.tail4ad006.ts.net/#pair=1234567890abcdef")
        XCTAssertEqual(tailnet.secret, "1234567890abcdef")
        XCTAssertThrowsError(try PairingLink(payload: "https://example.com/#pair=1234567890abcdef"))
        XCTAssertThrowsError(try PairingLink(payload: "http://macstudio.tail4ad006.ts.net/#pair=1234567890abcdef"))
    }

    func testApprovalSigningMessageMatchesMac() {
        let message = ApprovalSigning.message(
            requestId: "room-do-test-0001",
            payloadSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            nonce: "abcdefghijklmnopqrstuvwxyz012345",
            expiresAt: "2026-08-17T12:00:00.000Z",
            decision: "approved"
        )
        XCTAssertEqual(
            message,
            [
                "localai-approval-v1",
                "room-do-test-0001",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "abcdefghijklmnopqrstuvwxyz012345",
                "2026-08-17T12:00:00.000Z",
                "approved",
            ].joined(separator: "\n")
        )
    }
}

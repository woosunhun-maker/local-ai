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
}

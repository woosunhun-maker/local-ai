import XCTest
@testable import LocalAI

final class PairingValidationTests: XCTestCase {
    func testAcceptsOnlyExpectedTailnetPairingURL() throws {
        let valid = try PairingLink(payload: "https://macstudio.tail4ad006.ts.net/#pair=1234567890abcdef")
        XCTAssertEqual(valid.secret, "1234567890abcdef")
        XCTAssertThrowsError(try PairingLink(payload: "https://example.com/#pair=1234567890abcdef"))
        XCTAssertThrowsError(try PairingLink(payload: "http://macstudio.tail4ad006.ts.net/#pair=1234567890abcdef"))
    }
}

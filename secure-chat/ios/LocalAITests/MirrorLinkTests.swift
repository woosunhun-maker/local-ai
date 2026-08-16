import XCTest
@testable import LocalAI

final class MirrorLinkTests: XCTestCase {
    func testAcceptsFourDigitPinAndShortText() throws {
        let link = try XCTUnwrap(MirrorLink(url: URL(string: "localai://mirror?pin=1234&text=안녕")!))
        XCTAssertEqual(link.pin, "1234")
        XCTAssertEqual(link.text, "안녕")
    }

    func testRejectsNonLocalSchemeAndBadPin() {
        XCTAssertNil(MirrorLink(url: URL(string: "https://example.com/mirror?pin=1234")!))
        XCTAssertNil(MirrorLink(url: URL(string: "localai://mirror?pin=12a4")!))
        XCTAssertNil(MirrorLink(url: URL(string: "localai://other?pin=1234")!))
    }

    func testAcceptsSayWithoutPin() throws {
        let link = try XCTUnwrap(MirrorLink(url: URL(string: "localai://say?text=%EB%AF%B8%EB%9F%AC%EB%A7%81%EC%8A%A4%EC%8A%A4%EB%A1%9C%ED%99%95%EC%9D%B8")!))
        XCTAssertNil(link.pin)
        XCTAssertEqual(link.text, "미러링스스로확인")
    }
}

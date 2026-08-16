import XCTest
@testable import LocalAI

final class HouseSSETests: XCTestCase {
    func testDonePayloadFinishes() {
        XCTAssertEqual(HouseSSE.events(from: "[DONE]", eventName: "message"), [.finished])
        XCTAssertEqual(HouseSSE.events(from: #"{"ok":true}"#, eventName: "done"), [.finished])
    }

    func testDeltaExtractsContent() {
        let payload = #"{"choices":[{"delta":{"content":"안녕"}}]}"#
        XCTAssertEqual(HouseSSE.events(from: payload, eventName: "delta"), [.delta("안녕")])
    }

    func testStatusUsesLabel() {
        let payload = #"{"label":"로컬 모델을 준비하는 중"}"#
        XCTAssertEqual(HouseSSE.events(from: payload, eventName: "status"), [.status("로컬 모델을 준비하는 중")])
    }

    func testErrorMessage() {
        let payload = #"{"message":"지금은 답을 못 만들었습니다."}"#
        XCTAssertEqual(HouseSSE.errorMessage(from: payload), "지금은 답을 못 만들었습니다.")
    }
}

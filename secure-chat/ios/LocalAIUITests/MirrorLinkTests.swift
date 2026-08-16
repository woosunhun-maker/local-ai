import XCTest

final class MirrorLinkTests: XCTestCase {
    func testPairAndSayThroughMirroredPhone() throws {
        let app = XCUIApplication()
        app.launch()

        let pin = ProcessInfo.processInfo.environment["LOCAL_AI_PAIR_PIN"] ?? ""
        let phrase = ProcessInfo.processInfo.environment["LOCAL_AI_MIRROR_PHRASE"] ?? "미러링 연결 확인"

        if app.buttons["이 맥에 연결"].waitForExistence(timeout: 4) || app.staticTexts["또는 맥에 뜬 숫자"].exists {
            XCTAssertFalse(pin.isEmpty, "페어링 화면인데 PIN이 없다")
            let field = app.textFields["house.pin"]
            if field.waitForExistence(timeout: 2) {
                field.tap()
                field.typeText(pin)
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)).tap()
                app.typeText(pin)
            }
            XCTAssertTrue(
                app.staticTexts["집"].waitForExistence(timeout: 12)
                    || app.textFields["house.composer"].waitForExistence(timeout: 12)
            )
        }

        let composer = app.textFields["house.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 12), "대화 입력칸이 안 보인다")
        composer.tap()
        composer.typeText(phrase)

        let send = app.buttons["house.send"]
        if send.waitForExistence(timeout: 2), send.isEnabled {
            send.tap()
        } else {
            composer.typeText("\n")
        }

        let mine = app.staticTexts[phrase]
        XCTAssertTrue(mine.waitForExistence(timeout: 8), "보낸 말이 화면에 없다")

        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "mirror-link"
        shot.lifetime = .keepAlways
        add(shot)
    }
}

import AppKit
import CoreImage
import Foundation

struct PairingPayload: Decodable {
    let url: String
    let expiresAt: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("오류: \(message)\n".utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else { fail("출력 PNG 경로 하나가 필요합니다.") }
let outputURL = URL(fileURLWithPath: arguments[1])
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let payload = try? JSONDecoder().decode(PairingPayload.self, from: input),
      let urlData = payload.url.data(using: .utf8),
      payload.url.hasPrefix("https://") else {
    fail("HTTPS 공개 주소가 포함된 페어링 데이터가 필요합니다.")
}

let filter = CIFilter(name: "CIQRCodeGenerator")!
filter.setValue(urlData, forKey: "inputMessage")
filter.setValue("Q", forKey: "inputCorrectionLevel")
guard let image = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else {
    fail("QR 이미지를 만들지 못했습니다.")
}
let representation = NSBitmapImageRep(ciImage: image)
guard let png = representation.representation(using: .png, properties: [:]) else {
    fail("PNG 변환에 실패했습니다.")
}
do {
    try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try png.write(to: outputURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputURL.path)
    print("페어링 QR 생성 완료: \(outputURL.path)")
    print("만료 시각: \(payload.expiresAt)")
} catch {
    fail("QR 파일을 저장하지 못했습니다.")
}

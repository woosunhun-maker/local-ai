import AVFoundation
import SwiftUI

struct PairingView: View {
    let onPaired: () -> Void
    @State private var errorMessage: String?
    @State private var processing = false

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()
            AppTheme.ambientGradient.ignoresSafeArea()
            VStack(spacing: 18) {
                VStack(spacing: 8) {
                    ZStack {
                        Circle().fill(Color.accentColor.gradient).frame(width: 58, height: 58)
                        Image(systemName: "lock.shield.fill").font(.title2).foregroundStyle(.black)
                    }
                    Text("Mac과 안전하게 연결").font(.title2.bold())
                    Text("Mac 화면에 표시된 5분짜리 QR을\n아래 카메라 안에 맞춰주세요.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                }
                ZStack {
                    QRScannerView { payload in
                        guard !processing else { return }
                        processing = true
                        Task {
                            do {
                                try await LocalAIClient.shared.pair(using: payload)
                                onPaired()
                            } catch {
                                errorMessage = error.localizedDescription
                                processing = false
                            }
                        }
                    }
                    RoundedRectangle(cornerRadius: 22)
                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 3, dash: [12, 8]))
                        .padding(34)
                    if processing {
                        RoundedRectangle(cornerRadius: 22).fill(.ultraThinMaterial)
                        ProgressView("보안 키 등록 중…").font(.headline)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 24))
                .frame(height: 340)
                .shadow(color: .black.opacity(0.25), radius: 20, y: 10)
                Label("토큰은 이 iPhone의 Keychain에만 저장됩니다", systemImage: "checkmark.shield.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .alert("페어링 실패", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("확인", role: .cancel) {}
        } message: { Text(errorMessage ?? "") }
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

private final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var delivered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard !AppRuntime.suppressPermissionPrompts else { return }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            guard allowed else { return }
            DispatchQueue.main.async { self?.configure() }
        }
    }

    private func configure() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered,
              let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = code.stringValue else { return }
        delivered = true
        session.stopRunning()
        onCode?(value)
    }
}

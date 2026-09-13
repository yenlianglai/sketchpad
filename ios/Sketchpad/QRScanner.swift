import SwiftUI
import AVFoundation

/// Camera QR scanner for pairing. Accepts what the Mac prints at startup
/// (`sketchpad://pair?host=…&token=…`) and also a bare `192.168.0.9:8791` or `http://…`.
struct QRScannerSheet: View {
    var onPaired: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var denied = false

    var body: some View {
        NavigationStack {
            ZStack {
                if denied {
                    VStack(spacing: 12) {
                        Image(systemName: "camera.fill").font(.largeTitle).foregroundStyle(.secondary)
                        Text("Camera access is off").font(.headline)
                        Text("Allow it in Settings › Sketchpad, or type the address by hand.")
                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }.padding(40)
                } else {
                    ScannerView(onCode: handle, onDenied: { denied = true }).ignoresSafeArea(edges: .bottom)
                    VStack {
                        Spacer()
                        Text("Point the camera at the QR code in your Mac's terminal")
                            .font(.subheadline).padding(.horizontal, 16).padding(.vertical, 10)
                            .background(.regularMaterial, in: Capsule()).padding(.bottom, 40)
                    }
                }
            }
            .navigationTitle("Scan to pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func handle(_ code: String) {
        guard let (host, token) = Self.parse(code) else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onPaired(host, token)
        dismiss()
    }

    /// → (host:port, token)
    static func parse(_ code: String) -> (String, String?)? {
        let s = code.trimmingCharacters(in: .whitespacesAndNewlines)
        if let c = URLComponents(string: s), let scheme = c.scheme?.lowercased() {
            let items = c.queryItems ?? []
            let token = items.first { $0.name == "token" }?.value
            if scheme == "sketchpad" {
                if let h = items.first(where: { $0.name == "host" })?.value, !h.isEmpty { return (h, token) }
            } else if scheme == "http" || scheme == "https" {
                if let h = c.host { return (c.port.map { "\(h):\($0)" } ?? h, token) }
            }
        }
        // Bare host:port
        let bare = s.split(separator: ":")
        if bare.count == 2, Int(bare[1]) != nil, !bare[0].isEmpty { return (s, nil) }
        return nil
    }
}

private struct ScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void
    var onDenied: () -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.onCode = onCode
        c.onDenied = onDenied
        return c
    }
    func updateUIViewController(_ c: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onDenied: (() -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var done = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        AVCaptureDevice.requestAccess(for: .video) { [weak self] ok in
            DispatchQueue.main.async {
                guard let self else { return }
                if ok { self.configure() } else { self.onDenied?() }
            }
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { onDenied?(); return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { onDenied?(); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer
        Task.detached { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if session.isRunning { Task.detached { [session] in session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !done,
              let obj = objects.first as? AVMetadataMachineReadableCodeObject,
              let s = obj.stringValue,
              QRScannerSheet.parse(s) != nil else { return }
        done = true
        onCode?(s)
    }
}

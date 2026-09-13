import SwiftUI
import AVFoundation

/// Camera QR scanner for pairing. Accepts what the Mac prints at startup
/// (`sketchpad://pair?host=…&code=…`) and also a bare `192.168.0.9:8791` or `http://…`.
struct QRScannerSheet: View {
    var onPaired: (String, Credential?, String, [String]) -> Void
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
        guard let (host, credential) = Self.parse(code) else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onPaired(host, credential, Self.fingerprint(code), Self.alternates(code))
        dismiss()
    }

    /// The certificate fingerprint the Mac put in the QR, if it is serving over TLS.
    static func fingerprint(_ code: String) -> String {
        URLComponents(string: code.trimmingCharacters(in: .whitespacesAndNewlines))?
            .queryItems?.first { $0.name == "fp" }?.value?.lowercased() ?? ""
    }

    /// Other addresses the same Mac answers on, in the order the Mac suggested.
    static func alternates(_ code: String) -> [String] {
        (URLComponents(string: code.trimmingCharacters(in: .whitespacesAndNewlines))?
            .queryItems?.first { $0.name == "alt" }?.value ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// What the QR hands over. A `code` is exchanged for this iPad's own key and is good once;
    /// a `token` is a key directly, which is what a server running without pairing prints.
    enum Credential: Equatable {
        case code(String)
        case token(String)
    }

    /// → (host:port, credential)
    static func parse(_ code: String) -> (String, Credential?)? {
        let s = code.trimmingCharacters(in: .whitespacesAndNewlines)
        if let c = URLComponents(string: s), let scheme = c.scheme?.lowercased() {
            let items = c.queryItems ?? []
            // A pairing code wins: a QR carrying both is a server being kind to an older app.
            let credential: Credential? = items.first { $0.name == "code" }?.value.map(Credential.code)
                ?? items.first { $0.name == "token" }?.value.map(Credential.token)
            if scheme == "sketchpad" {
                if let h = items.first(where: { $0.name == "host" })?.value, !h.isEmpty { return (h, credential) }
            } else if scheme == "http" || scheme == "https" {
                if let h = c.host { return (c.port.map { "\(h):\($0)" } ?? h, credential) }
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

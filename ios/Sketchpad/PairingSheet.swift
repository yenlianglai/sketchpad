import SwiftUI
import CryptoKit
import CommonCrypto
import UIKit

/// Connecting this iPad to a Mac: eight characters read off its screen.
///
/// What gets sent is never the code itself, but a proof derived from the code *and the certificate
/// this iPad was just shown*. The Mac checks it against its own certificate, so someone sitting in
/// the middle — whose certificate is necessarily a different one — is turned away, and learns
/// nothing they could use. That is what lets eight typed characters stand in for a fingerprint you
/// would otherwise have to scan.
struct PairingSheet: View {
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var conn: ServerConnection
    @Environment(\.dismiss) private var dismiss

    @State private var code = ""
    @State private var host = ""
    @State private var busy = false
    @State private var problem: String?

    /// A code is eight characters; the dash people see is only there to make it readable.
    private var typed: String { PairingProof.normalize(code) }
    private var ready: Bool { typed.count == 8 && !resolvedHost.isEmpty && !busy }
    private var resolvedHost: String {
        host.trimmingCharacters(in: .whitespaces).isEmpty
            ? (conn.discovered.first ?? settings.host)
            : host.trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("XXXX-XXXX", text: $code)
                        .textCase(.uppercase)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.characters)
                        .font(.system(.title2, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .onChange(of: code) { _, new in code = PairingProof.grouped(new) }
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("Run `sketchpad pair` on your Mac, or ask your agent for a code. Good for ten minutes.")
                }

                Section {
                    if conn.discovered.isEmpty {
                        TextField("192.168.0.9:8791", text: $host)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                    } else {
                        Picker("Mac", selection: $host) {
                            Text("\(conn.discovered[0]) (found)").tag("")
                            ForEach(conn.discovered.dropFirst(), id: \.self) { Text($0).tag($0) }
                        }
                    }
                } header: {
                    Text("Computer")
                } footer: {
                    Text(conn.discovered.isEmpty
                         ? "Sketchpad could not find a Mac on this network, so type its address."
                         : "Found on the network. Change it only if you mean a different computer.")
                }

                if let problem {
                    Section { Text(problem).foregroundStyle(.red).font(.subheadline) }
                }
            }
            .navigationTitle("Pair with a Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Pairing…" : "Pair", action: pair).disabled(!ready)
                }
            }
        }
    }

    private func pair() {
        busy = true
        problem = nil
        Task {
            do {
                let paired = try await conn.pair(code: typed, at: resolvedHost)
                settings.fingerprint = paired.fingerprint
                settings.altHosts = []
                settings.host = resolvedHost
                settings.token = paired.token
                conn.reconnectNow()
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            } catch {
                problem = error.localizedDescription
                busy = false
            }
        }
    }
}

/// Turning what someone typed into what the Mac can check.
enum PairingProof {
    /// 200,000 rounds, matching the server. Slow on purpose: without it, a proof captured in the
    /// middle would give up an eight-character code to an offline search in seconds.
    static let iterations = 200_000

    static func normalize(_ code: String) -> String {
        code.uppercased().filter { $0.isNumber || ($0.isLetter && $0.isASCII) }
    }

    /// Re-inserts the grouping dash as they type, without fighting the cursor.
    static func grouped(_ raw: String) -> String {
        let clean = String(normalize(raw).prefix(8))
        guard clean.count > 4 else { return clean }
        return clean.prefix(4) + "-" + clean.dropFirst(4)
    }

    /// PBKDF2-SHA256 over the code, salted with the certificate this iPad was shown. Same inputs as
    /// the server's, or nothing matches.
    static func proof(code: String, fingerprint: String) -> String? {
        let password = Array(normalize(code).utf8)
        let salt = Array("sketchpad-pairing-v1:\(fingerprint)".utf8)
        var derived = [UInt8](repeating: 0, count: 32)

        let status = CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2),
            password.map { Int8(bitPattern: $0) }, password.count,
            salt, salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
            UInt32(iterations),
            &derived, derived.count
        )
        guard status == kCCSuccess else { return nil }
        return Data(derived).base64URLEncoded
    }
}

extension Data {
    /// base64url, which is what Node's `.toString('base64url')` produces.
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

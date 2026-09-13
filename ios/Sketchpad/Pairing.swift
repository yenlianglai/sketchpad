import Foundation
import CryptoKit
import CommonCrypto

// How this iPad comes to trust one particular Mac, and prove to it that it should be let in.
//
// There is no certificate authority that can vouch for a laptop on a home network, so the Mac signs
// its own certificate. What makes that safe is the pairing code: the proof sent to the Mac is
// derived from the code *and the certificate this iPad was just shown*, so a Mac can tell whether it
// is really the one being talked to. Someone in the middle presents a certificate of their own,
// their proof does not match, and they learn nothing they could reuse.

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

/// Trust on first use, the way a machine on your own desk actually works.
///
/// There is no certificate authority that can vouch for a laptop on a home network, so the Mac signs
/// its own certificate and the pairing QR carries its fingerprint. Scanning that code off your own
/// screen is the trusted channel; from then on this refuses any certificate that does not match,
/// which is what stops someone on the same wifi from sitting in the middle.
final class PinnedCertificate: NSObject, URLSessionDelegate {
    /// During pairing there is nothing to compare against yet: accept whatever is offered and
    /// remember it, so the proof can be bound to it. The Mac is the one that decides whether that
    /// certificate was really its own — if it was not, pairing fails and nothing is kept.
    var learning = false
    var learned: String?
    private let expected: () -> String

    init(expected: @escaping () -> String) { self.expected = expected }

    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            return completionHandler(.performDefaultHandling, nil)
        }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        let got = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }.joined()

        if learning {
            learned = got
            return completionHandler(.useCredential, URLCredential(trust: trust))
        }

        let want = expected().lowercased()
        guard !want.isEmpty else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        if got == want {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

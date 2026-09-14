import Foundation
import Combine
import UIKit

/// User preferences, persisted in UserDefaults. Deliberately short: anything with one obviously
/// right answer is a behaviour, not a setting.
final class Settings: ObservableObject {
    private let d = UserDefaults.standard
    static let agentColor = UIColor(red: 0.78, green: 0.33, blue: 0.17, alpha: 1)

    /// host:port of the Mac server's plain-http listener (the one that also serves /mcp).
    @Published var host: String { didSet { d.set(host, forKey: "host") } }
    @Published var token: String { didSet { d.set(token, forKey: "token") } }
    /// sha256 of the Mac's self-signed certificate, taken from the pairing QR. Empty means plain
    /// http — there is no certificate authority on a home network, so this is what trust rests on.
    @Published var fingerprint: String { didSet { d.set(fingerprint, forKey: "fingerprint") } }
    /// Other addresses the same Mac answers on. Tried in turn when the first will not connect, so
    /// moving between networks does not mean pairing again.
    @Published var altHosts: [String] { didSet { d.set(altHosts, forKey: "altHosts") } }
    @Published var paper: Paper { didSet { d.set(paper.rawValue, forKey: "paper") } }

    init() {
        #if targetEnvironment(simulator)
        let defaultHost = "127.0.0.1:8791"
        #else
        let defaultHost = ""
        #endif
        host = d.string(forKey: "host") ?? defaultHost
        token = d.string(forKey: "token") ?? ""
        fingerprint = d.string(forKey: "fingerprint") ?? ""
        altHosts = d.stringArray(forKey: "altHosts") ?? []
        paper = Paper(rawValue: d.string(forKey: "paper") ?? "") ?? .plain
    }
}

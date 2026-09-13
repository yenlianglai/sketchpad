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
    /// Fingers pan and zoom, only the Pencil draws. Off lets a finger draw, for iPads without a Pencil.
    @Published var pencilOnly: Bool { didSet { d.set(pencilOnly, forKey: "pencilOnly") } }
    @Published var paper: Paper { didSet { d.set(paper.rawValue, forKey: "paper") } }

    init() {
        #if targetEnvironment(simulator)
        let defaultHost = "127.0.0.1:8791"
        #else
        let defaultHost = ""
        #endif
        host = d.string(forKey: "host") ?? defaultHost
        token = d.string(forKey: "token") ?? ""
        pencilOnly = d.object(forKey: "pencilOnly") as? Bool ?? true
        paper = Paper(rawValue: d.string(forKey: "paper") ?? "") ?? .plain
    }
}

import Foundation
import Combine
import UIKit

/// User preferences, persisted in UserDefaults.
final class Settings: ObservableObject {
    private let d = UserDefaults.standard
    static let agentColor = UIColor(red: 0.78, green: 0.33, blue: 0.17, alpha: 1)

    /// host:port of the Mac server's plain-http listener (the one that also serves /mcp).
    @Published var host: String { didSet { d.set(host, forKey: "host") } }
    @Published var token: String { didSet { d.set(token, forKey: "token") } }
    /// 0 = manual send only. Otherwise send automatically after this many seconds without a new stroke.
    @Published var autoSendSeconds: Double { didSet { d.set(autoSendSeconds, forKey: "autoSend") } }
    @Published var pencilOnly: Bool { didSet { d.set(pencilOnly, forKey: "pencilOnly") } }
    @Published var highlightNewStrokes: Bool { didSet { d.set(highlightNewStrokes, forKey: "diff") } }
    @Published var autoPlaceAgentDrawing: Bool { didSet { d.set(autoPlaceAgentDrawing, forKey: "autoPlace") } }
    @Published var pencilDoubleTapSends: Bool { didSet { d.set(pencilDoubleTapSends, forKey: "dtSend") } }
    @Published var autoHideChrome: Bool { didSet { d.set(autoHideChrome, forKey: "autoHide") } }
    @Published var paper: Paper { didSet { d.set(paper.rawValue, forKey: "paper") } }

    init() {
        #if targetEnvironment(simulator)
        let defaultHost = "127.0.0.1:8791"
        #else
        let defaultHost = ""
        #endif
        host = d.string(forKey: "host") ?? defaultHost
        token = d.string(forKey: "token") ?? ""
        autoSendSeconds = d.object(forKey: "autoSend") as? Double ?? 0
        pencilOnly = d.object(forKey: "pencilOnly") as? Bool ?? true
        highlightNewStrokes = d.object(forKey: "diff") as? Bool ?? true
        autoPlaceAgentDrawing = d.object(forKey: "autoPlace") as? Bool ?? true
        pencilDoubleTapSends = d.object(forKey: "dtSend") as? Bool ?? false
        autoHideChrome = d.object(forKey: "autoHide") as? Bool ?? true
        paper = Paper(rawValue: d.string(forKey: "paper") ?? "") ?? .plain
    }
}

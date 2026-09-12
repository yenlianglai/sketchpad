import Foundation
import Combine

/// User preferences, persisted in UserDefaults.
final class Settings: ObservableObject {
    private let d = UserDefaults.standard

    /// host:port of the Mac server's plain-http listener (the one that also serves /mcp).
    @Published var host: String { didSet { d.set(host, forKey: "host") } }
    @Published var token: String { didSet { d.set(token, forKey: "token") } }
    /// 0 = manual send only. Otherwise send automatically after this many seconds without a new stroke.
    @Published var autoSendSeconds: Double { didSet { d.set(autoSendSeconds, forKey: "autoSend") } }
    @Published var pencilOnly: Bool { didSet { d.set(pencilOnly, forKey: "pencilOnly") } }
    /// Fade previously-sent strokes to grey in the image so the agent sees what is new.
    @Published var highlightNewStrokes: Bool { didSet { d.set(highlightNewStrokes, forKey: "diff") } }
    /// Put SVG the agent draws back onto the canvas as editable strokes automatically.
    @Published var autoPlaceAgentDrawing: Bool { didSet { d.set(autoPlaceAgentDrawing, forKey: "autoPlace") } }
    @Published var pencilDoubleTapSends: Bool { didSet { d.set(pencilDoubleTapSends, forKey: "dtSend") } }

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
    }
}

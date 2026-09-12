import Foundation
import Combine
import UIKit

/// Something shown in the side panel.
struct ChatItem: Identifiable {
    enum Role { case user, agent, system }
    let id = UUID()
    let role: Role
    var text: String
    var image: UIImage? = nil
    var svg: String? = nil
    var imageURL: URL? = nil
    let time = Date()
}

/// Finds the Mac server (Bonjour `_sketchpad._tcp`, or a manual host) and talks to it:
/// POST /turn for sketches, WebSocket /ws for replies and snapshot requests.
@MainActor
final class ServerConnection: NSObject, ObservableObject {
    enum Status: Equatable { case disconnected, connecting, connected }

    @Published var status: Status = .disconnected
    @Published var activeHost = ""
    @Published var agentReady = false
    @Published var discovered: [String] = []      // host:port from Bonjour
    @Published var items: [ChatItem] = []
    @Published var lastError: String?

    /// Called when the agent asks for a snapshot of the canvas right now.
    var snapshotProvider: (() -> Data?)?
    var onReply: ((ChatItem) -> Void)?

    private var settings: Settings?
    private var socket: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 1
    private var reconnectTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    private lazy var session = URLSession(configuration: .default)

    // Bonjour
    private var browser: NetServiceBrowser?
    private var services: [NetService] = []

    func start(settings: Settings) {
        self.settings = settings
        startBrowsing()
        settings.$host.removeDuplicates().sink { [weak self] _ in self?.reconnectNow() }.store(in: &cancellables)
        connect()
    }

    // MARK: HTTP

    private var baseURL: URL? {
        guard let host = settings?.host, !host.isEmpty else { return nil }
        return URL(string: "http://\(host)")
    }
    private func withToken(_ url: URL) -> URL {
        guard let t = settings?.token, !t.isEmpty, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "token", value: t)]
        return c.url ?? url
    }

    /// Sends one turn. Returns the server's turn id.
    func sendTurn(png: Data, text: String, newStrokes: Int) async throws -> String {
        guard let base = baseURL else { throw NSError(domain: "sketchpad", code: 1, userInfo: [NSLocalizedDescriptionKey: "尚未設定主機"]) }
        var req = URLRequest(url: withToken(base.appendingPathComponent("turn")))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: Any] = ["text": text, "png": "data:image/png;base64," + png.base64EncodedString(), "strokes": newStrokes]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "sketchpad", code: 2, userInfo: [NSLocalizedDescriptionKey: "server 回應 \((resp as? HTTPURLResponse)?.statusCode ?? 0)"]) }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return json?["turnId"] as? String ?? "?"
    }

    private func postSnapshot(id: String, png: Data?) {
        guard let base = baseURL else { return }
        var req = URLRequest(url: withToken(base.appendingPathComponent("snapshot")))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: Any] = ["id": id]
        if let png { body["png"] = "data:image/png;base64," + png.base64EncodedString() }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: req).resume()
    }

    // MARK: WebSocket

    func reconnectNow() {
        reconnectDelay = 1
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connect()
    }

    private func connect() {
        guard let base = baseURL, var c = URLComponents(url: base.appendingPathComponent("ws"), resolvingAgainstBaseURL: false) else { status = .disconnected; return }
        c.scheme = "ws"
        guard let url = c.url else { return }
        status = .connecting
        activeHost = settings?.host ?? ""
        let task = session.webSocketTask(with: withToken(url))
        socket = task
        task.resume()
        receiveLoop(task)
        schedulePing(task)
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let msg):
                    if self.status != .connected { self.status = .connected; self.reconnectDelay = 1 }
                    if case .string(let s) = msg { self.handle(s) }
                    self.receiveLoop(task)
                case .failure(let err):
                    self.status = .disconnected
                    self.agentReady = false
                    self.lastError = err.localizedDescription
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func schedulePing(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            guard let self, self.socket === task else { return }
            task.sendPing { _ in }
            self.schedulePing(task)
        }
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 15)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8), let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = m["type"] as? String else { return }
        switch type {
        case "hello", "mcp":
            agentReady = (m["ready"] as? Bool) ?? (m["mcp"] as? Bool) ?? false
        case "reply":
            var item = ChatItem(role: .agent, text: m["text"] as? String ?? "")
            if let files = m["files"] as? [[String: Any]] {
                for f in files {
                    guard let url = f["url"] as? String else { continue }
                    if url.hasPrefix("data:image/svg+xml;base64,"), let d = Data(base64Encoded: String(url.dropFirst("data:image/svg+xml;base64,".count))) {
                        item.svg = String(data: d, encoding: .utf8)
                    } else if url.hasPrefix("/"), let base = baseURL {
                        item.imageURL = withToken(base.appendingPathComponent(url))
                    }
                }
            }
            items.append(item)
            onReply?(item)
        case "taken":
            items.append(ChatItem(role: .system, text: "agent 已讀取這回合"))
        case "sys":
            items.append(ChatItem(role: .system, text: m["text"] as? String ?? ""))
        case "snapshot_request":
            if let id = m["id"] as? String { postSnapshot(id: id, png: snapshotProvider?()) }
        default: break
        }
    }

    // MARK: Bonjour

    private func startBrowsing() {
        let b = NetServiceBrowser()
        b.delegate = self
        b.searchForServices(ofType: "_sketchpad._tcp.", inDomain: "local.")
        browser = b
    }
}

extension ServerConnection: NetServiceBrowserDelegate, NetServiceDelegate {
    nonisolated func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        Task { @MainActor in
            service.delegate = self
            services.append(service)
            service.resolve(withTimeout: 5)
        }
    }
    nonisolated func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        Task { @MainActor in
            services.removeAll { $0 == service }
            if let host = service.hostName { discovered.removeAll { $0.hasPrefix(host.trimmingCharacters(in: CharacterSet(charactersIn: "."))) } }
        }
    }
    nonisolated func netServiceDidResolveAddress(_ sender: NetService) {
        Task { @MainActor in
            guard let host = sender.hostName else { return }
            let entry = "\(host.trimmingCharacters(in: CharacterSet(charactersIn: "."))):\(sender.port)"
            if !discovered.contains(entry) { discovered.append(entry) }
            // First discovery with no manual host configured: adopt it.
            if let s = settings, s.host.isEmpty { s.host = entry }
        }
    }
}

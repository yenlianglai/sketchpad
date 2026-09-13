import Foundation
import Combine
import UIKit

/// A file the agent handed back with a reply.
struct ReplyFile { var kind: String; var name: String; var svg: String?; var remoteURL: URL?; var layer: Bool }
struct Reply { var id: String; var ts: Double; var text: String; var turnId: String?; var files: [ReplyFile] }

/// Finds the Mac server (Bonjour `_sketchpad._tcp`, or a manual host) and talks to it:
/// POST /turn for sketches, WebSocket /ws for replies and requests.
@MainActor
final class ServerConnection: NSObject, ObservableObject {
    enum Status: Equatable { case disconnected, connecting, connected }
    /// Something the Mac wants to know. The iPad is the only place the pages live, so it answers.
    enum Event { case reply(Reply), taken(String), title(boardId: String?, title: String), ask(id: String, kind: String, params: [String: Any]), system(String) }

    @Published var status: Status = .disconnected
    /// The server is up. Says nothing about whether an agent is in the loop.
    @Published var agentReady = false
    /// An agent is actually blocked in wait_for_turn (or polled moments ago).
    @Published var agentListening = false
    @Published var discovered: [String] = []
    @Published var lastError: String?

    var onEvent: ((Event) -> Void)?

    private var settings: Settings?
    private var socket: URLSessionWebSocketTask?
    private var reconnectDelay: TimeInterval = 1
    private var reconnectTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    private lazy var session = URLSession(configuration: .default)
    private var browser: NetServiceBrowser?
    private var services: [NetService] = []

    func start(settings: Settings) {
        self.settings = settings
        startBrowsing()
        settings.$host.removeDuplicates().dropFirst().sink { [weak self] _ in self?.reconnectNow() }.store(in: &cancellables)
        connect()
    }

    // MARK: HTTP

    var baseURL: URL? {
        guard let host = settings?.host, !host.isEmpty else { return nil }
        return URL(string: "http://\(host)")
    }
    func withToken(_ url: URL) -> URL {
        guard let t = settings?.token, !t.isEmpty, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "token", value: t)]
        return c.url ?? url
    }

    /// Sends one turn. Returns the server's turn id.
    func sendTurn(png: Data, text: String, newStrokes: Int, boardId: UUID, boardTitle: String) async throws -> String {
        guard let base = baseURL else { throw NSError(domain: "sketchpad", code: 1, userInfo: [NSLocalizedDescriptionKey: "No host configured"]) }
        var req = URLRequest(url: withToken(base.appendingPathComponent("turn")))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: Any] = ["text": text, "png": png.isEmpty ? NSNull() : "data:image/png;base64," + png.base64EncodedString(), "strokes": newStrokes, "boardId": boardId.uuidString, "boardTitle": boardTitle]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "sketchpad", code: 2, userInfo: [NSLocalizedDescriptionKey: "Server returned \((resp as? HTTPURLResponse)?.statusCode ?? 0)"]) }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return json?["turnId"] as? String ?? UUID().uuidString.prefix(8).lowercased()
    }

    /// Answer something the Mac asked over the socket.
    func postAnswer(id: String, _ fields: [String: Any]) {
        guard let base = baseURL else { return }
        var req = URLRequest(url: withToken(base.appendingPathComponent("answer")))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: fields.merging(["id": id]) { a, _ in a })
        session.dataTask(with: req).resume()
    }

    /// Download an agent file to a local URL.
    func download(_ url: URL, to dest: URL) async throws {
        let (data, resp) = try await session.data(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "sketchpad", code: 3, userInfo: [NSLocalizedDescriptionKey: "download failed"]) }
        try data.write(to: dest, options: .atomic)
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
                    if self.status != .connected { self.status = .connected; self.reconnectDelay = 1; self.lastError = nil }
                    if case .string(let s) = msg { self.handle(s) }
                    self.receiveLoop(task)
                case .failure(let err):
                    self.status = .disconnected
                    self.agentReady = false
                    self.agentListening = false
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
            if let l = m["listening"] as? Bool { agentListening = l }
        case "agents":
            agentListening = m["listening"] as? Bool ?? false
        case "reply":
            onEvent?(.reply(parseReply(m)))
        case "taken":
            if let id = m["turnId"] as? String { onEvent?(.taken(id)) }
        case "title":
            onEvent?(.title(boardId: m["boardId"] as? String, title: m["title"] as? String ?? ""))
        case "sys":
            onEvent?(.system(m["text"] as? String ?? ""))
        case "ask":
            if let id = m["id"] as? String, let kind = m["kind"] as? String { onEvent?(.ask(id: id, kind: kind, params: m)) }
        default: break
        }
    }

    private func parseReply(_ m: [String: Any]) -> Reply {
        var files: [ReplyFile] = []
        for f in (m["files"] as? [[String: Any]]) ?? [] {
            guard let url = f["url"] as? String else { continue }
            let kind = f["kind"] as? String ?? "image"
            let name = f["name"] as? String ?? "file"
            if url.hasPrefix("data:image/svg+xml;base64,"), let d = Data(base64Encoded: String(url.dropFirst("data:image/svg+xml;base64,".count))) {
                files.append(ReplyFile(kind: "sketch", name: name, svg: String(data: d, encoding: .utf8), remoteURL: nil, layer: false))
            } else if url.hasPrefix("/"), let base = baseURL {
                files.append(ReplyFile(kind: kind, name: name, svg: nil, remoteURL: withToken(base.appendingPathComponent(url)), layer: f["layer"] as? Bool ?? false))
            }
        }
        return Reply(id: m["id"] as? String ?? UUID().uuidString, ts: (m["ts"] as? Double ?? 0) / 1000,
                     text: m["text"] as? String ?? "", turnId: m["turnId"] as? String, files: files)
    }

    /// Replies the server broadcast while this iPad was not connected.
    func missedReplies(since: Double) async -> [Reply] {
        guard let base = baseURL else { return [] }
        guard var c = URLComponents(url: withToken(base.appendingPathComponent("replies")), resolvingAgainstBaseURL: false) else { return [] }
        let existing = c.queryItems ?? []
        c.queryItems = existing + [URLQueryItem(name: "since", value: String(Int(since * 1000)))]
        guard let url = c.url, let (data, _) = try? await session.data(from: url),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return rows.map(parseReply)
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
        Task { @MainActor in service.delegate = self; services.append(service); service.resolve(withTimeout: 5) }
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
            if let s = settings, s.host.isEmpty { s.host = entry }
        }
    }
}

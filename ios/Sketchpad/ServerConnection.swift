import Foundation
import Combine
import CryptoKit
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
    /// Every request goes through `pinned`, which is this object: the Mac signs its own
    /// certificate, so the only thing that makes it trustworthy is that its fingerprint matches the
    /// one in the QR we scanned off the screen.
    private lazy var session = URLSession(configuration: .default, delegate: pinned, delegateQueue: nil)
    private lazy var pinned = PinnedCertificate { [weak self] in self?.settings?.fingerprint ?? "" }
    private var browser: NetServiceBrowser?
    private var services: [NetService] = []

    func start(settings: Settings) {
        self.settings = settings
        startBrowsing()
        settings.$host.removeDuplicates().dropFirst().sink { [weak self] _ in self?.reconnectNow() }.store(in: &cancellables)
        connect()
    }

    // MARK: HTTP

    /// https once we have pinned a certificate; plain http for a server running without TLS.
    var scheme: String { (settings?.fingerprint.isEmpty ?? true) ? "http" : "https" }

    var baseURL: URL? {
        guard let host = settings?.host, !host.isEmpty else { return nil }
        return URL(string: "\(scheme)://\(host)")
    }
    /// A WebSocket handshake built from a QR code cannot carry a header, so the token goes in the
    /// query string there. Everything else uses `authorized(_:)` below.
    func withToken(_ url: URL) -> URL {
        guard let t = settings?.token, !t.isEmpty, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "token", value: t)]
        return c.url ?? url
    }

    /// A request carrying the token as a bearer header, which — unlike a query string — does not end
    /// up in server logs or proxy history.
    func authorized(_ url: URL, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let t = settings?.token, !t.isEmpty { req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization") }
        return req
    }

    /// Sends one turn. Returns the server's turn id.
    func sendTurn(png: Data, text: String, newStrokes: Int, boardId: UUID, boardTitle: String) async throws -> String {
        guard let base = baseURL else { throw NSError(domain: "sketchpad", code: 1, userInfo: [NSLocalizedDescriptionKey: "No host configured"]) }
        var req = authorized(base.appendingPathComponent("turn"), method: "POST")
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
        var req = authorized(base.appendingPathComponent("answer"), method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: fields.merging(["id": id]) { a, _ in a })
        session.dataTask(with: req).resume()
    }

    /// Exchange a pairing code for this iPad's own key. The code is good once, so this is the only
    /// chance to keep what comes back.
    func redeem(code: String, at host: String, fingerprint: String) async throws -> String {
        // Pin first: the exchange itself has to be protected, or the key could be handed to someone
        // standing in the middle of it.
        pinned.override = fingerprint
        defer { pinned.override = nil }
        guard let base = URL(string: "\(fingerprint.isEmpty ? "http" : "https")://\(host)") else {
            throw NSError(domain: "sketchpad", code: 4, userInfo: [NSLocalizedDescriptionKey: "That address is not valid"])
        }
        var req = URLRequest(url: base.appendingPathComponent("pair"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "name": UIDevice.current.name])

        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200,
              let token = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["token"] as? String else {
            throw NSError(domain: "sketchpad", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "That code did not work — it pairs one iPad once, and only for ten minutes. Run `sketchpad pair` for a new one."
            ])
        }
        return token
    }

    /// Download an agent file to a local URL.
    func download(_ url: URL, to dest: URL) async throws {
        let (data, resp) = try await session.data(for: authorized(url))
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
        c.scheme = scheme == "https" ? "wss" : "ws"
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
                // Stored plain: this is persisted with the turn, and a saved token would outlive
                // the pairing it came from. download(_:to:) adds the header when it fetches.
                files.append(ReplyFile(kind: kind, name: name, svg: nil, remoteURL: base.appendingPathComponent(url), layer: f["layer"] as? Bool ?? false))
            }
        }
        return Reply(id: m["id"] as? String ?? UUID().uuidString, ts: (m["ts"] as? Double ?? 0) / 1000,
                     text: m["text"] as? String ?? "", turnId: m["turnId"] as? String, files: files)
    }

    /// Replies the server broadcast while this iPad was not connected.
    func missedReplies(since: Double) async -> [Reply] {
        guard let base = baseURL else { return [] }
        guard var c = URLComponents(url: base.appendingPathComponent("replies"), resolvingAgainstBaseURL: false) else { return [] }
        c.queryItems = [URLQueryItem(name: "since", value: String(Int(since * 1000)))]
        guard let url = c.url, let (data, _) = try? await session.data(for: authorized(url)),
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


/// Trust on first use, the way a machine on your own desk actually works.
///
/// There is no certificate authority that can vouch for a laptop on a home network, so the Mac signs
/// its own certificate and the pairing QR carries its fingerprint. Scanning that code off your own
/// screen is the trusted channel; from then on this refuses any certificate that does not match,
/// which is what stops someone on the same wifi from sitting in the middle.
final class PinnedCertificate: NSObject, URLSessionDelegate {
    /// Used during pairing, before the fingerprint has been saved anywhere.
    var override: String?
    private let expected: () -> String

    init(expected: @escaping () -> String) { self.expected = expected }

    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            return completionHandler(.performDefaultHandling, nil)
        }
        let want = (override ?? expected()).lowercased()
        guard !want.isEmpty,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        let got = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }.joined()
        if got == want {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

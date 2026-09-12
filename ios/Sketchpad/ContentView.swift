import SwiftUI
import PencilKit
import AVFoundation
import WebKit

struct ContentView: View {
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var store: BoardStore
    @EnvironmentObject var conn: ServerConnection
    @StateObject private var canvasController = CanvasController()

    @State private var drawing = PKDrawing()
    @State private var caption = ""
    @State private var showPanel = true
    @State private var showSettings = false
    @State private var showPages = false
    @State private var sending = false
    @State private var flash: String?
    @State private var autoSendTask: Task<Void, Never>?
    @State private var speaker = AVSpeechSynthesizer()
    @State private var loadedBoardID: UUID?

    private var newStrokeCount: Int { max(0, drawing.strokes.count - store.current.sentStrokeCount) }

    var body: some View {
        HStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                CanvasView(drawing: $drawing, controller: canvasController, pencilOnly: settings.pencilOnly,
                           onStrokesChanged: strokesChanged,
                           onPencilDoubleTap: settings.pencilDoubleTapSends ? { Task { await send() } } : nil)
                    .ignoresSafeArea()
                topBar
                VStack { Spacer(); bottomBar }
                if let flash {
                    Text(flash).font(.callout.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.thinMaterial, in: Capsule()).frame(maxWidth: .infinity).padding(.top, 60)
                        .transition(.opacity)
                }
            }
            if showPanel {
                Divider()
                SidePanel(items: conn.items).frame(width: 340)
            }
        }
        .onAppear(perform: loadCurrentBoard)
        .onChange(of: store.currentID) { _, _ in loadCurrentBoard() }
        .onAppear {
            conn.snapshotProvider = { TurnRenderer.render(drawing, sentStrokeCount: 0, highlightNew: false)?.png }
            conn.onReply = { item in if settings.speakReplies, !item.text.isEmpty { speak(item.text) } }
        }
        .sheet(isPresented: $showSettings) { SettingsView().environmentObject(settings).environmentObject(conn) }
        .sheet(isPresented: $showPages) { PagesView().environmentObject(store) }
        .animation(.easeInOut(duration: 0.2), value: flash)
    }

    // MARK: bars

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { showPages = true } label: {
                Label(store.current.title, systemImage: "doc.on.doc").labelStyle(.titleAndIcon).lineLimit(1).fixedSize()
            }
            Button { canvasController.undo() } label: { Image(systemName: "arrow.uturn.backward") }
            Button { canvasController.redo() } label: { Image(systemName: "arrow.uturn.forward") }
            Button(role: .destructive) { store.clearCurrent(); drawing = PKDrawing() } label: { Image(systemName: "trash") }
            Spacer()
            statusChip
            Button { showSettings = true } label: { Image(systemName: "gearshape") }
            Button { withAnimation { showPanel.toggle() } } label: { Image(systemName: showPanel ? "sidebar.trailing" : "sidebar.leading") }
        }
        .buttonStyle(.bordered).controlSize(.regular)
        .padding(.horizontal, 12).padding(.top, 8)
    }

    private var statusChip: some View {
        HStack(spacing: 6) {
            Circle().fill(conn.status == .connected ? Color.green : conn.status == .connecting ? .orange : .red).frame(width: 9, height: 9)
            Text(conn.status == .connected ? (conn.agentReady ? "agent 已連線" : "server 已連線") : conn.status == .connecting ? "連線中…" : "未連線")
                .font(.footnote).foregroundStyle(.secondary).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 10).padding(.vertical, 6).background(.thinMaterial, in: Capsule())
    }

    private var bottomBar: some View {
        HStack(alignment: .bottom, spacing: 12) {
            // Scribble turns Pencil handwriting in this field into text: a free caption channel.
            TextField("用 Pencil 在這裡寫註解（可空白）", text: $caption)
                .textFieldStyle(.plain).padding(.horizontal, 14).padding(.vertical, 10)
                .background(.thinMaterial, in: Capsule()).frame(maxWidth: 460)
                .submitLabel(.send).onSubmit { Task { await send() } }
            Spacer()
            Button { Task { await send() } } label: {
                HStack(spacing: 8) {
                    if sending { ProgressView().tint(.white) } else { Image(systemName: "paperplane.fill") }
                    Text("送出")
                    if newStrokeCount > 0 { Text("\(newStrokeCount)").font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 2).background(.white.opacity(0.25), in: Capsule()) }
                }
                .font(.title3.weight(.semibold)).padding(.horizontal, 22).padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent).tint(.black).clipShape(Capsule())
            .disabled(sending || (drawing.strokes.isEmpty && caption.isEmpty))
            .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(.horizontal, 16).padding(.bottom, 150) // clear of the floating PencilKit tool picker
    }

    // MARK: actions

    private func loadCurrentBoard() {
        guard loadedBoardID != store.currentID else { return }
        loadedBoardID = store.currentID
        drawing = store.current.drawing
    }

    private func strokesChanged() {
        var b = store.current
        b.drawing = drawing
        // Undo past the sent boundary: clamp so the diff stays meaningful.
        b.sentStrokeCount = min(b.sentStrokeCount, drawing.strokes.count)
        store.current = b
        scheduleAutoSend()
    }

    private func scheduleAutoSend() {
        autoSendTask?.cancel()
        guard settings.autoSendSeconds > 0, newStrokeCount > 0 else { return }
        autoSendTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(settings.autoSendSeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await send()
        }
    }

    @MainActor
    private func send() async {
        autoSendTask?.cancel()
        guard !sending else { return }
        let text = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        let rendered = TurnRenderer.render(drawing, sentStrokeCount: store.current.sentStrokeCount, highlightNew: settings.highlightNewStrokes)
        guard rendered != nil || !text.isEmpty else { return }
        sending = true
        defer { sending = false }
        do {
            let png = rendered?.png ?? Data()
            _ = try await conn.sendTurn(png: png, text: text, newStrokes: newStrokeCount)
            conn.items.append(ChatItem(role: .user, text: text.isEmpty ? "（圖）" : text, image: rendered?.image))
            var b = store.current
            b.sentStrokeCount = drawing.strokes.count
            store.current = b
            caption = ""
            showFlash(conn.agentReady ? "已送給 agent" : "已送出，agent 尚未連上")
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            showFlash("送出失敗：\(error.localizedDescription)")
        }
    }

    private func showFlash(_ s: String) {
        flash = s
        Task { try? await Task.sleep(nanoseconds: 1_800_000_000); if flash == s { flash = nil } }
    }

    private func speak(_ text: String) {
        speaker.stopSpeaking(at: .immediate)
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "zh-TW")
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.05
        speaker.speak(u)
    }
}

// MARK: - Side panel

struct SidePanel: View {
    let items: [ChatItem]
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    Text("對話").font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase).padding(.top, 14)
                    if items.isEmpty {
                        Text("畫點東西，按送出。agent 的回覆會出現在這裡。").font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(items) { item in ChatBubble(item: item).id(item.id) }
                }
                .padding(.horizontal, 14).padding(.bottom, 20)
            }
            .onChange(of: items.count) { _, _ in if let last = items.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
        }
        .background(Color(uiColor: .secondarySystemBackground))
    }
}

struct ChatBubble: View {
    let item: ChatItem
    var body: some View {
        switch item.role {
        case .system:
            Text(item.text).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                if let img = item.image { Image(uiImage: img).resizable().scaledToFit().frame(maxHeight: 160).clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary)) }
                if item.text != "（圖）" { Text(item.text) }
            }
            .padding(10).background(Color(uiColor: .tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .agent:
            VStack(alignment: .leading, spacing: 8) {
                if !item.text.isEmpty { Text(item.text).textSelection(.enabled) }
                if let svg = item.svg { SVGView(svg: svg).frame(height: 200).clipShape(RoundedRectangle(cornerRadius: 8)) }
                if let url = item.imageURL { AsyncImage(url: url) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }.frame(maxHeight: 200) }
            }
            .padding(12).background(Color(red: 1, green: 0.96, blue: 0.93), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(red: 0.95, green: 0.85, blue: 0.8)))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct SVGView: UIViewRepresentable {
    let svg: String
    func makeUIView(context: Context) -> WKWebView {
        let v = WKWebView()
        v.isOpaque = false
        v.scrollView.isScrollEnabled = false
        return v
    }
    func updateUIView(_ v: WKWebView, context: Context) {
        let html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><style>html,body{margin:0;height:100%;background:#fff}svg{width:100%;height:100%}</style>\(svg)"
        v.loadHTMLString(html, baseURL: nil)
    }
}

// MARK: - Pages

struct PagesView: View {
    @EnvironmentObject var store: BoardStore
    @Environment(\.dismiss) var dismiss
    var body: some View {
        NavigationStack {
            List {
                ForEach(store.boards) { b in
                    Button { store.currentID = b.id; dismiss() } label: {
                        HStack {
                            Image(uiImage: TurnRenderer.render(b.drawing, sentStrokeCount: 0, highlightNew: false)?.image ?? UIImage())
                                .resizable().scaledToFit().frame(width: 96, height: 64).background(.white).clipShape(RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                            VStack(alignment: .leading) {
                                Text(b.title).foregroundStyle(.primary)
                                Text("\(b.drawing.strokes.count) 筆 · \(b.updatedAt.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if b.id == store.currentID { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                }
                .onDelete { idx in idx.map { store.boards[$0].id }.forEach(store.delete) }
            }
            .navigationTitle("頁面")
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button { store.newBoard(); dismiss() } label: { Label("新頁", systemImage: "plus") } }
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
            }
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var conn: ServerConnection
    @Environment(\.dismiss) var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("連線") {
                    TextField("主機:埠（例如 192.168.0.128:8791）", text: $settings.host).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    if !conn.discovered.isEmpty {
                        ForEach(conn.discovered, id: \.self) { h in
                            Button { settings.host = h } label: { Label(h, systemImage: "bonjour") }
                        }
                    } else {
                        Text("在區網上找不到 Mac。確認 Mac 端已跑 `npm run web-only`。").font(.footnote).foregroundStyle(.secondary)
                    }
                    TextField("Token（選填）", text: $settings.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if let e = conn.lastError { Text(e).font(.footnote).foregroundStyle(.red) }
                }
                Section("送出") {
                    Toggle("只接受 Apple Pencil", isOn: $settings.pencilOnly)
                    Toggle("新筆跡強調（舊筆跡變灰）", isOn: $settings.highlightNewStrokes)
                    Toggle("Pencil 雙擊送出", isOn: $settings.pencilDoubleTapSends)
                    VStack(alignment: .leading) {
                        Text(settings.autoSendSeconds == 0 ? "停筆自動送出：關閉" : "停筆 \(Int(settings.autoSendSeconds)) 秒自動送出")
                        Slider(value: $settings.autoSendSeconds, in: 0...8, step: 1)
                    }
                }
                Section("回覆") {
                    Toggle("朗讀 agent 回覆", isOn: $settings.speakReplies)
                }
            }
            .navigationTitle("設定")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

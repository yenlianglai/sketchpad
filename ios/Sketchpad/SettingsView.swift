import SwiftUI
import PencilKit

// MARK: - Settings

struct SettingsView: View {
    var onPair: () -> Void
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var conn: ServerConnection
    @Environment(\.dismiss) var dismiss
    @State private var showManual = false

    private var statusLine: String {
        switch conn.status {
        case .connected: return conn.agentListening ? "Connected · an agent is listening" : "Connected · no agent listening yet"
        case .connecting: return "Connecting…"
        case .disconnected: return "Not connected"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Mac") { Text(settings.host.isEmpty ? "not set" : settings.host).foregroundStyle(.secondary) }
                    HStack(spacing: 8) {
                        Circle().fill(conn.status == .connected ? (conn.agentListening ? Color.green : Color.orange) : Color.red).frame(width: 8, height: 8)
                        Text(statusLine).font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(conn.discovered.filter { $0 != settings.host }, id: \.self) { h in
                        Button { settings.host = h } label: { Label("Switch to \(h)", systemImage: "bonjour") }
                    }
                    if let e = conn.lastError, conn.status != .connected { Text(e).font(.footnote).foregroundStyle(.red) }
                } header: { Text("Connection") } footer: {
                    Text("Sketchpad finds your Mac on the network by itself. Start it there with `npm run web-only`.")
                }

                Section("Canvas") {
                    Picker("Paper", selection: $settings.paper) { Text("Plain").tag(Paper.plain); Text("Dots").tag(Paper.dots); Text("Grid").tag(Paper.grid) }.pickerStyle(.segmented)
                    Toggle("Pencil only", isOn: $settings.pencilOnly)
                    Text("Fingers pan and zoom; only the Pencil draws. Turn this off and a finger draws — so will the hand you rest on the screen.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section {
                    Button { onPair() } label: { Label("Pair with a code", systemImage: "key.horizontal") }
                    DisclosureGroup("Advanced", isExpanded: $showManual) {
                        TextField("Address (e.g. 192.168.0.9:8791)", text: $settings.host).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        TextField("Token", text: $settings.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Shown over the canvas until an iPad has a Mac to talk to.
struct ConnectionCard: View {
    let discovered: [String]
    var onPick: (String) -> Void
    var onPair: () -> Void
    var onManual: () -> Void
    var body: some View {
        VStack(spacing: 14) {
            if discovered.isEmpty {
                ProgressView().controlSize(.large)
                Text("Looking for your Mac").font(.headline)
                Text("Start Sketchpad on the Mac with `sketchpad start`, and keep both on the same network.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else {
                Text("Found your Mac").font(.headline)
                ForEach(discovered, id: \.self) { h in
                    Button { onPick(h) } label: { Label(h, systemImage: "laptopcomputer").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).tint(.black).controlSize(.large)
                }
            }
            let scan = Button { onPair() } label: {
                Label("Pair with a code", systemImage: "key.horizontal").frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            if discovered.isEmpty { scan.buttonStyle(.borderedProminent).tint(.black) } else { scan.buttonStyle(.bordered) }
            Button("Enter an address instead", action: onManual).font(.subheadline)
        }
        .padding(28).frame(maxWidth: 420)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .shadow(color: .black.opacity(0.14), radius: 20, y: 8)
    }
}

import SwiftUI

/// Who is connected, and the ability to change your mind about it.
///
/// An agent used to be an anonymous light in the corner. You could see that something was listening
/// but not what, and had no way to stop it. Anything you hand your drawings to should be something
/// you can name and something you can shut out.
struct AgentsView: View {
    @EnvironmentObject var conn: ServerConnection
    @Environment(\.dismiss) private var dismiss
    @State private var confirming: Agent?

    var body: some View {
        NavigationStack {
            List {
                if conn.agents.isEmpty {
                    ContentUnavailableView(
                        "No agent connected",
                        systemImage: "antenna.radiowaves.left.and.right.slash",
                        description: Text("Connect one with `sketchpad install` on your computer, then say `/sketchpad` to it.")
                    )
                } else {
                    Section {
                        ForEach(conn.agents) { agent in
                            row(agent)
                        }
                    } footer: {
                        Text("Disconnecting an agent stops it reaching this iPad until you restart Sketchpad on your computer.")
                    }
                }
            }
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog(
                "Disconnect \(confirming?.label ?? "")?",
                isPresented: .init(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    if let agent = confirming { Task { await conn.disconnect(agent) } }
                    confirming = nil
                }
                Button("Cancel", role: .cancel) { confirming = nil }
            } message: {
                Text("It will stop receiving anything you send, and will be told why.")
            }
        }
    }

    private func row(_ agent: Agent) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(agent.waiting ? Color(Settings.agentColor) : Color.secondary.opacity(0.35))
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.label).font(.body)
                Text(agent.waiting ? "listening for a page" : "connected, not listening")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(role: .destructive) { confirming = agent } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Disconnect \(agent.label)")
        }
        .padding(.vertical, 2)
    }
}

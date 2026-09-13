import SwiftUI
import PencilKit

// MARK: - Turn preview sheet

struct TurnPreview: View {
    @EnvironmentObject var store: BoardStore
    let turn: Turn
    let onBranch: () -> Void
    @Environment(\.dismiss) var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let img = store.turnImage(turn) { Image(uiImage: img).resizable().scaledToFit().background(.white).clipShape(RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary)) }
                    if !turn.note.isEmpty { Text(turn.note) }
                    if let a = turn.agentText { HStack(alignment: .top, spacing: 8) { Circle().fill(Color(uiColor: Settings.agentColor)).frame(width: 8, height: 8).padding(.top, 6); Text(a) } }
                }.padding(20)
            }
            .navigationTitle("Turn · \(turn.time.formatted(date: .omitted, time: .shortened))")
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button { onBranch(); dismiss() } label: { Label("Branch", systemImage: "arrow.triangle.branch") } }
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

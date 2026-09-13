import SwiftUI
import PencilKit

enum DrawerTab: String, CaseIterable { case turns = "Turns", media = "Media", pages = "Pages" }

/// Actions the drawer can ask the main view to perform.
struct DrawerActions {
    var placeSketch: (Turn, AgentItem) -> Void
    var placeLayer: (Turn, AgentItem) -> Void
    var branch: (Turn) -> Void
    var preview: (Turn) -> Void
    var removeAgentStrokes: (Turn) -> Void
    var openBoard: (UUID) -> Void
    var newBoard: () -> Void
    var flash: (String) -> Void
}

// MARK: - Drawer shell

struct Drawer: View {
    @Binding var tab: DrawerTab
    let actions: DrawerActions
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 22) {
                ForEach(DrawerTab.allCases, id: \.self) { t in
                    Button { withAnimation(.easeInOut(duration: 0.15)) { tab = t } } label: {
                        Text(t.rawValue).font(.subheadline.weight(.semibold))
                            .foregroundStyle(tab == t ? Color.primary : Color.secondary)
                            .padding(.bottom, 12)
                            .overlay(alignment: .bottom) { if tab == t { Rectangle().fill(Color.primary).frame(height: 2) } }
                    }.buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18)
            .overlay(alignment: .bottom) { Divider() }
            switch tab {
            case .turns: TurnsTab(actions: actions)
            case .media: MediaTab(actions: actions)
            case .pages: PagesTab(actions: actions)
            }
        }
        .background(.regularMaterial)
        .overlay(alignment: .leading) { Divider() }
    }
}

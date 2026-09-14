import SwiftUI

@main
struct SketchpadApp: App {
    @StateObject private var settings = Settings()
    @StateObject private var store = BoardStore()
    @StateObject private var connection = ServerConnection()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(store)
                .environmentObject(connection)
                .onAppear {
                    UIApplication.shared.isIdleTimerDisabled = true
                    connection.start(settings: settings)
                }
        }
        // iOS suspends the app when you leave it, which closes the socket. Coming back should
        // reconnect now, not when a backoff that was counting down while nothing was running
        // happens to fire — the first thing anyone does on returning is look at the status.
        .onChange(of: phase) { _, new in if new == .active { connection.wake() } }
    }
}

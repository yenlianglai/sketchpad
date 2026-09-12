import SwiftUI

@main
struct SketchpadApp: App {
    @StateObject private var settings = Settings()
    @StateObject private var store = BoardStore()
    @StateObject private var connection = ServerConnection()

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
    }
}

import SwiftUI
import UIKit

/// Answering the Mac's questions.
///
/// The server keeps nothing of what you draw — it holds a page only long enough to hand it to an
/// agent — so anything it needs to show an agent, it has to ask for.
extension ContentView {

    func answer(id: String, kind: String, params: [String: Any]) {
        switch kind {
        case "canvas":
            conn.postAnswer(id: id, png(renderCurrent(highlight: false)?.png))

        default:
            conn.postAnswer(id: id, [:])   // a newer server asking for something this app does not know
        }
    }

    private func png(_ data: Data?) -> [String: Any] {
        guard let data else { return [:] }
        return ["png": "data:image/png;base64," + data.base64EncodedString()]
    }
}

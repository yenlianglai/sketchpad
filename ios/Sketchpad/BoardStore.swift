import Foundation
import PencilKit
import Combine

/// One page of the sketchpad.
struct Board: Identifiable, Codable {
    var id = UUID()
    var title: String
    var drawingData: Data = PKDrawing().dataRepresentation()
    var updatedAt = Date()
    /// How many strokes had been sent to the agent at the last turn (prefix of `drawing.strokes`).
    var sentStrokeCount = 0

    var drawing: PKDrawing {
        get { (try? PKDrawing(data: drawingData)) ?? PKDrawing() }
        set { drawingData = newValue.dataRepresentation(); updatedAt = Date() }
    }
}

/// All pages, persisted as JSON in Documents. Saves are debounced.
@MainActor
final class BoardStore: ObservableObject {
    @Published var boards: [Board] = []
    @Published var currentID: UUID

    private var saveTask: Task<Void, Never>?
    private let url: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("boards.json")
    }()

    init() {
        let loaded: [Board]
        if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([Board].self, from: data), !saved.isEmpty {
            loaded = saved
        } else {
            loaded = [Board(title: "第 1 頁")]
        }
        boards = loaded
        currentID = loaded[0].id
    }

    var current: Board {
        get { boards.first { $0.id == currentID } ?? boards[0] }
        set {
            if let i = boards.firstIndex(where: { $0.id == newValue.id }) { boards[i] = newValue } else { boards.append(newValue) }
            scheduleSave()
        }
    }

    func newBoard() {
        let b = Board(title: "第 \(boards.count + 1) 頁")
        boards.append(b)
        currentID = b.id
        scheduleSave()
    }

    func delete(_ id: UUID) {
        guard boards.count > 1 else { clearCurrent(); return }
        boards.removeAll { $0.id == id }
        if currentID == id { currentID = boards[0].id }
        scheduleSave()
    }

    func clearCurrent() {
        var b = current
        b.drawing = PKDrawing()
        b.sentStrokeCount = 0
        current = b
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [boards, url] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            if let data = try? JSONEncoder().encode(boards) { try? data.write(to: url, options: .atomic) }
        }
    }
}

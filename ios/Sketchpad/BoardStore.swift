import Foundation
import PencilKit
import UIKit
import Combine

/// All pages and turns, persisted as JSON in Documents; images live beside as files. Saves are debounced.
@MainActor
final class BoardStore: ObservableObject {
    @Published var boards: [Board] = []
    @Published var turns: [Turn] = []
    @Published var currentID: UUID

    private var saveTask: Task<Void, Never>?
    private let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    private var boardsURL: URL { docs.appendingPathComponent("boards.json") }
    private var turnsURL: URL { docs.appendingPathComponent("turns.json") }
    var turnsDir: URL { docs.appendingPathComponent("turns", isDirectory: true) }
    var layersDir: URL { docs.appendingPathComponent("layers", isDirectory: true) }
    var agentDir: URL { docs.appendingPathComponent("agent", isDirectory: true) }

    private var imageCache: [String: UIImage] = [:]

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        for d in ["turns", "layers", "agent"] { try? FileManager.default.createDirectory(at: docs.appendingPathComponent(d), withIntermediateDirectories: true) }
        let dec = JSONDecoder()
        let loadedBoards = (try? dec.decode([Board].self, from: Data(contentsOf: docs.appendingPathComponent("boards.json")))) ?? []
        let initialBoards = loadedBoards.isEmpty ? [Board(title: "Untitled")] : loadedBoards
        let loadedTurns = (try? dec.decode([Turn].self, from: Data(contentsOf: docs.appendingPathComponent("turns.json")))) ?? []
        boards = initialBoards
        turns = loadedTurns
        currentID = initialBoards.sorted { $0.updatedAt > $1.updatedAt }[0].id
    }

    // MARK: boards

    var current: Board {
        get { boards.first { $0.id == currentID } ?? boards[0] }
        set {
            if let i = boards.firstIndex(where: { $0.id == newValue.id }) { boards[i] = newValue } else { boards.append(newValue) }
            scheduleSave()
        }
    }
    func board(_ id: UUID) -> Board? { boards.first { $0.id == id } }
    var boardsByRecency: [Board] { boards.sorted { $0.updatedAt > $1.updatedAt } }

    @discardableResult
    func newBoard(title: String = "Untitled") -> Board {
        let b = Board(title: title)
        boards.append(b)
        currentID = b.id
        scheduleSave()
        return b
    }

    func rename(_ id: UUID, to title: String) {
        guard let i = boards.firstIndex(where: { $0.id == id }) else { return }
        boards[i].title = title.trimmingCharacters(in: .whitespaces).isEmpty ? "Untitled" : title
        scheduleSave()
    }

    func duplicate(_ id: UUID) {
        guard var b = board(id) else { return }
        b.id = UUID(); b.title += " copy"; b.createdAt = Date(); b.updatedAt = Date(); b.sentStrokeCount = 0; b.agentStrokes = [:]
        b.layers = b.layers.map { var l = $0; l.id = UUID(); return l }
        boards.append(b); currentID = b.id; scheduleSave()
    }

    func delete(_ id: UUID) {
        if boards.count == 1 { clearCurrent(); return }
        boards.removeAll { $0.id == id }
        turns.removeAll { $0.boardID == id }
        if currentID == id { currentID = boardsByRecency[0].id }
        scheduleSave()
    }

    func clearCurrent() {
        var b = current
        b.drawing = PKDrawing(); b.layers = []; b.sentStrokeCount = 0; b.agentStrokes = [:]
        current = b
    }

    /// New page whose content is what the canvas looked like at `turn`.
    @discardableResult
    func branch(from turn: Turn) -> Board {
        let src = board(turn.boardID)
        var b = Board(title: "\(src?.title ?? "Page") · branch")
        b.drawingData = turn.drawingData
        b.layers = turn.layers.map { var l = $0; l.id = UUID(); return l }
        b.branchedFrom = Board.Branch(boardID: turn.boardID, boardTitle: src?.title ?? "", turnId: turn.id)
        // Agent strokes up to that turn keep their provenance.
        if let src {
            let earlier = Set(turnsFor(turn.boardID).filter { $0.time <= turn.time }.map(\.id))
            b.agentStrokes = src.agentStrokes.filter { entry in earlier.contains(entry.key) }
        }
        boards.append(b); currentID = b.id; scheduleSave()
        return b
    }

    // MARK: turns

    func turnsFor(_ boardID: UUID) -> [Turn] { turns.filter { $0.boardID == boardID }.sorted { $0.time < $1.time } }
    var currentTurns: [Turn] { turnsFor(currentID) }
    func turn(_ id: String) -> Turn? { turns.first { $0.id == id } }

    func addTurn(_ t: Turn, png: Data?) {
        var t = t
        if let png { let name = "\(t.id).png"; try? png.write(to: turnsDir.appendingPathComponent(name)); t.pngFile = name }
        turns.append(t)
        var b = current; b.updatedAt = Date(); current = b
        scheduleSave()
    }

    func update(_ turnId: String, _ f: (inout Turn) -> Void) {
        guard let i = turns.firstIndex(where: { $0.id == turnId }) else { return }
        f(&turns[i]); scheduleSave()
    }

    func turnImage(_ t: Turn) -> UIImage? {
        guard let f = t.pngFile else { return nil }
        if let c = imageCache[f] { return c }
        let img = UIImage(contentsOfFile: turnsDir.appendingPathComponent(f).path)
        if let img { imageCache[f] = img }
        return img
    }

    // MARK: agent files & layers

    func agentFileURL(_ name: String) -> URL { agentDir.appendingPathComponent(name) }
    func layerFileURL(_ name: String) -> URL { layersDir.appendingPathComponent(name) }

    func image(named name: String, in dir: URL) -> UIImage? {
        let key = dir.lastPathComponent + "/" + name
        if let c = imageCache[key] { return c }
        let img = UIImage(contentsOfFile: dir.appendingPathComponent(name).path)
        if let img { imageCache[key] = img }
        return img
    }

    /// Copy an agent image into layers/ and add it to the current board at `frame`.
    @discardableResult
    func addLayer(fromAgentFile name: String, kind: String, turnId: String?, frame: CGRect) -> Layer? {
        let src = agentFileURL(name)
        let dst = layerFileURL(name)
        if !FileManager.default.fileExists(atPath: dst.path) { try? FileManager.default.copyItem(at: src, to: dst) }
        guard FileManager.default.fileExists(atPath: dst.path) else { return nil }
        let layer = Layer(file: name, kind: kind, frame: frame, turnId: turnId)
        var b = current; b.layers.append(layer); b.updatedAt = Date(); current = b
        return layer
    }

    func updateLayer(_ layer: Layer) {
        var b = current
        if let i = b.layers.firstIndex(where: { $0.id == layer.id }) { b.layers[i] = layer; current = b }
    }
    func removeLayer(_ id: UUID) {
        var b = current; b.layers.removeAll { $0.id == id }; current = b
    }

    // MARK: agent stroke provenance

    func recordAgentStrokes(turnId: String, dates: [TimeInterval]) {
        var b = current
        b.agentStrokes[turnId, default: []].append(contentsOf: dates)
        current = b
    }

    /// Remove every stroke the agent added in `turnId` from the current page.
    func removeAgentStrokes(turnId: String, from drawing: inout PKDrawing) {
        var b = current
        guard let dates = b.agentStrokes[turnId] else { return }
        let set = Set(dates)
        drawing = PKDrawing(strokes: drawing.strokes.filter { !set.contains($0.path.creationDate.timeIntervalSince1970) })
        b.agentStrokes[turnId] = nil
        b.drawing = drawing
        b.sentStrokeCount = min(b.sentStrokeCount, drawing.strokes.count)
        current = b
    }

    // MARK: save

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [boards, turns, boardsURL, turnsURL] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            let enc = JSONEncoder()
            if let d = try? enc.encode(boards) { try? d.write(to: boardsURL, options: .atomic) }
            if let d = try? enc.encode(turns) { try? d.write(to: turnsURL, options: .atomic) }
        }
    }
}

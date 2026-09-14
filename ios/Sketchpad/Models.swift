import Foundation
import PencilKit
import CoreGraphics

/// A rendered image the agent handed over (mermaid, draw.io, generated image…) placed under the strokes.
struct Layer: Identifiable, Codable, Equatable {
    var id = UUID()
    var file: String            // file name inside Documents/layers
    var kind: String            // mermaid | drawio | image | other
    var frame: CGRect           // canvas coordinates
    var locked = false
    var turnId: String?
}

/// Something the agent sent back in reply to a turn.
struct AgentItem: Identifiable, Codable, Equatable {
    var id = UUID()
    var kind: String            // sketch (svg → strokes) | mermaid | drawio | image | other
    var svg: String?            // for sketch: the raw svg
    var note: String?           // for note: the words, kept so they can be re-laid-out or copied
    var file: String?           // for images: file name inside Documents/agent (downloaded)
    var remoteURL: String?      // where it came from, for retry
    var placedAsLayer = false
    var strokeDates: [TimeInterval] = []  // creation dates of the strokes this item added (provenance)
    var wantsLayer = false      // agent asked to place it immediately
}

/// One send: what the page looked like, what was said, what came back.
struct Turn: Identifiable, Codable, Equatable {
    var id: String              // server turn id
    var boardID: UUID
    var time = Date()
    var note: String
    var newStrokes: Int
    var drawingData: Data       // full strokes at send time (enables branching)
    var layers: [Layer]         // layers at send time
    var pngFile: String?        // Documents/turns/<id>.png — the image the agent saw
    var imageBounds: CGRect     // canvas rect the png covers
    var imageScale: CGFloat     // px per point
    var agentText: String?
    var agentItems: [AgentItem] = []
    var taken = false
    /// The agent spoke first (nothing was sent); the card shows as an agent message.
    var agentInitiated = false

    var drawing: PKDrawing { (try? PKDrawing(data: drawingData)) ?? PKDrawing() }
}

/// One page of the sketchpad.
struct Board: Identifiable, Codable, Equatable {
    var id = UUID()
    var title: String
    var drawingData: Data = PKDrawing().dataRepresentation()
    var layers: [Layer] = []
    var createdAt = Date()
    var updatedAt = Date()
    var sentStrokeCount = 0
    /// turnId → creation dates of strokes the agent added in that turn (provenance).
    var agentStrokes: [String: [TimeInterval]] = [:]
    var branchedFrom: Branch?
    /// Set once the person renames the page themselves; agent title suggestions then stop applying.
    var titleLocked = false

    struct Branch: Codable, Equatable { var boardID: UUID; var boardTitle: String; var turnId: String }

    var drawing: PKDrawing {
        get { (try? PKDrawing(data: drawingData)) ?? PKDrawing() }
        set { drawingData = newValue.dataRepresentation(); updatedAt = Date() }
    }
    var allAgentStrokeDates: Set<TimeInterval> { Set(agentStrokes.values.flatMap { $0 }) }
}

enum Paper: String, CaseIterable, Codable { case plain, dots, grid }

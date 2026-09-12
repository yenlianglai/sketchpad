import PencilKit
import UIKit

/// Turns a drawing into the PNG the agent sees.
/// Crops to the strokes (with padding), and optionally fades already-sent strokes to grey
/// so the new ones stand out.
enum TurnRenderer {
    static let maxPixels: CGFloat = 2400

    /// `bounds` is the canvas rect the image covers and `scale` its pixels-per-point, so SVG the agent
    /// draws in image pixel coordinates can be mapped back onto the canvas.
    static func render(_ drawing: PKDrawing, sentStrokeCount: Int, highlightNew: Bool) -> (png: Data, image: UIImage, bounds: CGRect, scale: CGFloat)? {
        guard !drawing.strokes.isEmpty else { return nil }

        var bounds = drawing.bounds.insetBy(dx: -48, dy: -48)
        if bounds.width < 480 { bounds = bounds.insetBy(dx: -(480 - bounds.width) / 2, dy: 0) }
        if bounds.height < 320 { bounds = bounds.insetBy(dx: 0, dy: -(320 - bounds.height) / 2) }
        let scale = min(2, maxPixels / max(bounds.width, bounds.height))

        let old: PKDrawing
        let new: PKDrawing
        if highlightNew, sentStrokeCount > 0, sentStrokeCount < drawing.strokes.count {
            let faded = drawing.strokes.prefix(sentStrokeCount).map { stroke -> PKStroke in
                var s = stroke
                s.ink = PKInk(s.ink.inkType, color: UIColor(white: 0.74, alpha: 1))
                return s
            }
            old = PKDrawing(strokes: faded)
            new = PKDrawing(strokes: Array(drawing.strokes.dropFirst(sentStrokeCount)))
        } else {
            old = PKDrawing()
            new = drawing
        }

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: bounds.size, format: format)
        let image = renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: bounds.size))
            let target = CGRect(origin: .zero, size: bounds.size)
            // Render strokes in light mode so ink colours are stable regardless of the iPad's theme.
            UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                if !old.strokes.isEmpty { old.image(from: bounds, scale: scale).draw(in: target) }
                new.image(from: bounds, scale: scale).draw(in: target)
            }
        }
        guard let png = image.pngData() else { return nil }
        return (png, image, bounds, scale)
    }
}

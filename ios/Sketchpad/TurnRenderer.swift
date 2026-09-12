import PencilKit
import UIKit

/// Turns a page (layers + strokes) into the PNG the agent sees.
/// Crops to the content (with padding); optionally fades already-sent strokes to grey so new ones stand out.
enum TurnRenderer {
    static let maxPixels: CGFloat = 2400

    struct Output { let png: Data; let image: UIImage; let bounds: CGRect; let scale: CGFloat }

    static func render(_ drawing: PKDrawing, layers: [Layer], layerImage: (Layer) -> UIImage?, sentStrokeCount: Int, highlightNew: Bool) -> Output? {
        var content = drawing.strokes.isEmpty ? CGRect.null : drawing.bounds
        for l in layers { content = content.union(l.frame) }
        guard !content.isNull, content.width > 0, content.height > 0 else { return nil }

        var bounds = content.insetBy(dx: -48, dy: -48)
        if bounds.width < 480 { bounds = bounds.insetBy(dx: -(480 - bounds.width) / 2, dy: 0) }
        if bounds.height < 320 { bounds = bounds.insetBy(dx: 0, dy: -(320 - bounds.height) / 2) }
        let scale = min(2, maxPixels / max(bounds.width, bounds.height))

        let old: PKDrawing
        let new: PKDrawing
        if highlightNew, sentStrokeCount > 0, sentStrokeCount < drawing.strokes.count {
            old = PKDrawing(strokes: drawing.strokes.prefix(sentStrokeCount).map { s in var s = s; s.ink = PKInk(s.ink.inkType, color: UIColor(white: 0.74, alpha: 1)); return s })
            new = PKDrawing(strokes: Array(drawing.strokes.dropFirst(sentStrokeCount)))
        } else {
            old = PKDrawing(); new = drawing
        }

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale; format.opaque = true
        let image = UIGraphicsImageRenderer(size: bounds.size, format: format).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: bounds.size))
            for l in layers {
                guard let img = layerImage(l) else { continue }
                img.draw(in: l.frame.offsetBy(dx: -bounds.minX, dy: -bounds.minY))
            }
            let target = CGRect(origin: .zero, size: bounds.size)
            UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                if !old.strokes.isEmpty { old.image(from: bounds, scale: scale).draw(in: target) }
                if !new.strokes.isEmpty { new.image(from: bounds, scale: scale).draw(in: target) }
            }
        }
        guard let png = image.pngData() else { return nil }
        return Output(png: png, image: image, bounds: bounds, scale: scale)
    }

    /// Small thumbnail of a drawing (for page cards).
    static func thumbnail(_ drawing: PKDrawing, layers: [Layer], layerImage: (Layer) -> UIImage?) -> UIImage? {
        render(drawing, layers: layers, layerImage: layerImage, sentStrokeCount: 0, highlightNew: false)?.image
    }
}

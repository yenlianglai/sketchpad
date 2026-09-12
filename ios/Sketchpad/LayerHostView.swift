import UIKit

/// Sits BEHIND the transparent PKCanvasView and draws the paper pattern plus image layers in canvas
/// coordinates. The canvas reports its contentOffset/zoomScale and we mirror them with a transform,
/// so layers scroll and zoom with the strokes.
final class LayerHostView: UIView {
    var contentSize = CGSize(width: 4000, height: 6000) { didSet { setNeedsLayout() } }
    var paper: Paper = .plain { didSet { paperLayer.setNeedsDisplay() } }
    var layers: [Layer] = [] { didSet { syncLayerViews() } }
    var imageProvider: ((Layer) -> UIImage?)?

    private let content = UIView()
    private let paperLayer = PaperLayer()
    private var imageViews: [UUID: UIImageView] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .white
        content.frame = CGRect(origin: .zero, size: contentSize)
        content.backgroundColor = .white
        paperLayer.frame = content.bounds
        paperLayer.contentsScale = UIScreen.main.scale
        paperLayer.host = self
        content.layer.addSublayer(paperLayer)
        addSubview(content)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        content.bounds = CGRect(origin: .zero, size: contentSize)
        paperLayer.frame = content.bounds
    }

    func sync(offset: CGPoint, zoom: CGFloat) {
        content.layer.anchorPoint = .zero
        content.layer.position = CGPoint(x: -offset.x, y: -offset.y)
        content.transform = CGAffineTransform(scaleX: zoom, y: zoom)
    }

    private func syncLayerViews() {
        let ids = Set(layers.map(\.id))
        for (id, v) in imageViews where !ids.contains(id) { v.removeFromSuperview(); imageViews[id] = nil }
        for l in layers {
            let v = imageViews[l.id] ?? {
                let iv = UIImageView(); iv.contentMode = .scaleToFill; content.addSubview(iv); imageViews[l.id] = iv; return iv
            }()
            if v.image == nil { v.image = imageProvider?(l) }
            v.frame = l.frame
        }
    }

    final class PaperLayer: CALayer {
        weak var host: LayerHostView?
        override func draw(in ctx: CGContext) {
            guard let paper = host?.paper, paper != .plain else { return }
            let step: CGFloat = 28
            ctx.setFillColor(UIColor(white: 0.85, alpha: 1).cgColor)
            ctx.setStrokeColor(UIColor(white: 0.92, alpha: 1).cgColor)
            ctx.setLineWidth(1)
            let b = bounds
            switch paper {
            case .dots:
                var y: CGFloat = step / 2
                while y < b.height { var x: CGFloat = step / 2; while x < b.width { ctx.fillEllipse(in: CGRect(x: x - 1, y: y - 1, width: 2, height: 2)); x += step }; y += step }
            case .grid:
                var x: CGFloat = 0
                while x < b.width { ctx.move(to: CGPoint(x: x, y: 0)); ctx.addLine(to: CGPoint(x: x, y: b.height)); x += step }
                var y: CGFloat = 0
                while y < b.height { ctx.move(to: CGPoint(x: 0, y: y)); ctx.addLine(to: CGPoint(x: b.width, y: y)); y += step }
                ctx.strokePath()
            case .plain: break
            }
        }
    }
}

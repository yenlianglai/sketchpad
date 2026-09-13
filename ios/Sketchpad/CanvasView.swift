import SwiftUI
import PencilKit

/// Bridge between SwiftUI and the live PKCanvasView: undo/redo, tool picker, viewport, drawing state.
final class CanvasController: ObservableObject {
    weak var canvas: PKCanvasView?
    weak var layerHost: LayerHostView?
    let toolPicker = PKToolPicker()
    @Published var isDrawing = false
    @Published var contentOffset = CGPoint.zero
    @Published var zoom: CGFloat = 1
    private var idleTask: Task<Void, Never>?

    func undo() { canvas?.undoManager?.undo() }
    func redo() { canvas?.undoManager?.redo() }

    /// Pen down hides the chrome. The matching pen-up can get lost when a Pencil tap lands on a
    /// button that overlaps the canvas, so every pen-down also arms a fallback that restores the
    /// chrome a few seconds later; drawing changes and pen-up shorten that to one second.
    func penDown() {
        if !isDrawing { isDrawing = true }
        penUp(after: 4.0)
    }
    func penUp(after seconds: Double = 1.0) {
        idleTask?.cancel()
        idleTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            isDrawing = false
        }
    }
    /// PKToolPicker only shows for the current first responder; tapping any SwiftUI control steals it
    /// from the canvas, so always hand it back before showing.
    func setToolPickerVisible(_ v: Bool) {
        guard let canvas else { return }
        toolPicker.setVisible(v, forFirstResponder: canvas)
        if v {
            if !canvas.isFirstResponder { canvas.becomeFirstResponder() }
            DispatchQueue.main.async { [weak self, weak canvas] in
                guard let self, let canvas else { return }
                if !canvas.isFirstResponder { canvas.becomeFirstResponder() }
                self.toolPicker.setVisible(true, forFirstResponder: canvas)
            }
        }
    }
    /// Layer mode: the pencil stops drawing; the overlay above handles pan/zoom/layers.
    func setDrawingEnabled(_ enabled: Bool) {
        guard let canvas else { return }
        canvas.drawingGestureRecognizer.isEnabled = enabled
        canvas.isScrollEnabled = enabled
        setToolPickerVisible(enabled)
    }
    /// Canvas point → view point (for overlays).
    func viewRect(for canvasRect: CGRect) -> CGRect {
        CGRect(x: (canvasRect.minX * zoom) - contentOffset.x, y: (canvasRect.minY * zoom) - contentOffset.y, width: canvasRect.width * zoom, height: canvasRect.height * zoom)
    }
    func canvasPoint(fromView p: CGPoint) -> CGPoint { CGPoint(x: (p.x + contentOffset.x) / zoom, y: (p.y + contentOffset.y) / zoom) }
    var visibleCanvasRect: CGRect {
        let size = canvas?.bounds.size ?? CGSize(width: 1000, height: 700)
        return CGRect(x: contentOffset.x / zoom, y: contentOffset.y / zoom, width: size.width / zoom, height: size.height / zoom)
    }

    /// Everything on the page, strokes and layers together.
    func contentRect(layers: [Layer]) -> CGRect {
        var r = canvas?.drawing.strokes.isEmpty == false ? canvas!.drawing.bounds : .null
        for l in layers { r = r.union(l.frame) }
        return r
    }

    /// Fit the whole page on screen, the way a two-finger double tap does everywhere else.
    func zoomToFit(layers: [Layer], inset: CGFloat = 40) {
        guard let canvas else { return }
        let content = contentRect(layers: layers)
        guard !content.isNull, content.width > 1, content.height > 1 else { return }
        canvas.zoom(to: content.insetBy(dx: -inset, dy: -inset), animated: true)
    }

    /// Bring a rect into view if it is off-screen, so the agent never draws somewhere you cannot see.
    func reveal(_ rect: CGRect, animated: Bool = true) {
        guard let canvas else { return }
        let visible = visibleCanvasRect.insetBy(dx: 24, dy: 24)
        guard !visible.contains(rect) else { return }
        canvas.scrollRectToVisible(CGRect(x: rect.midX * zoom - canvas.bounds.width / 2,
                                          y: rect.midY * zoom - canvas.bounds.height / 2,
                                          width: canvas.bounds.width, height: canvas.bounds.height), animated: animated)
    }
}

struct CanvasView: UIViewRepresentable {
    @Binding var drawing: PKDrawing
    let controller: CanvasController
    var pencilOnly: Bool
    var paper: Paper
    var layers: [Layer]
    var layerImage: (Layer) -> UIImage?
    var onStrokesChanged: () -> Void
    /// Long-pressing a layer (finger or Pencil) while drawing: hand the layer id back so the app can enter layer mode.
    var onLayerLongPress: ((UUID) -> Void)?
    /// A finger tap on bare canvas, used to dismiss the panel. Only fires when fingers cannot draw.
    var onTapEmpty: (() -> Void)?
    /// An image dropped onto the canvas, at that canvas point.
    var onDropImage: ((UIImage, CGPoint) -> Void)?

    static let contentSize = CGSize(width: 4000, height: 6000)

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .white

        let host = LayerHostView(frame: .zero)
        host.contentSize = Self.contentSize
        host.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(host)

        let canvas = PKCanvasView()
        canvas.translatesAutoresizingMaskIntoConstraints = false
        canvas.drawing = drawing
        canvas.delegate = context.coordinator
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.overrideUserInterfaceStyle = .light
        canvas.alwaysBounceVertical = true
        canvas.alwaysBounceHorizontal = true
        canvas.minimumZoomScale = 0.5
        canvas.maximumZoomScale = 4
        canvas.contentSize = Self.contentSize
        canvas.drawingPolicy = pencilOnly ? .pencilOnly : .anyInput
        canvas.contentInsetAdjustmentBehavior = .never
        container.addSubview(canvas)

        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: container.leadingAnchor), host.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.topAnchor.constraint(equalTo: container.topAnchor), host.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            canvas.leadingAnchor.constraint(equalTo: container.leadingAnchor), canvas.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            canvas.topAnchor.constraint(equalTo: container.topAnchor), canvas.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])

        // Long-press on a layer → layer mode. Only begins when the touch lands on a layer, so
        // ordinary drawing is untouched; when it fires it cancels the in-progress stroke.
        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.longPress(_:)))
        press.minimumPressDuration = 0.45
        press.allowableMovement = 10
        press.cancelsTouchesInView = true
        press.delegate = context.coordinator
        canvas.addGestureRecognizer(press)

        // The gestures every pencil app has: two fingers undo, three fingers redo, two-finger
        // double tap fits the page. Fingers never draw here, so none of them cost a stroke.
        let undo = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.twoFingerTap))
        undo.numberOfTouchesRequired = 2
        undo.delegate = context.coordinator
        canvas.addGestureRecognizer(undo)

        let redo = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.threeFingerTap))
        redo.numberOfTouchesRequired = 3
        redo.delegate = context.coordinator
        canvas.addGestureRecognizer(redo)

        let fit = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.zoomToFit))
        fit.numberOfTouchesRequired = 2
        fit.numberOfTapsRequired = 2
        fit.delegate = context.coordinator
        canvas.addGestureRecognizer(fit)
        undo.require(toFail: fit)

        // A single finger tap on bare canvas dismisses the panel.
        let bare = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.singleTap))
        bare.delegate = context.coordinator
        canvas.addGestureRecognizer(bare)

        // Drop a screenshot or a photo straight onto the page.
        container.addInteraction(UIDropInteraction(delegate: context.coordinator))

        controller.canvas = canvas
        controller.layerHost = host
        controller.toolPicker.addObserver(canvas)
        controller.toolPicker.setVisible(true, forFirstResponder: canvas)
        DispatchQueue.main.async { canvas.becomeFirstResponder() }
        context.coordinator.canvas = canvas
        context.coordinator.host = host
        host.imageProvider = layerImage
        host.paper = paper
        host.layers = layers
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        guard let canvas = context.coordinator.canvas, let host = context.coordinator.host else { return }
        canvas.drawingPolicy = pencilOnly ? .pencilOnly : .anyInput
        if !context.coordinator.updatingFromCanvas, canvas.drawing.strokes.count != drawing.strokes.count || canvas.drawing.bounds != drawing.bounds {
            canvas.drawing = drawing
        }
        host.imageProvider = layerImage
        if host.paper != paper { host.paper = paper }
        if host.layers != layers { host.layers = layers }
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIGestureRecognizerDelegate, UIDropInteractionDelegate {
        var parent: CanvasView
        var updatingFromCanvas = false
        weak var canvas: PKCanvasView?
        weak var host: LayerHostView?
        init(_ parent: CanvasView) { self.parent = parent }

        private func layer(at viewPoint: CGPoint) -> Layer? {
            guard let canvas else { return nil }
            let p = CGPoint(x: (viewPoint.x + canvas.contentOffset.x) / canvas.zoomScale, y: (viewPoint.y + canvas.contentOffset.y) / canvas.zoomScale)
            return parent.layers.reversed().first { $0.frame.insetBy(dx: -6, dy: -6).contains(p) }
        }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            if let tap = g as? UITapGestureRecognizer, tap.numberOfTouchesRequired == 1 {
                // Only when a finger cannot draw, and only on bare canvas.
                guard parent.pencilOnly, let canvas else { return false }
                return layer(at: tap.location(in: canvas)) == nil
            }
            guard g is UILongPressGestureRecognizer, let canvas, parent.onLayerLongPress != nil else { return true }
            return layer(at: g.location(in: canvas)) != nil
        }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        @objc func longPress(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began, let canvas, let l = layer(at: g.location(in: canvas)) else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            parent.onLayerLongPress?(l.id)
        }

        @objc func singleTap() { parent.onTapEmpty?() }

        @objc func twoFingerTap() {
            guard canvas?.undoManager?.canUndo == true else { return }
            canvas?.undoManager?.undo()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }

        @objc func threeFingerTap() {
            guard canvas?.undoManager?.canRedo == true else { return }
            canvas?.undoManager?.redo()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }

        @objc func zoomToFit() {
            parent.controller.zoomToFit(layers: parent.layers)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }

        // MARK: dropping an image

        func dropInteraction(_ i: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
            session.canLoadObjects(ofClass: UIImage.self)
        }
        func dropInteraction(_ i: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
            UIDropProposal(operation: .copy)
        }
        func dropInteraction(_ i: UIDropInteraction, performDrop session: UIDropSession) {
            guard let view = i.view else { return }
            let point = parent.controller.canvasPoint(fromView: session.location(in: view))
            session.loadObjects(ofClass: UIImage.self) { [weak self] items in
                guard let image = items.first as? UIImage else { return }
                self?.parent.onDropImage?(image, point)
            }
        }



        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            updatingFromCanvas = true
            parent.drawing = canvasView.drawing
            parent.onStrokesChanged()
            parent.controller.penUp()
            DispatchQueue.main.async { self.updatingFromCanvas = false }
        }
        func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) { parent.controller.penDown() }
        func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) { parent.controller.penUp() }

        func scrollViewDidScroll(_ scrollView: UIScrollView) { syncViewport(scrollView) }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { syncViewport(scrollView) }
        private func syncViewport(_ s: UIScrollView) {
            host?.sync(offset: s.contentOffset, zoom: s.zoomScale)
            let c = parent.controller
            if c.contentOffset != s.contentOffset { c.contentOffset = s.contentOffset }
            if c.zoom != s.zoomScale { c.zoom = s.zoomScale }
        }

    }
}

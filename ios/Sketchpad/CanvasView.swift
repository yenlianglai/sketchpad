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

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
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
            guard g is UILongPressGestureRecognizer, let canvas, parent.onLayerLongPress != nil else { return true }
            return layer(at: g.location(in: canvas)) != nil
        }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        @objc func longPress(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began, let canvas, let l = layer(at: g.location(in: canvas)) else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            parent.onLayerLongPress?(l.id)
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

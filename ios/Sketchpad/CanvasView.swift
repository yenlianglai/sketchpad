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

    func penDown() { idleTask?.cancel(); if !isDrawing { isDrawing = true } }
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
    var onPencilDoubleTap: (() -> Void)?

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

        let interaction = UIPencilInteraction()
        interaction.delegate = context.coordinator
        canvas.addInteraction(interaction)

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

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIPencilInteractionDelegate {
        var parent: CanvasView
        var updatingFromCanvas = false
        weak var canvas: PKCanvasView?
        weak var host: LayerHostView?
        init(_ parent: CanvasView) { self.parent = parent }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            updatingFromCanvas = true
            parent.drawing = canvasView.drawing
            parent.onStrokesChanged()
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

        func pencilInteractionDidTap(_ interaction: UIPencilInteraction) { parent.onPencilDoubleTap?() }
    }
}

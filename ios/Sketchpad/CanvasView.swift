import SwiftUI
import PencilKit

/// Gives SwiftUI buttons a handle on the live PKCanvasView (undo/redo, tool picker).
final class CanvasController: ObservableObject {
    weak var canvas: PKCanvasView?
    let toolPicker = PKToolPicker()
    func undo() { canvas?.undoManager?.undo() }
    func redo() { canvas?.undoManager?.redo() }
    var canUndo: Bool { canvas?.undoManager?.canUndo ?? false }
    var canRedo: Bool { canvas?.undoManager?.canRedo ?? false }
}

struct CanvasView: UIViewRepresentable {
    @Binding var drawing: PKDrawing
    let controller: CanvasController
    var pencilOnly: Bool
    var onStrokesChanged: () -> Void
    var onPencilDoubleTap: (() -> Void)?

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView()
        canvas.drawing = drawing
        canvas.delegate = context.coordinator
        canvas.backgroundColor = .white
        canvas.overrideUserInterfaceStyle = .light
        canvas.isOpaque = true
        canvas.alwaysBounceVertical = true
        canvas.alwaysBounceHorizontal = true
        canvas.minimumZoomScale = 0.5
        canvas.maximumZoomScale = 4
        canvas.contentSize = CGSize(width: 4000, height: 6000)
        canvas.drawingPolicy = pencilOnly ? .pencilOnly : .anyInput
        canvas.contentInsetAdjustmentBehavior = .never

        let interaction = UIPencilInteraction()
        interaction.delegate = context.coordinator
        canvas.addInteraction(interaction)

        controller.canvas = canvas
        controller.toolPicker.addObserver(canvas)
        controller.toolPicker.setVisible(true, forFirstResponder: canvas)
        DispatchQueue.main.async { canvas.becomeFirstResponder() }
        return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
        canvas.drawingPolicy = pencilOnly ? .pencilOnly : .anyInput
        // Only push the model into the view when the change did not originate from the view
        // (page switch, clear). Comparing stroke counts is cheap and good enough here.
        if !context.coordinator.updatingFromCanvas, canvas.drawing.strokes.count != drawing.strokes.count || canvas.drawing.bounds != drawing.bounds {
            canvas.drawing = drawing
        }
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIPencilInteractionDelegate {
        var parent: CanvasView
        var updatingFromCanvas = false
        init(_ parent: CanvasView) { self.parent = parent }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            updatingFromCanvas = true
            parent.drawing = canvasView.drawing
            parent.onStrokesChanged()
            DispatchQueue.main.async { self.updatingFromCanvas = false }
        }

        func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
            parent.onPencilDoubleTap?()
        }
    }
}

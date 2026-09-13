import SwiftUI
import UIKit

/// Full-canvas touch surface for "layer mode": the pencil stops drawing and fingers handle layers.
///  - tap a layer to select it (tap empty space to deselect)
///  - drag a layer to move it; drag empty space to pan the canvas
///  - long-press a layer to grab it (haptic), then pinch to scale it; pinch with nothing selected zooms the canvas
struct LayerModeOverlay: View {
    let layers: [Layer]
    @Binding var selectedID: UUID?
    @ObservedObject var controller: CanvasController
    var onChange: (Layer) -> Void

    @State private var dragStartFrame: CGRect?
    @State private var dragStartOffset: CGPoint?
    @State private var dragLayerID: UUID?
    @State private var dragBegan: Date?
    @State private var longPressed = false
    @State private var pinchStartFrame: CGRect?
    @State private var pinchStartZoom: CGFloat?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.white.opacity(0.001)
            // Faint outline on every layer so they read as objects while in this mode.
            ForEach(layers) { l in
                let r = controller.viewRect(for: l.frame)
                Rectangle().strokeBorder(Color(red: 0.14, green: 0.34, blue: 0.70).opacity(l.id == selectedID ? 0 : 0.35), lineWidth: 1)
                    .frame(width: r.width, height: r.height).offset(x: r.minX, y: r.minY).allowsHitTesting(false)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { p in
            selectedID = hit(p)?.id
        }
        .gesture(drag.simultaneously(with: pinch))
    }

    private func hit(_ viewPoint: CGPoint) -> Layer? {
        let p = controller.canvasPoint(fromView: viewPoint)
        return layers.reversed().first { $0.frame.insetBy(dx: -8, dy: -8).contains(p) }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { v in
                if dragBegan == nil {
                    dragBegan = Date()
                    let target = hit(v.startLocation)
                    dragLayerID = target?.id
                    dragStartFrame = target?.frame
                    dragStartOffset = controller.contentOffset
                    longPressed = false
                }
                let moved = hypot(v.translation.width, v.translation.height)
                if let id = dragLayerID, let start = dragStartFrame, let l = layers.first(where: { $0.id == id }) {
                    // Long press: grab (select) without moving.
                    if !longPressed, moved < 6, let t = dragBegan, Date().timeIntervalSince(t) > 0.45 {
                        longPressed = true
                        selectedID = id
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    }
                    if moved >= 3, !l.locked {
                        if selectedID != id { selectedID = id }
                        var m = l
                        m.frame.origin = CGPoint(x: start.minX + v.translation.width / controller.zoom, y: start.minY + v.translation.height / controller.zoom)
                        onChange(m)
                    }
                } else if let o = dragStartOffset, let canvas = controller.canvas, moved >= 3 {
                    var off = CGPoint(x: o.x - v.translation.width, y: o.y - v.translation.height)
                    off.x = max(0, min(off.x, canvas.contentSize.width * controller.zoom - canvas.bounds.width))
                    off.y = max(0, min(off.y, canvas.contentSize.height * controller.zoom - canvas.bounds.height))
                    canvas.contentOffset = off
                }
            }
            .onEnded { _ in dragBegan = nil; dragLayerID = nil; dragStartFrame = nil; dragStartOffset = nil; longPressed = false }
    }

    private var pinch: some Gesture {
        MagnificationGesture()
            .onChanged { scale in
                if let id = selectedID, let l = layers.first(where: { $0.id == id }), !l.locked {
                    if pinchStartFrame == nil { pinchStartFrame = l.frame }
                    guard let s = pinchStartFrame else { return }
                    let w = max(40, s.width * scale), h = s.height * (w / s.width)
                    var m = l
                    m.frame = CGRect(x: s.midX - w / 2, y: s.midY - h / 2, width: w, height: h)
                    onChange(m)
                } else if let canvas = controller.canvas {
                    if pinchStartZoom == nil { pinchStartZoom = canvas.zoomScale }
                    guard let z = pinchStartZoom else { return }
                    canvas.setZoomScale(min(canvas.maximumZoomScale, max(canvas.minimumZoomScale, z * scale)), animated: false)
                }
            }
            .onEnded { _ in pinchStartFrame = nil; pinchStartZoom = nil }
    }
}

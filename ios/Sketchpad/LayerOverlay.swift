import SwiftUI

/// Selection chrome for one image layer: drag to move, corner to resize (aspect kept), lock / delete / done.
struct LayerOverlay: View {
    let layer: Layer
    @ObservedObject var controller: CanvasController
    var onChange: (Layer) -> Void
    var onDelete: () -> Void
    var onDone: () -> Void

    @State private var startFrame: CGRect?

    var body: some View {
        let r = controller.viewRect(for: layer.frame)
        ZStack(alignment: .topLeading) {
            Rectangle()
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                .foregroundStyle(Color(red: 0.14, green: 0.34, blue: 0.70))
                .background(Color.white.opacity(0.001))
                .frame(width: r.width, height: r.height)
                .offset(x: r.minX, y: r.minY)
                .gesture(layer.locked ? nil : DragGesture(minimumDistance: 1)
                    .onChanged { v in
                        if startFrame == nil { startFrame = layer.frame }
                        guard let s = startFrame else { return }
                        var l = layer
                        l.frame.origin = CGPoint(x: s.minX + v.translation.width / controller.zoom, y: s.minY + v.translation.height / controller.zoom)
                        onChange(l)
                    }
                    .onEnded { _ in startFrame = nil })

            if !layer.locked {
                ForEach(0..<4, id: \.self) { i in handle(at: i, rect: r) }
            }

            HStack(spacing: 6) {
                Text("\(layer.kind) layer").font(.caption.weight(.semibold))
                Divider().frame(height: 14)
                Button { var l = layer; l.locked.toggle(); onChange(l) } label: { Image(systemName: layer.locked ? "lock.fill" : "lock.open") }
                Button(role: .destructive) { onDelete() } label: { Image(systemName: "trash") }
                Button { onDone() } label: { Text("Done").font(.caption.weight(.semibold)) }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(.thinMaterial, in: Capsule())
            .offset(x: r.minX, y: max(8, r.minY - 40))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func handle(at i: Int, rect r: CGRect) -> some View {
        let px = (i % 2 == 0) ? r.minX : r.maxX
        let py = (i < 2) ? r.minY : r.maxY
        return Circle().fill(.white).overlay(Circle().stroke(Color(red: 0.14, green: 0.34, blue: 0.70), lineWidth: 2))
            .frame(width: 18, height: 18)
            .offset(x: px - 9, y: py - 9)
            .gesture(DragGesture(minimumDistance: 1)
                .onChanged { v in
                    if startFrame == nil { startFrame = layer.frame }
                    guard let s = startFrame, s.width > 0 else { return }
                    let aspect = s.height / s.width
                    let dx = v.translation.width / controller.zoom
                    var l = layer
                    // Corner i: 0 TL, 1 TR, 2 BL, 3 BR. Resize from the opposite corner, keep aspect.
                    let growRight = (i % 2 == 1)
                    let newW = max(40, growRight ? s.width + dx : s.width - dx)
                    let newH = newW * aspect
                    let anchorX = growRight ? s.minX : s.maxX
                    let anchorY = (i < 2) ? s.maxY : s.minY
                    l.frame = CGRect(x: growRight ? anchorX : anchorX - newW, y: (i < 2) ? anchorY - newH : anchorY, width: newW, height: newH)
                    onChange(l)
                }
                .onEnded { _ in startFrame = nil })
    }
}

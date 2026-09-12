import Foundation
import PencilKit
import UIKit

/// Converts stroke-only SVG (what an agent draws back) into editable PencilKit strokes.
/// Supported: rect, circle, ellipse, line, polyline, polygon, path (M L H V C S Q T Z, absolute and relative;
/// arcs are approximated by a straight segment). Fills and text are ignored. `transform` is ignored except on
/// the root, which is handled through the mapping the caller supplies.
///
/// `mapping` converts SVG user units (the pixel space of the image the agent looked at) into canvas points.
struct SVGStrokeMapping {
    var origin: CGPoint      // canvas point for image pixel (0,0)
    var pixelsPerPoint: CGFloat // image scale factor
    var viewBox: CGRect?     // if the SVG declares a viewBox different from the image size, we scale by it
    var imageSize: CGSize

    func canvasPoint(_ p: CGPoint) -> CGPoint {
        var x = p.x, y = p.y
        if let vb = viewBox, vb.width > 0, vb.height > 0, imageSize.width > 0 {
            x = (x - vb.minX) * imageSize.width / vb.width
            y = (y - vb.minY) * imageSize.height / vb.height
        }
        return CGPoint(x: origin.x + x / pixelsPerPoint, y: origin.y + y / pixelsPerPoint)
    }
}

enum SVGStrokes {
    static func strokes(from svg: String, mapping: SVGStrokeMapping, defaultColor: UIColor) -> [PKStroke] {
        let parser = Parser(svg: svg)
        var mapping = mapping
        if let vb = parser.viewBox { mapping.viewBox = vb }
        let now = Date()
        return parser.shapes.compactMap { shape in
            let pts = shape.points.map(mapping.canvasPoint)
            guard pts.count >= 2 else { return nil }
            let widthPx = shape.strokeWidth ?? 3
            let width = max(1.5, widthPx / mapping.pixelsPerPoint)
            let color = shape.color ?? defaultColor
            var controlPoints: [PKStrokePoint] = []
            for p in pts {
                // PKStrokePath interpolates control points as a B-spline; repeating each vertex three times
                // makes the curve pass through it exactly, which keeps polygon corners sharp.
                let repeats = shape.sharp ? 3 : 1
                for _ in 0..<repeats {
                    controlPoints.append(PKStrokePoint(location: p, timeOffset: TimeInterval(controlPoints.count) * 0.01,
                                                       size: CGSize(width: width, height: width), opacity: 1, force: 1,
                                                       azimuth: 0, altitude: .pi / 2))
                }
            }
            let path = PKStrokePath(controlPoints: controlPoints, creationDate: now)
            return PKStroke(ink: PKInk(.pen, color: color), path: path)
        }
    }

    // MARK: - parsing

    struct Shape { var points: [CGPoint]; var color: UIColor?; var strokeWidth: CGFloat?; var sharp: Bool }

    final class Parser: NSObject, XMLParserDelegate {
        var shapes: [Shape] = []
        var viewBox: CGRect?
        private var inheritedStyle: [[String: String]] = []

        init(svg: String) {
            super.init()
            guard let data = svg.data(using: .utf8) else { return }
            let p = XMLParser(data: data)
            p.delegate = self
            p.parse()
        }

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes a: [String: String]) {
            var style = inheritedStyle.last ?? [:]
            for (k, v) in a where ["stroke", "stroke-width", "fill"].contains(k) { style[k] = v }
            if let css = a["style"] { for decl in css.split(separator: ";") { let kv = decl.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }; if kv.count == 2 { style[kv[0]] = kv[1] } } }
            inheritedStyle.append(style)

            func num(_ k: String, _ d: CGFloat = 0) -> CGFloat { CGFloat(Double(a[k]?.replacingOccurrences(of: "px", with: "") ?? "") ?? Double(d)) }
            let color = Self.color(style["stroke"]) ?? (style["stroke"] == nil ? Self.color(style["fill"]) : nil)
            let width = style["stroke-width"].flatMap { Double($0.replacingOccurrences(of: "px", with: "")) }.map { CGFloat($0) }
            func add(_ pts: [CGPoint], sharp: Bool) { guard pts.count >= 2 else { return }; shapes.append(Shape(points: pts, color: color, strokeWidth: width, sharp: sharp)) }

            switch name.lowercased() {
            case "svg":
                if let vb = a["viewBox"] ?? a["viewbox"] {
                    let n = vb.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
                    if n.count == 4 { viewBox = CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
                }
            case "rect":
                let x = num("x"), y = num("y"), w = num("width"), h = num("height")
                add([CGPoint(x: x, y: y), CGPoint(x: x + w, y: y), CGPoint(x: x + w, y: y + h), CGPoint(x: x, y: y + h), CGPoint(x: x, y: y)], sharp: true)
            case "circle":
                add(Self.ellipse(cx: num("cx"), cy: num("cy"), rx: num("r"), ry: num("r")), sharp: false)
            case "ellipse":
                add(Self.ellipse(cx: num("cx"), cy: num("cy"), rx: num("rx"), ry: num("ry")), sharp: false)
            case "line":
                add([CGPoint(x: num("x1"), y: num("y1")), CGPoint(x: num("x2"), y: num("y2"))], sharp: true)
            case "polyline", "polygon":
                var pts = Self.pointList(a["points"] ?? "")
                if name.lowercased() == "polygon", let f = pts.first { pts.append(f) }
                add(pts, sharp: true)
            case "path":
                for sub in Self.pathSubpaths(a["d"] ?? "") { add(sub.points, sharp: sub.sharp) }
            default: break
            }
        }

        func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
            _ = inheritedStyle.popLast()
        }

        static func ellipse(cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat) -> [CGPoint] {
            (0...48).map { i in let t = CGFloat(i) / 48 * 2 * .pi; return CGPoint(x: cx + rx * cos(t), y: cy + ry * sin(t)) }
        }

        /// SVG elliptical arc (endpoint parameterisation) sampled into points, excluding the start point.
        static func arcPoints(from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, rotationDeg: CGFloat, largeArc: Bool, sweep: Bool) -> [CGPoint] {
            if p0 == p1 { return [] }
            var rx = abs(rxIn), ry = abs(ryIn)
            if rx == 0 || ry == 0 { return [p1] }
            let phi = rotationDeg * .pi / 180, cosPhi = cos(phi), sinPhi = sin(phi)
            let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
            let x1 = cosPhi * dx + sinPhi * dy, y1 = -sinPhi * dx + cosPhi * dy
            let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
            if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
            let sign: CGFloat = largeArc == sweep ? -1 : 1
            let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
            let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
            let coef = sign * sqrt(max(0, num / den))
            let cx1 = coef * (rx * y1 / ry), cy1 = coef * -(ry * x1 / rx)
            let cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2
            let cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2
            func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
                let dot = ux * vx + uy * vy, len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
                var a = acos(max(-1, min(1, dot / len)))
                if ux * vy - uy * vx < 0 { a = -a }
                return a
            }
            let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
            var dTheta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
            if !sweep && dTheta > 0 { dTheta -= 2 * .pi } else if sweep && dTheta < 0 { dTheta += 2 * .pi }
            let segments = max(4, Int(ceil(abs(dTheta) / (.pi / 12))))
            return (1...segments).map { i in
                let t = theta1 + dTheta * CGFloat(i) / CGFloat(segments)
                let ex = rx * cos(t), ey = ry * sin(t)
                return CGPoint(x: cosPhi * ex - sinPhi * ey + cx, y: sinPhi * ex + cosPhi * ey + cy)
            }
        }

        static func pointList(_ s: String) -> [CGPoint] {
            let n = s.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\n" }).compactMap { Double($0) }
            return stride(from: 0, to: n.count - 1, by: 2).map { CGPoint(x: n[$0], y: n[$0 + 1]) }
        }

        static func color(_ s: String?) -> UIColor? {
            guard var s = s?.trimmingCharacters(in: .whitespaces).lowercased(), s != "none", s != "currentcolor" else { return nil }
            let named: [String: UIColor] = ["black": .black, "red": .systemRed, "blue": .systemBlue, "green": .systemGreen, "orange": .systemOrange, "gray": .gray, "grey": .gray, "purple": .systemPurple, "white": .white]
            if let c = named[s] { return c }
            if s.hasPrefix("#") {
                s.removeFirst()
                if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
                guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
                return UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
            }
            if s.hasPrefix("rgb") {
                let n = s.drop { $0 != "(" }.dropFirst().split(whereSeparator: { $0 == "," || $0 == ")" || $0 == " " }).compactMap { Double($0) }
                if n.count >= 3 { return UIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: 1) }
            }
            return nil
        }

        // MARK: path data

        struct Subpath { var points: [CGPoint]; var sharp: Bool }

        static func pathSubpaths(_ d: String) -> [Subpath] {
            // Tokenise: commands are letters, numbers may be separated by spaces, commas, or sign changes.
            var tokens: [String] = []
            var cur = ""
            func flush() { if !cur.isEmpty { tokens.append(cur); cur = "" } }
            for ch in d {
                if ch.isLetter && ch != "e" && ch != "E" { flush(); tokens.append(String(ch)) }
                else if ch == " " || ch == "," || ch == "\n" || ch == "\t" { flush() }
                else if ch == "-" && !cur.isEmpty && !cur.hasSuffix("e") && !cur.hasSuffix("E") { flush(); cur = "-" }
                else if ch == "." && cur.contains(".") && !cur.contains("e") { flush(); cur = "." }
                else { cur.append(ch) }
            }
            flush()

            var out: [Subpath] = []
            var pts: [CGPoint] = []
            var sharp = true
            var p = CGPoint.zero, start = CGPoint.zero, lastCtrl: CGPoint? = nil
            var i = 0
            var cmd: Character = "M"
            func n() -> CGFloat { defer { i += 1 }; return i < tokens.count ? CGFloat(Double(tokens[i]) ?? 0) : 0 }
            func hasNum() -> Bool { i < tokens.count && Double(tokens[i]) != nil }
            func end() { if pts.count >= 2 { out.append(Subpath(points: pts, sharp: sharp)) }; pts = []; sharp = true }
            func cubic(_ c1: CGPoint, _ c2: CGPoint, _ to: CGPoint) {
                for k in 1...16 { let t = CGFloat(k) / 16, mt = 1 - t
                    pts.append(CGPoint(x: mt*mt*mt*p.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*to.x,
                                       y: mt*mt*mt*p.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*to.y)) }
                sharp = false; lastCtrl = c2; p = to
            }
            func quad(_ c: CGPoint, _ to: CGPoint) {
                for k in 1...12 { let t = CGFloat(k) / 12, mt = 1 - t
                    pts.append(CGPoint(x: mt*mt*p.x + 2*mt*t*c.x + t*t*to.x, y: mt*mt*p.y + 2*mt*t*c.y + t*t*to.y)) }
                sharp = false; lastCtrl = c; p = to
            }

            while i < tokens.count {
                if let c = tokens[i].first, tokens[i].count == 1, c.isLetter { cmd = c; i += 1 }
                let rel = cmd.isLowercase
                let base = rel ? p : .zero
                switch cmd.uppercased() {
                case "M":
                    end(); p = CGPoint(x: base.x + n(), y: base.y + n()); start = p; pts = [p]
                    cmd = rel ? "l" : "L"; lastCtrl = nil
                case "L": p = CGPoint(x: base.x + n(), y: base.y + n()); pts.append(p); lastCtrl = nil
                case "H": p.x = base.x + n(); pts.append(p); lastCtrl = nil
                case "V": p.y = base.y + n(); pts.append(p); lastCtrl = nil
                case "C": cubic(CGPoint(x: base.x + n(), y: base.y + n()), CGPoint(x: base.x + n(), y: base.y + n()), CGPoint(x: base.x + n(), y: base.y + n()))
                case "S":
                    let c1 = lastCtrl.map { CGPoint(x: 2 * p.x - $0.x, y: 2 * p.y - $0.y) } ?? p
                    cubic(c1, CGPoint(x: base.x + n(), y: base.y + n()), CGPoint(x: base.x + n(), y: base.y + n()))
                case "Q": quad(CGPoint(x: base.x + n(), y: base.y + n()), CGPoint(x: base.x + n(), y: base.y + n()))
                case "T":
                    let c = lastCtrl.map { CGPoint(x: 2 * p.x - $0.x, y: 2 * p.y - $0.y) } ?? p
                    quad(c, CGPoint(x: base.x + n(), y: base.y + n()))
                case "A":
                    let rx = n(), ry = n(), rot = n(), large = n() != 0, sweep = n() != 0
                    let to = CGPoint(x: base.x + n(), y: base.y + n())
                    pts.append(contentsOf: arcPoints(from: p, to: to, rx: rx, ry: ry, rotationDeg: rot, largeArc: large, sweep: sweep))
                    p = to; sharp = false; lastCtrl = nil
                case "Z": p = start; pts.append(p); end(); pts = [p]
                default: i += 1
                }
                if !hasNum(), i < tokens.count, tokens[i].count == 1, tokens[i].first!.isLetter { continue }
                if !hasNum(), i >= tokens.count { break }
            }
            end()
            return out
        }
    }
}

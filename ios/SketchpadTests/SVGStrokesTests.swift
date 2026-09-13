import XCTest
import PencilKit
@testable import Sketchpad

/// The SVG an agent draws back is parsed by hand, and every failure here is silent: a bad path
/// command produces no strokes, or strokes in the wrong place, with nothing in the log. These are
/// the cases that have bitten.
final class SVGStrokesTests: XCTestCase {
    let identity = SVGStrokeMapping(origin: .zero, pixelsPerPoint: 1, viewBox: nil, imageSize: .zero)

    private func strokes(_ svg: String, mapping: SVGStrokeMapping? = nil) -> [PKStroke] {
        SVGStrokes.strokes(from: svg, mapping: mapping ?? identity, defaultColor: .black)
    }
    private func bounds(_ svg: String) -> CGRect { PKDrawing(strokes: strokes(svg)).bounds }
    /// PKDrawing.bounds includes the pen width, so geometry is compared with a pen's worth of slack.
    private let pen: CGFloat = 5

    // MARK: shapes

    func testRectBecomesOneClosedStroke() {
        let s = strokes(#"<svg><rect x="10" y="20" width="100" height="50"/></svg>"#)
        XCTAssertEqual(s.count, 1)
        let b = bounds(#"<svg><rect x="10" y="20" width="100" height="50"/></svg>"#)
        XCTAssertEqual(b.minX, 10, accuracy: 3)
        XCTAssertEqual(b.minY, 20, accuracy: 3)
        XCTAssertEqual(b.width, 100, accuracy: pen)
        XCTAssertEqual(b.height, 50, accuracy: pen)
    }

    func testCircleIsRoundAndCentred() {
        let b = bounds(#"<svg><circle cx="50" cy="50" r="30"/></svg>"#)
        XCTAssertEqual(b.midX, 50, accuracy: 2)
        XCTAssertEqual(b.midY, 50, accuracy: 2)
        XCTAssertEqual(b.width, 60, accuracy: pen)
        XCTAssertEqual(b.height, 60, accuracy: pen)
    }

    func testPolylineAndPolygonDifferByTheClosingSegment() {
        let open = strokes(#"<svg><polyline points="0,0 40,0 40,40"/></svg>"#)
        let closed = strokes(#"<svg><polygon points="0,0 40,0 40,40"/></svg>"#)
        XCTAssertEqual(open.count, 1)
        XCTAssertEqual(closed.count, 1)
        XCTAssertGreaterThan(closed[0].path.count, open[0].path.count)
    }

    // MARK: path data

    func testRelativeAndAbsoluteCommandsAgree() {
        let abs = bounds(#"<svg><path d="M 10 10 L 60 10 L 60 60 Z"/></svg>"#)
        let rel = bounds(#"<svg><path d="m 10 10 l 50 0 l 0 50 z"/></svg>"#)
        XCTAssertEqual(abs.minX, rel.minX, accuracy: 1)
        XCTAssertEqual(abs.width, rel.width, accuracy: 1)
        XCTAssertEqual(abs.height, rel.height, accuracy: 1)
    }

    func testImplicitLineToAfterMoveTo() {
        // "M x y x2 y2" means moveto then lineto, a shape many generators emit.
        let b = bounds(#"<svg><path d="M 0 0 100 0"/></svg>"#)
        XCTAssertEqual(b.width, 100, accuracy: pen)
    }

    func testHorizontalAndVerticalShorthands() {
        let b = bounds(#"<svg><path d="M 10 10 H 110 V 60"/></svg>"#)
        XCTAssertEqual(b.width, 100, accuracy: pen)
        XCTAssertEqual(b.height, 50, accuracy: pen)
    }

    func testNumbersRunTogetherWithoutSeparators() {
        // "-" starts a new number; so does a second "." in one token.
        let b = bounds(#"<svg><path d="M0 0L50-20L100 0"/></svg>"#)
        XCTAssertEqual(b.width, 100, accuracy: pen)
        XCTAssertEqual(b.minY, -20, accuracy: pen)
    }

    func testCubicCurveIsSampledNotSkipped() {
        let s = strokes(#"<svg><path d="M 0 0 C 30 -40, 70 40, 100 0"/></svg>"#)
        XCTAssertEqual(s.count, 1)
        XCTAssertGreaterThan(s[0].path.count, 8, "a curve should be sampled into many points")
    }

    func testArcsBulgeOutwards() {
        // A rounded-button outline: a 100-wide run, a cap of radius 25 at each end, so the shape
        // spans 25...175. An arc that went the wrong way, or was flattened to a line, would not.
        let b = bounds(#"<svg><path d="M 50 0 h 100 a 25 25 0 0 1 0 50 h -100 a 25 25 0 0 1 0 -50 z"/></svg>"#)
        XCTAssertEqual(b.minX, 25, accuracy: pen)
        XCTAssertEqual(b.width, 150, accuracy: pen * 2)
        XCTAssertEqual(b.height, 50, accuracy: pen)
    }

    func testMultipleSubpathsBecomeSeparateStrokes() {
        XCTAssertEqual(strokes(#"<svg><path d="M 0 0 L 10 0 M 20 0 L 30 0"/></svg>"#).count, 2)
    }

    // MARK: colour and mapping

    func testStrokeColourIsTakenFromTheSvg() {
        let s = strokes(##"<svg><rect x="0" y="0" width="10" height="10" stroke="#2457b3"/></svg>"##)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        s[0].ink.color.getRed(&r, green: &g, blue: &b, alpha: &a)
        XCTAssertEqual(r, 0x24 / 255, accuracy: 0.02)
        XCTAssertEqual(g, 0x57 / 255, accuracy: 0.02)
        XCTAssertEqual(b, 0xb3 / 255, accuracy: 0.02)
    }

    func testViewBoxAndScaleMapIntoCanvasPoints() {
        // The agent draws in the pixel space of a 600x400 image that covered canvas (100,50) at 2x.
        let mapping = SVGStrokeMapping(origin: CGPoint(x: 100, y: 50), pixelsPerPoint: 2, viewBox: nil,
                                       imageSize: CGSize(width: 600, height: 400))
        let b = PKDrawing(strokes: strokes(#"<svg viewBox="0 0 600 400"><rect x="0" y="0" width="600" height="400"/></svg>"#, mapping: mapping)).bounds
        XCTAssertEqual(b.minX, 100, accuracy: 4)
        XCTAssertEqual(b.minY, 50, accuracy: 4)
        XCTAssertEqual(b.width, 300, accuracy: pen)
        XCTAssertEqual(b.height, 200, accuracy: pen)
    }

    func testEachStrokeGetsItsOwnCreationDate() {
        // Provenance depends on this: removing an agent's strokes matches them by creation date.
        let s = strokes(#"<svg><path d="M 0 0 L 10 0 M 20 0 L 30 0 M 40 0 L 50 0"/></svg>"#)
        let dates = Set(s.map { $0.path.creationDate })
        XCTAssertEqual(dates.count, s.count)
    }

    // MARK: things that should produce nothing rather than crash

    func testTextAndFillsAreIgnored() {
        XCTAssertTrue(strokes(#"<svg><text x="0" y="0">hello</text></svg>"#).isEmpty)
    }

    func testMalformedInputIsEmpty() {
        XCTAssertTrue(strokes("not svg at all").isEmpty)
        XCTAssertTrue(strokes(#"<svg><path d=""/></svg>"#).isEmpty)
        XCTAssertTrue(strokes(#"<svg><path d="M 10 10"/></svg>"#).isEmpty, "a single point is not a stroke")
    }
}

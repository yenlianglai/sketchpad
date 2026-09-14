import XCTest
@testable import Sketchpad

/// How far the page reaches.
///
/// It starts at a fixed size and grows down and to the right as the drawing approaches the edge.
/// Only those two directions: a scroll view has no negative coordinates, so growing up or left
/// would mean translating every stroke and layer — and every saved turn recorded its coordinates
/// against the page as it was.
final class CanvasGrowthTests: XCTestCase {

    /// The rule the coordinator applies, kept here so the arithmetic is checked without a live view.
    private func grown(from current: CGSize, content: CGRect, headroom: CGFloat = 2000) -> CGSize {
        CGSize(width: max(current.width, content.maxX + headroom),
               height: max(current.height, content.maxY + headroom))
    }

    func testDoesNotShrinkForASmallDrawing() {
        let start = CGSize(width: 4000, height: 6000)
        let grew = grown(from: start, content: CGRect(x: 100, y: 100, width: 300, height: 200))
        XCTAssertEqual(grew, start, "a page must never get smaller under what is already on it")
    }

    func testGrowsDownwardWhenWritingReachesTheBottom() {
        let start = CGSize(width: 4000, height: 6000)
        let grew = grown(from: start, content: CGRect(x: 0, y: 0, width: 500, height: 5500))
        XCTAssertEqual(grew.height, 7500)
        XCTAssertEqual(grew.width, 4000, "writing downwards should not widen the page")
    }

    func testGrowsRightwardToo() {
        let grew = grown(from: CGSize(width: 4000, height: 6000),
                         content: CGRect(x: 0, y: 0, width: 3500, height: 100))
        XCTAssertEqual(grew.width, 5500)
    }

    func testKeepsHeadroomAheadOfThePen() {
        // The edge must never be somewhere you can reach in the middle of a sentence.
        let content = CGRect(x: 0, y: 0, width: 100, height: 5900)
        let grew = grown(from: CGSize(width: 4000, height: 6000), content: content)
        XCTAssertGreaterThanOrEqual(grew.height - content.maxY, 2000)
    }

    func testNeverGrowsUpOrLeft() {
        // Content at negative coordinates cannot happen today, but if it ever did, the page must not
        // try to follow it — that is the expensive direction and it would move everything else.
        let start = CGSize(width: 4000, height: 6000)
        XCTAssertEqual(grown(from: start, content: CGRect(x: -500, y: -500, width: 100, height: 100)), start)
    }

    func testAGrownPageStaysGrown() {
        // Reopening a saved page must not put its lower half out of reach.
        let saved = CGRect(x: 0, y: 0, width: 200, height: 9000)
        let reopened = grown(from: CGSize(width: 4000, height: 6000), content: saved)
        XCTAssertEqual(reopened.height, 11000)
    }
}

import XCTest
@testable import Sketchpad

/// What a QR code has to survive being turned into. A wrong answer here sends every page to the
/// wrong machine, or to nowhere.
final class PairingTests: XCTestCase {
    func testPairingURL() {
        let r = QRScannerSheet.parse("sketchpad://pair?host=192.168.0.9:8791")
        XCTAssertEqual(r?.0, "192.168.0.9:8791")
        XCTAssertNil(r?.1)
    }

    func testPairingURLWithToken() {
        let r = QRScannerSheet.parse("sketchpad://pair?host=mac.local:8791&token=s3cret")
        XCTAssertEqual(r?.0, "mac.local:8791")
        XCTAssertEqual(r?.1, "s3cret")
    }

    func testHttpURL() {
        XCTAssertEqual(QRScannerSheet.parse("http://192.168.0.9:8791/")?.0, "192.168.0.9:8791")
        XCTAssertEqual(QRScannerSheet.parse("http://mac.local")?.0, "mac.local")
    }

    func testBareHostAndPort() {
        XCTAssertEqual(QRScannerSheet.parse("192.168.0.9:8791")?.0, "192.168.0.9:8791")
        XCTAssertEqual(QRScannerSheet.parse("  192.168.0.9:8791\n")?.0, "192.168.0.9:8791")
    }

    func testRejectsAnythingElse() {
        // Scanning a wifi QR, a URL to a website, or a phone number must not silently repoint the app.
        XCTAssertNil(QRScannerSheet.parse("WIFI:S:home;T:WPA;P:pw;;"))
        XCTAssertNil(QRScannerSheet.parse("hello"))
        XCTAssertNil(QRScannerSheet.parse("192.168.0.9:notaport"))
        XCTAssertNil(QRScannerSheet.parse("sketchpad://pair"))
        XCTAssertNil(QRScannerSheet.parse(""))
    }
}

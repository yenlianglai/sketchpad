import XCTest
@testable import Sketchpad

/// Pairing is eight characters someone reads off a screen and types in here. What protects it is
/// that the proof sent to the Mac is derived from the code *and the certificate this iPad was
/// shown* — so if these numbers stop matching the server's, either nothing pairs at all, or
/// something pairs that should not have. Both are silent until someone is standing in the middle.
final class PairingTests: XCTestCase {

    // MARK: what people type

    func testDashIsCosmetic() {
        XCTAssertEqual(PairingProof.normalize("V4XY-PE72"), "V4XYPE72")
        XCTAssertEqual(PairingProof.normalize("v4xy pe72"), "V4XYPE72")
        XCTAssertEqual(PairingProof.normalize("V4XYPE72"), "V4XYPE72")
    }

    func testTypingRegroupsAsYouGo() {
        XCTAssertEqual(PairingProof.grouped("v4x"), "V4X")
        XCTAssertEqual(PairingProof.grouped("v4xy"), "V4XY")
        XCTAssertEqual(PairingProof.grouped("v4xyp"), "V4XY-P")
        XCTAssertEqual(PairingProof.grouped("v4xype72"), "V4XY-PE72")
    }

    func testStopsAtEightCharacters() {
        XCTAssertEqual(PairingProof.grouped("V4XYPE72EXTRA"), "V4XY-PE72")
    }

    // MARK: the proof

    /// Worked out with the server's own code, so a change on either side shows up here:
    ///   pbkdf2Sync("V4XYPE72", "sketchpad-pairing-v1:abc123", 200000, 32, "sha256").toString("base64url")
    func testProofMatchesTheServer() {
        XCTAssertEqual(
            PairingProof.proof(code: "V4XY-PE72", fingerprint: "abc123"),
            "gLaIwfUpXzJRnbWjC5z996e9Xdi4l9IeyGbaOQqFEs4"
        )
    }

    func testProofIsBoundToTheCertificate() {
        // The whole point: the same code against a different certificate is a different proof, which
        // is what a Mac uses to tell itself apart from someone impersonating it.
        let real = PairingProof.proof(code: "V4XYPE72", fingerprint: "the-real-certificate")
        let middle = PairingProof.proof(code: "V4XYPE72", fingerprint: "someone-elses-certificate")
        XCTAssertNotNil(real)
        XCTAssertNotEqual(real, middle)
    }

    func testProofDoesNotContainTheCode() {
        let proof = PairingProof.proof(code: "V4XYPE72", fingerprint: "abc123") ?? ""
        XCTAssertFalse(proof.contains("V4XYPE72"))
        XCTAssertFalse(proof.lowercased().contains("v4xype72"))
    }

    func testDerivationIsSlowEnoughToResistAnOfflineSearch() {
        // Eight characters is forty bits. Without a deliberately slow derivation, a proof captured
        // in the middle would give the code up in seconds.
        XCTAssertGreaterThanOrEqual(PairingProof.iterations, 100_000)
    }
}

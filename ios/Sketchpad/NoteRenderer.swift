import UIKit

/// Turning an agent's words into something that can sit on the page.
///
/// The text is laid out here rather than on the computer, because this is where the page is: the
/// width that reads well depends on how far you are zoomed out and how much room is left beside what
/// you have already drawn. The words are kept alongside the image, so a note can be re-drawn at a
/// different size later without asking the agent again.
enum NoteRenderer {
    /// Rendered at twice the layout size so it stays sharp when you zoom in on it.
    private static let scale: CGFloat = 2
    private static let padding: CGFloat = 22
    private static let corner: CGFloat = 14

    /// A page of prose is not a note. Past this it is better placed in the panel, where it scrolls.
    static let maxCharacters = 1200

    /// `width` is the layout width in canvas points; the image comes back at twice that in pixels.
    static func image(for text: String, width: CGFloat, font: UIFont = .systemFont(ofSize: 17)) -> UIImage? {
        let words = String(text.prefix(maxCharacters)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return nil }

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        paragraph.lineBreakMode = .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(white: 0.12, alpha: 1),
            .paragraphStyle: paragraph
        ]

        let textWidth = width - padding * 2
        let bounds = (words as NSString).boundingRect(
            with: CGSize(width: textWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes, context: nil
        )
        let size = CGSize(width: width, height: ceil(bounds.height) + padding * 2)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = scale
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            // A card rather than bare text, so it reads as something placed on the page rather than
            // as writing that is somehow already part of it.
            let card = CGRect(origin: .zero, size: size)
            UIColor(white: 1, alpha: 0.96).setFill()
            UIBezierPath(roundedRect: card, cornerRadius: corner).fill()
            UIColor(white: 0.72, alpha: 1).setStroke()
            let border = UIBezierPath(roundedRect: card.insetBy(dx: 0.75, dy: 0.75), cornerRadius: corner)
            border.lineWidth = 1.5
            border.stroke()

            // A stripe in the agent's colour, the same signal the reply cards use.
            Settings.agentColor.setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: 4, height: size.height),
                         byRoundingCorners: [.topLeft, .bottomLeft],
                         cornerRadii: CGSize(width: corner, height: corner)).fill()
            _ = ctx

            (words as NSString).draw(
                with: CGRect(x: padding, y: padding, width: textWidth, height: ceil(bounds.height)),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: attributes, context: nil
            )
        }
    }
}

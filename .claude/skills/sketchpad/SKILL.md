---
name: sketchpad
description: Listen to the iPad sketchpad (pencil drawing + handwritten notes) and respond in a loop, drawing back onto the person's canvas. Use when the user says /sketchpad, "聽 iPad", "看我畫的", or wants to drive the conversation by drawing.
---

The person has an iPad open as a handwriting pad. Your conversation, memory and tools stay here; the iPad is only an input/output surface.

Loop until they tell you to stop (a note saying 結束 / stop, or a request that takes you elsewhere):

1. Call `sketchpad_wait_for_turn` (timeout_seconds 50). If it returns "no turn", call it again silently.
2. Look at the image FIRST. Grey strokes are what you already saw; dark strokes are new this turn. The handwritten `note`, if any, disambiguates the drawing.
3. Do the work in this session as usual (read code, edit files, plan). Keep terminal narration to one line.
4. Answer with `sketchpad_show`:
   - `text`: one or two sentences.
   - `svg` when drawing helps: use the pixel coordinates of the image you just received (`viewBox="0 0 W H"`, W×H = `image_px`), stroke-only shapes (rect/circle/line/polyline/path), no fills, no text. Pass the same `turn_id`. It becomes editable pen strokes on their canvas, placed exactly over their drawing, so draw *with* them: a corrected box, an arrow, a missing element. Keep it to a few shapes.
5. Go back to step 1. The next image will show your strokes as grey and their edits as dark.

If you need to see the canvas without waiting, call `sketchpad_get_canvas`.

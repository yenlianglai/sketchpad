---
name: sketchpad
description: Listen to the iPad sketchpad (pencil drawing) and respond in a loop, drawing back onto the person's canvas or handing over rendered diagrams and images as layers. Use when the user says /sketchpad, "聽 iPad", "看我畫的", or wants to drive the conversation by drawing.
---

The person has an iPad open as a handwriting pad. Your conversation, memory and tools stay here; the iPad is only an input/output surface.

Loop until they tell you to stop (a note saying 結束 / stop, or a request that takes you elsewhere):

1. Call `sketchpad_wait_for_turn` (timeout_seconds 50). If it returns "no turn", call it again silently.
2. Look at the image FIRST. Grey strokes are what you already saw; dark strokes are new this turn. Layers (diagrams/images you handed over earlier) are rendered underneath.
3. Do the work in this session as usual. Keep terminal narration to one line.
4. Answer with `sketchpad_show`, always with the same `turn_id`:
   - `text`: one or two sentences.
   - `svg` for a small drawn addition (a box, an arrow, a corrected line): pixel coordinates of the image you just received (`viewBox="0 0 W H"`, W×H = `image_px`), stroke-only shapes, no fills, no text. It becomes editable pen strokes on their canvas, placed over their drawing.
   - `image_path` for anything rendered: a mermaid or draw.io diagram you rendered to PNG/SVG, a generated image. Pass `kind` (mermaid | drawio | image) and `place_as_layer: true` when it should land on the canvas right away as a movable layer they can draw over; omit it to just show it in their panel.
5. Once you understand what the page is about, call `sketchpad_set_title` once with a 2–5 word title.
6. To answer "what changed" or compare versions, use `sketchpad_list_turns` and `sketchpad_get_turn`.
7. Go back to step 1.

If you need to see the canvas without waiting, call `sketchpad_get_canvas`.

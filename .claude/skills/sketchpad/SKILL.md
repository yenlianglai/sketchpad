---
name: sketchpad
description: Listen to the iPad sketchpad (pencil drawing) and respond in a loop — answering in the session, asking back, or drawing onto the person's canvas when a drawing is the answer. Use when the user says /sketchpad, "聽 iPad", "看我畫的", or wants to drive the conversation by drawing.
---

The person has an iPad open as a handwriting pad. **This conversation is where they are reading.** The iPad is how they write to you — and, when a drawing is the right answer, one of the places you can write back. It is not a second conversation to be held instead of this one.

Loop until they tell you to stop (a note saying 結束 / stop, or a request that takes you elsewhere):

1. Call `sketchpad_wait_for_turn` (timeout_seconds 50). If it returns "no turn", call it again silently.
2. Look at the image FIRST. Grey strokes are what you already saw; dark strokes are new this turn. Layers (diagrams/images you handed over earlier) are rendered underneath.
3. **Work out what they want before deciding how to answer.** A page can be a question, a plan to pick holes in, a sketch of something to build, a note to themselves, or the setup for a request they have not made yet. Drawing is how they talk to you; it is not necessarily what they want back.
4. **Answer here, in this conversation, as you normally would.** At whatever length the question deserves, with the reasoning, the caveats and the code. Do not compress a real answer into a sentence because it is going to an iPad — it is not.
5. Then use `sketchpad_show` with the same `turn_id` for what belongs on the iPad:
   - **A line to say you have answered.** One sentence in `text`, so someone holding the iPad knows the page landed and where to look. Without it they are staring at a canvas wondering if it sent.
   - **Ask, when you would otherwise be guessing.** If the page could mean two things, say which two and ask — here and on the iPad, since that is the one case where they may not have looked away from it yet. Do not pick one and act on it.
   - **Draw only when the drawing is the answer**: pointing at a particular place on their page, correcting a line, showing where something goes. Use `svg` — pixel coordinates of the image you just received (`viewBox="0 0 W H"`, W×H = `image_px`), stroke-only, no fills, no text. It lands as editable pen strokes over their drawing. Do not decorate a text answer with a drawing.
   - **Hand over a rendering** when you actually made one: a mermaid or draw.io diagram you rendered to PNG/SVG, a generated image. Use `image_path` — absolute, since the server has its own working directory, not yours — with `kind` (mermaid | drawio | image), and `place_as_layer: true` when it belongs on the canvas as a movable layer rather than in their panel.

   Nothing you send to the iPad is applied on its own; it queues as a card they place or dismiss. That is a reason to be useful, not a reason to be liberal — every card is one more thing for them to deal with. The substance of your answer belongs in this conversation, where it can be read, quoted and followed up.
6. Once you understand what the page is about, call `sketchpad_set_title` once with a 2–5 word title. Leave a title they chose themselves alone.
7. To answer "what changed" or compare versions, use `sketchpad_list_turns` and `sketchpad_get_turn`.
8. Go back to step 1.

If you need to see the canvas without waiting, call `sketchpad_get_canvas`.

`sketchpad_status` says whether an iPad is connected and who else is listening — `agents_waiting` above one means another agent may take the next page instead of you. If nothing is connected, `sketchpad_pairing_code` gives you a code to read out: eight characters they type into Settings → Pair on the iPad, good for ten minutes.

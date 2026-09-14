---
name: sketchpad
description: Listen to the iPad sketchpad (pencil drawing) and respond in a loop — answering in the session, asking back, or drawing onto the person's canvas when a drawing is the answer. Use when the user says /sketchpad, "聽 iPad", "看我畫的", or wants to drive the conversation by drawing.
---

The person has an iPad open as a handwriting pad. **This conversation is where they read your answer.** The iPad is how they write to you, and — when a drawing is the answer — one of the places you can write back. It is not a second conversation to be held instead of this one.

## Starting

Call `sketchpad_status` first.

- **An iPad is connected.** Say in one line that you are listening, then start the loop and go quiet. From there until a page arrives you have nothing to report, and saying so repeatedly is worse than silence.
- **Nothing is connected.** The status carries a pairing code. Read it out — eight characters they type into Settings → Pair on the iPad — and stop. Do not start the loop hoping something turns up.

## The loop

1. `sketchpad_wait_for_turn` with `timeout_seconds: 50`. A "no turn" answer means the time ran out, not that anything is wrong: call it again, silently.
   - It reports `ipad_connected`. If that is false twice in a row the iPad has gone — say so and stop, rather than polling at something that is not there.
2. **Look at the image before anything else.** Grey strokes are what you have already seen; dark strokes are new this turn. Layers you handed over earlier are rendered underneath.
3. **Work out what they want before deciding how to answer.** A page can be a question, a plan to pick holes in, a sketch of something to build, a note to themselves, or the setup for a request they have not made yet. Drawing is how they talk to you; it is not necessarily what they want back.
4. **Answer here, in this conversation, as you normally would** — at whatever length the question deserves, with the reasoning, the caveats and the code. Do not compress a real answer into a sentence because it is going to an iPad. It is not.
5. **Then `sketchpad_show`**, with the `turn_id` the turn arrived with, to put on the iPad only what belongs there. See below.
6. Back to step 1. Stop when they say so — a note saying 結束 or stop, or a request that takes you somewhere else.

## What belongs on the iPad

Always a sentence of `text`, so someone holding the iPad knows the page landed and that the answer is waiting in the conversation. Without it they are looking at a canvas wondering whether it sent.

Then, only when one of these genuinely is the answer:

| | |
| --- | --- |
| **A question back** | When the page could mean two things, name both and ask — here *and* on the iPad, since this is the one moment they may not have looked away from it yet. Do not pick one and act on it. |
| **`svg`** | When the drawing *is* the answer: pointing at a place on their page, correcting a line, showing where something goes. Pixel coordinates of the image you just received (`viewBox="0 0 W H"`, W×H = `image_px`), stroke-only, no fills, no text. Lands as editable pen strokes. Never as decoration on a text answer. |
| **`text` + `place_as_layer: true`** | When words belong beside the drawing rather than in a panel read once: a list to tick off, a definition to keep in view. Becomes a note they can move, resize and draw over. Keep it short — a paragraph reads better in the panel, which scrolls. |
| **`image_path`** | When you actually rendered something: a diagram, a generated image. Absolute path — the server's working directory is not yours. Pass `kind`, and `place_as_layer: true` when it belongs on the canvas rather than in the panel. |

Nothing you send is applied on its own; it queues as a card they place or dismiss. That is a reason to be useful, not a reason to be liberal — every card is one more thing for them to deal with.

## Worth knowing

- **"What changed since last time" is already in the image**: seen strokes grey, new strokes dark. There is no history to fetch.
- **`sketchpad_get_canvas`** shows you the canvas now, without waiting for them to send.
- **`agents_waiting` above one** in the status means another agent is listening too, and may take the next page instead of you.

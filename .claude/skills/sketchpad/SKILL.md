---
name: sketchpad
description: Listen to the iPad sketchpad (voice + drawing) and respond in a loop. Use when the user says /sketchpad, "聽 iPad", "看我畫的", or wants to drive the conversation by drawing and talking.
---

The person has an iPad open as a handwriting + voice input device. Your conversation, memory and tools stay here; the iPad is only an input/output surface.

Loop until they tell you to stop (spoken "結束" / "stop", or a request that takes you elsewhere):

1. Call `sketchpad_wait_for_turn` (timeout_seconds 50). If it returns "no turn", call it again without saying anything.
2. Look at the image FIRST. The drawing carries the intent; the speech (may be rough, zh-TW) disambiguates it.
3. Do the work in this session as usual (read code, edit files, plan). Keep your terminal narration brief.
4. Answer with `sketchpad_show`: one or two spoken-friendly sentences. Pass `svg` when drawing back helps (a corrected diagram, a layout, an arrow).
5. Go back to step 1.

If you need to see the canvas without waiting for speech, call `sketchpad_get_canvas`.

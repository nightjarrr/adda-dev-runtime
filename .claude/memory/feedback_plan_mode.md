---
name: Do not invoke update-config when entering plan mode
description: Entering plan mode (EnterPlanMode tool) does not require the update-config skill — do not invoke it
type: feedback
originSessionId: 8018a590-8ea2-4cbf-84a1-26ef2910b208
---
Do not invoke the `update-config` skill when trying to enter plan mode as part of proto-SDLC step 3.

**Why:** Happened at least twice — the skill was invoked by mistake before entering plan mode, causing an unnecessary permission prompt for the user. The `update-config` skill is for modifying `settings.json`; entering plan mode uses the `EnterPlanMode` tool directly.

**How to apply:** When step 3 of proto-SDLC says "enter plan mode", call the `EnterPlanMode` tool directly. Do not invoke any skill first.
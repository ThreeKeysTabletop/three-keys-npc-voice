# Changelog

## 1.0.0 — 2026-10-30
- First release for Foundry VTT v13–v14 (verified 14.369), system agnostic (tested with dnd5e 5.3.3).
- Live voice changer on the GM's outgoing mic in Foundry's built-in A/V (getUserMedia patch; LiveKit AVClient best effort). Not for Discord.
- Gain staging: level-matched stages (unity-gain soft saturator, EQ boost trim, √2 ring-mod match, unit-energy reverb, equal-power dry/reverb/echo mix with feedback compensation) and a final safety stage (gentle compressor, limiter, -1 dBFS ceiling).
- Expanded DSP: phase-vocoder pitch with independent formant shift (cepstral envelope, 16 ms), up to 3 parallel voice layers, 16-band vocoder (saw/noise/chord), growl/throat rattle (amplitude modulation), bitcrush/sample-rate reduction, envelope-driven breath/air, chorus, flanger, phaser, LFO comb, tremolo, vibrato, low/high shelves, notch, bright/dark reverb tone. The editor is grouped into sections, edits layers and shows latency; `api.latencyMs()`.
- Redesigned built-ins (Natural, Orc, Robot / Construct, Radio / Sending) so each has a distinct signature.
- Effects: gain, EQ with Telephone/Radio/Cave styles, formant tilt, low-latency AudioWorklet pitch shift, distortion/growl, ring-mod robot, convolution reverb, echo and mix.
- Built-in presets: Natural, Orc, Robot / Construct, Radio / Sending.
- Per-actor voices (actor and prototype token flags) and per-token overrides, set from the actor sheet header or the Token HUD. Auto-switch on token control and chat speaker, and release to Natural.
- Quick preset bar with configurable hotkeys (Alt+1…0, Alt+B bypass, Alt+V bar), live meter, self-monitor with a latency warning, and a test-mic button.
- Browser echo cancellation, noise suppression and AGC are turned off while effects are active (setting).
- GM only by default, with a setting to allow players.
- Preset editor with live preview, custom presets in world settings, and JSON export/import.
- Preset packs: import from the editor or `api.importPack()`, grouped by pack with author and version.

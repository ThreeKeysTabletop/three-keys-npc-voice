# Three Keys NPC Voice

*By Three Keys Tabletop · Foundry VTT v13–v14 · system agnostic · MIT · free*

A live voice changer for GMs, built into Foundry's own audio/video chat. Give every NPC a voice (orc growl, robot, sending-stone radio, or anything you build in the editor), and NPC Voice switches to it as soon as you select that token. Your players hear the changed voice through Foundry A/V, so you don't need Voicemod.

> **Works with:** Foundry's **built-in A/V (WebRTC / SimplePeer)**, and the **LiveKit AVClient** module on a best-effort basis.
> **Does NOT work with:** Discord, Zoom, TeamSpeak or any voice app outside Foundry. NPC Voice only changes the microphone stream that Foundry itself opens.

## Install
Manifest URL: `https://github.com/ThreeKeysTabletop/three-keys-npc-voice/releases/latest/download/module.json`

Turn on Foundry A/V (Configure Settings > Core > Configure Audio/Video), enable the module, then reload.

## How it works
When Foundry asks the browser for your microphone (`navigator.mediaDevices.getUserMedia`), NPC Voice sends the mic through a Web Audio effect chain and gives Foundry the processed track. Video passes through unchanged. Changing a voice only changes effect parameters, so peers never renegotiate and there are no dropouts. LiveKit's client gets the mic the same way, which is why it usually works too. If the chain can't be built, the module falls back to your plain microphone.

Chain: input gain → EQ (high/low-pass, presence, tilt, low/high shelves, notch, or Telephone / Radio / Cave styles) → **voice layers**: the main voice plus up to 3 parallel layers (octave-down double, sub, choir…), each with its own **pitch and formant** from a phase-vocoder AudioWorklet that keeps the spectral envelope (cepstral), so formants move independently of pitch → vibrato → FX worklet (**vocoder** with saw/noise/chord carrier, **growl/throat rattle** by irregular sub-audio amplitude modulation rather than distortion, **bitcrush / sample-rate reduction**, envelope-driven **breath/air** layer) → soft drive → ring-mod → **chorus, flanger, phaser** → **comb** (LFO-swept for wet gurgles) → **tremolo** → reverb (bright/dark tone) + echo → safety stage (gentle compressor, limiter, -1 dBFS ceiling). Every stage is level-matched, so stacking effects never makes the voice louder.

## Using it
- **Quick bar** (top center): built-in and custom voices, a dropdown with pack voices, **Bypass**, **Self-monitor** (headphones), **Test mic** (opens the mic without A/V so you can audition voices), the editor, and a live output meter.
- **Hotkeys** (Configure Controls > Three Keys NPC Voice): Alt+1 … Alt+0 pick quick-bar slots 1–10, Alt+B toggles bypass, Alt+V shows or hides the bar. You can change all of them.
- **Assign a voice:** use the **NPC Voice** button in an actor sheet's header menu, which saves to the actor and its prototype token, or the mask button on the **Token HUD**, which saves to that token only and overrides the actor's voice.
- **Auto-switch:** controlling a token switches to its voice. When nothing is controlled, or the token has no voice, it goes back to Natural (you can turn this off). Posting a chat message as an actor or token also switches to its voice.
- **Preset editor** (GM): live preview on your outgoing mic, Save / Save as new (custom presets are stored in world settings), Export / Import JSON, and preset **packs**.

Built-in presets: **Natural, Orc, Robot / Construct, Radio / Sending.**

## Preset packs
A pack is a JSON file:
```json
{ "type": "three-keys-npc-voice-pack", "id": "dragon-pack", "name": "Dragon Pack", "author": "Three Keys Tabletop",
  "version": "1.0.0", "description": "…", "presets": [ { "id": "red", "name": "Red Dragon", "params": { "pitch": -6, "drive": 0.6 } } ] }
```
To install one, open the editor and click Import JSON / pack, or run `game.modules.get("three-keys-npc-voice").api.importPack(json)`. Packs are grouped by name with their author and version, and you can remove one from the editor. Any missing parameters use the defaults, and values outside the allowed range are clamped.

Parameters (all optional): `gain, pitch ±24 st, formant ±12 st, tilt, filter none|telephone|radio|cave, hp, lp, peakFreq, peakGain, lowShelf, highShelf, notchFreq, notchQ, drive, growl, growlRate, ringFreq, ringMix, vocoder, carrier saw|noise|chord, carrierFreq, crushBits, crushRate, crushMix, breath, breathTone, chorus, flanger, flangerRate, phaser, phaserRate, tremolo, tremoloRate, vibrato, vibratoRate, comb, combTime, combFeedback, combLfo, reverb, reverbSize, reverbTone, delay, delayTime, feedback, mix, layers: [{pitch, formant, gain, hp, lp}] (max 3)`. Ranges are listed in `scripts/dsp.mjs`.

## Latency notes
- Voices that change pitch or formant use the phase vocoder: FFT 1024, hop 256, which adds **16 ms** of algorithmic latency at 48 kHz, plus about 3 ms of Web Audio block processing. Vibrato adds 6 ms. All other effects add nothing. The editor shows the added latency for the voice you are editing, and `api.latencyMs(id)` returns it. For the shipped presets: Natural, Robot, Radio and Spectral Whisper add about 3 ms; most other voices about 19 ms; voices with vibrato about 25 ms. All of this is on top of normal WebRTC latency (often 100–300 ms).
- **Self-monitor** plays the processed voice back to you. Use headphones, because speakers cause feedback. Hearing yourself slightly late can be distracting, so keep it for checking a voice.
- With effects on, the browser's echo cancellation, noise suppression and auto gain are switched off by default, because they smear pitch and reverb. They come back on for Natural or Bypass. If players hear an echo, wear headphones or turn off that setting.
- CPU: each active pitch/formant layer is one FFT worklet; a 4-layer voice runs fine on a modern laptop, but older machines may prefer voices with fewer layers.

## Settings
Enable (per client), Allow players (off by default, so only the GM can use it), Show quick bar, Switch on token control, Switch on chat speaker, Release to Natural, Disable browser voice processing, Notify on voice switch.

## API
`game.modules.get("three-keys-npc-voice").api`: `setPreset(id)`, `getPreset()`, `setBypass(b)`, `setMonitor(b)`, `presets()`, `setActorPreset(actor, id)`, `setTokenPreset(tokenDoc, id)`, `openEditor()`, `exportPresets()`, `importPresets(json)`, `importPack(json)`, `removePack(id)`, `startPreview()` / `stopPreview()`. A `three-keys-npc-voice.presetChanged` hook fires whenever the voice changes.

## License
MIT © Three Keys Tabletop

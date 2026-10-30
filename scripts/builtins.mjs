/* Built-in presets (generated from npc-voice-packs/design/design.py). MIT. */
export const BUILTIN = [
 {
  "id": "natural",
  "nameKey": "Preset.natural",
  "params": {}
 },
 {
  "id": "orc",
  "nameKey": "Preset.orc",
  "params": {
   "pitch": -4,
   "formant": -2,
   "peakFreq": 1500,
   "peakGain": 4,
   "growl": 0.3,
   "growlRate": 32,
   "drive": 0.1,
   "reverb": 0.08,
   "reverbSize": 0.8
  }
 },
 {
  "id": "robot",
  "nameKey": "Preset.robot",
  "params": {
   "hp": 120,
   "vocoder": 1,
   "carrier": "chord",
   "carrierFreq": 110,
   "crushBits": 8,
   "crushRate": 3,
   "crushMix": 0.25,
   "ringFreq": 60,
   "ringMix": 0.3,
   "comb": 0.3,
   "combTime": 3,
   "combFeedback": 0.5
  }
 },
 {
  "id": "radio",
  "nameKey": "Preset.radio",
  "params": {
   "filter": "radio",
   "crushBits": 10,
   "crushRate": 2,
   "crushMix": 0.3,
   "breath": 0.15,
   "breathTone": 5000
  }
 }
];

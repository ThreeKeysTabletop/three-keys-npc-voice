// Print algorithmic latency per preset (built-ins + packs) as a Markdown table.  node tools/latency.mjs <pack json>...
import { readFileSync } from 'node:fs';
import { latencyMs, effective } from '../scripts/dsp.mjs';
import { BUILTIN } from '../scripts/builtins.mjs';
const rows = [['Built-in', BUILTIN.map(p => ({ name: p.id, params: p.params }))], ...process.argv.slice(2).map(f => { const j = JSON.parse(readFileSync(f, 'utf8')); return [j.name, j.presets]; })];
console.log('| Pack | Voice | Added latency (ms) | Why |\n|---|---|---|---|');
for (const [pk, ps] of rows) for (const p of ps) { const e = effective(p.params); const why = [];
  if (e.pitch || e.formant || e.layers.some(l => l.gain > 0 && (l.pitch || l.formant))) why.push('phase-vocoder pitch/formant 16 ms');
  if (e.vibrato > 0) why.push('vibrato delay 6 ms'); why.push('render quantum 2.7 ms');
  console.log(`| ${pk} | ${p.name} | ${latencyMs(p.params)} | ${why.join(' + ')} |`); }

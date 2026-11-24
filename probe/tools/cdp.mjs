// Evaluate an expression in the probe app through the TV's remote inspector.
// Usage: node cdp.mjs <localPort> "<expression>" [outFile]
// The port comes from `sdb forward tcp:<localPort> tcp:<debugPort>`.
import { writeFileSync } from 'node:fs';

const [port, expr, outFile] = process.argv.slice(2);
if (!port || !expr) {
  console.error('usage: node cdp.mjs <port> "<expression>" [outFile]');
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((t) => t.webSocketDebuggerUrl) ?? targets[0];
if (!target?.webSocketDebuggerUrl) {
  console.error('no debuggable page:', JSON.stringify(targets));
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 20000);
ws.onopen = () => ws.send(JSON.stringify({
  id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true },
}));
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id !== 1) return;
  clearTimeout(timer);
  const r = msg.result?.result;
  const text = r?.type === 'string' ? r.value : JSON.stringify(r?.value ?? msg, null, 2);
  if (outFile) { writeFileSync(outFile, text); console.log(`saved ${outFile} (${text.length} bytes)`); }
  else console.log(text);
  ws.close();
};
ws.onerror = (e) => { console.error('ws error', e.message ?? e); process.exit(1); };

#!/usr/bin/env node
/**
 * Quick CLI tool to send avatar commands to VESSEL over WebSocket.
 *
 * Examples:
 *   node scripts/send.mjs gesture wave
 *   node scripts/send.mjs gesture nod
 *   node scripts/send.mjs emotion happy 1.0
 *   node scripts/send.mjs emotion relaxed 0.8
 *   node scripts/send.mjs state thinking
 *   node scripts/send.mjs gaze 0.3 0.2
 *   node scripts/send.mjs '{"type": "gesture", "name": "shrug"}'
 */

import { WebSocket } from "ws";

const WS_URL = process.env.VESSEL_WS_URL || "ws://127.0.0.1:8765/ws/avatar";
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
VESSEL CLI Command Sender:
  node scripts/send.mjs gesture <nod|shake_head|tilt_head|wave|shrug>
  node scripts/send.mjs emotion <neutral|happy|angry|sorrow|sad|surprised|relaxed> [intensity: 0..1]
  node scripts/send.mjs state <idle|listening|thinking|speaking>
  node scripts/send.mjs gaze <x: -1..1> <y: -1..1>
  node scripts/send.mjs framing <face|bust|half_body|full_body>
  node scripts/send.mjs speak [audio_url] [text]
  node scripts/send.mjs '<raw json>'
`);
  process.exit(0);
}

let payload = null;

if (args[0].startsWith("{")) {
  try {
    payload = JSON.parse(args.join(" "));
  } catch (err) {
    console.error("Invalid JSON payload:", err.message);
    process.exit(1);
  }
} else {
  const [cmd, val1, val2] = args;
  switch (cmd) {
    case "gesture":
      payload = { type: "gesture", name: val1 || "nod" };
      break;
    case "emotion":
    case "expression":
      payload = {
        type: "expression",
        name: val1 || "happy",
        intensity: val2 ? parseFloat(val2) : 1.0,
      };
      break;
    case "state":
      payload = { type: "state", state: val1 || "idle" };
      break;
    case "gaze":
      payload = {
        type: "gaze",
        x: val1 ? parseFloat(val1) : 0,
        y: val2 ? parseFloat(val2) : 0,
      };
      break;
    case "framing":
      payload = {
        type: "framing",
        preset: val1 || "bust",
      };
      break;
    case "speak":
      payload = {
        type: "speak",
        audio_url: val1 || undefined,
        text: val2 || "Speech test phrase",
      };
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

const headers = {};
if (process.env.VESSEL_AUTH_TOKEN) {
  headers["Authorization"] = `Bearer ${process.env.VESSEL_AUTH_TOKEN}`;
}

const ws = new WebSocket(WS_URL, { headers });

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "register", role: "producer" }));
  ws.send(JSON.stringify(payload));
  console.log(`[VESSEL CLI] Sent to ${WS_URL}:`, payload);
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 100);
});

ws.on("error", (err) => {
  console.error(`[VESSEL CLI] Failed to connect to ${WS_URL}:`, err.message);
  process.exit(1);
});

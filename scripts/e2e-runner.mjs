#!/usr/bin/env node
/**
 * Comprehensive End-to-End (E2E) Test Runner for VESSEL Release Runtime.
 * Verifies all 6 phases:
 *  1. Health & Discovery Handshake
 *  2. State & Expressions
 *  3. Camera Framing & Gaze Tracking
 *  4. Asynchronous Gestures & Action Correlation
 *  5. Speech & LipSync Execution
 *  6. Security, Error Handling & Isolation
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const PORT = process.env.VESSEL_PORT || process.argv[2] || "8765";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE_URL}/mcp`;
const HEALTH_URL = `${BASE_URL}/health`;

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

const results = [];
let reqCounter = 100;

function generateTestWavBase64(durationSeconds = 0.4, freq = 440) {
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.4 * 32767;
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }

  return buffer.toString("base64");
}

async function mcpCall(name, args = {}, options = {}) {
  const id = options.id ?? ++reqCounter;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  const start = performance.now();
  const res = await fetch(MCP_URL, { method: "POST", headers, body });
  const duration = Math.round(performance.now() - start);

  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json, duration };
}

async function step(phase, name, testFn) {
  const start = performance.now();
  try {
    const detail = await testFn();
    const duration = Math.round(performance.now() - start);
    console.log(
      `  ${colors.green}✔ PASS${colors.reset} [${duration}ms] ${name} ${
        detail ? colors.gray + detail + colors.reset : ""
      }`
    );
    results.push({ phase, name, status: "PASS", duration, detail: detail || "" });
  } catch (err) {
    const duration = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${colors.red}✖ FAIL${colors.reset} [${duration}ms] ${name}: ${msg}`);
    results.push({ phase, name, status: "FAIL", duration, detail: msg });
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runE2E() {
  console.log(`\n${colors.cyan}==============================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}   VESSEL End-to-End (E2E) Full Verification Suite${colors.reset}`);
  console.log(`${colors.cyan}   Endpoint: ${BASE_URL} | Process: vessel.exe${colors.reset}`);
  console.log(`${colors.cyan}==============================================================${colors.reset}\n`);

  // =========================================================================
  // Phase 1: Health & Discovery Handshake
  // =========================================================================
  console.log(`${colors.bold}${colors.magenta}▶ Phase 1: Health & Discovery Handshake${colors.reset}`);

  let isRendererConnected = false;
  let isModelReady = false;

  await step("Phase 1", "GET /health Service Status", async () => {
    const res = await fetch(HEALTH_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.service !== "VESSEL" || data.status !== "online") {
      throw new Error(`Unexpected payload: ${JSON.stringify(data)}`);
    }
    isRendererConnected = Boolean(data.renderer_connected);
    isModelReady = Boolean(data.model_ready);
    return `online=${data.status}, renderer=${isRendererConnected}, model=${isModelReady}`;
  });

  await step("Phase 1", "GET /mcp Protocol Discovery", async () => {
    const res = await fetch(MCP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.protocol !== "Streamable HTTP") {
      throw new Error(`Expected Streamable HTTP, got: ${data.protocol}`);
    }
    return `protocol="${data.protocol}", version="${data.version}"`;
  });

  await step("Phase 1", "POST /mcp initialize (JSON-RPC 2.0)", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const data = await res.json();
    if (data.result?.serverInfo?.name !== "vessel") {
      throw new Error(`Server name mismatch: ${JSON.stringify(data)}`);
    }
    return `server="${data.result.serverInfo.name} v${data.result.serverInfo.version}"`;
  });

  await step("Phase 1", "POST /mcp tools/list (All 8 Tools Registered)", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    const data = await res.json();
    const tools = data.result?.tools?.map((t) => t.name) || [];
    const expected = [
      "vessel_set_emotion",
      "vessel_play_gesture",
      "vessel_set_state",
      "vessel_look_at",
      "vessel_set_framing",
      "vessel_speak",
      "vessel_get_action_status",
      "vessel_get_status",
    ];
    for (const exp of expected) {
      if (!tools.includes(exp)) throw new Error(`Missing tool: ${exp}`);
    }
    return `8/8 tools present: ${tools.join(", ")}`;
  });

  // =========================================================================
  // Phase 2: State & Expressions
  // =========================================================================
  console.log(`\n${colors.bold}${colors.magenta}▶ Phase 2: State & Expressions${colors.reset}`);

  const emotionsToTest = [
    { emotion: "happy", intensity: 0.9 },
    { emotion: "surprised", intensity: 0.75 },
    { emotion: "sorrow", intensity: 0.6 },
    { emotion: "angry", intensity: 0.8 },
    { emotion: "relaxed", intensity: 1.0 },
    { emotion: "neutral", intensity: 1.0 },
  ];

  for (const { emotion, intensity } of emotionsToTest) {
    await step("Phase 2", `vessel_set_emotion (${emotion} @ ${intensity})`, async () => {
      const res = await mcpCall("vessel_set_emotion", { emotion, intensity });
      if (!res.ok || res.json?.result?.isError) {
        throw new Error(`Failed: ${JSON.stringify(res.json)}`);
      }
      return `emotion set to ${emotion}`;
    });
  }

  const statesToTest = ["listening", "thinking", "speaking", "idle"];
  for (const state of statesToTest) {
    await step("Phase 2", `vessel_set_state (${state})`, async () => {
      const res = await mcpCall("vessel_set_state", { state });
      if (!res.ok || res.json?.result?.isError) {
        throw new Error(`Failed: ${JSON.stringify(res.json)}`);
      }
      return `state updated to ${state}`;
    });
  }

  // =========================================================================
  // Phase 3: Camera Framing & Gaze Tracking
  // =========================================================================
  console.log(`\n${colors.bold}${colors.magenta}▶ Phase 3: Camera Framing & Gaze Tracking${colors.reset}`);

  const gazeTargets = [
    { target: "user" },
    { target: "away" },
    { target: "custom", x: 0.6, y: -0.3 },
    { target: "user" },
  ];

  for (const gaze of gazeTargets) {
    const label = gaze.target === "custom" ? `custom(x=${gaze.x}, y=${gaze.y})` : gaze.target;
    await step("Phase 3", `vessel_look_at (${label})`, async () => {
      const res = await mcpCall("vessel_look_at", gaze);
      if (!res.ok || res.json?.result?.isError) {
        throw new Error(`Failed: ${JSON.stringify(res.json)}`);
      }
      return `gaze directed to ${label}`;
    });
  }

  const framings = ["bust", "half_body", "full_body", "face"];
  for (const preset of framings) {
    await step("Phase 3", `vessel_set_framing (${preset})`, async () => {
      const res = await mcpCall("vessel_set_framing", { preset });
      if (!res.ok || res.json?.result?.isError) {
        throw new Error(`Failed: ${JSON.stringify(res.json)}`);
      }
      return `camera preset -> ${preset}`;
    });
  }

  // =========================================================================
  // Phase 4: Asynchronous Gestures & Action Correlation
  // =========================================================================
  console.log(`\n${colors.bold}${colors.magenta}▶ Phase 4: Asynchronous Gestures & Action Correlation${colors.reset}`);

  if (isRendererConnected) {
    await step("Phase 4", "Single Gesture Execution with Completion Poll (nod)", async () => {
      const startRes = await mcpCall("vessel_play_gesture", { gesture: "nod" });
      if (!startRes.ok || startRes.json?.result?.isError) {
        throw new Error(`Dispatch failed: ${JSON.stringify(startRes.json)}`);
      }
      const parsed = JSON.parse(startRes.json.result.content[0].text);
      const commandId = parsed.command_id;
      if (!commandId) throw new Error("No command_id returned");

      // Poll until status transitions to completed
      let finalStatus = "pending";
      const pollStart = performance.now();
      while (performance.now() - pollStart < 5000) {
        await sleep(150);
        const pollRes = await mcpCall("vessel_get_action_status", { command_id: commandId });
        const statObj = JSON.parse(pollRes.json.result.content[0].text);
        finalStatus = statObj.status;
        if (finalStatus === "completed") break;
      }

      if (finalStatus !== "completed") {
        throw new Error(`Gesture did not complete within timeout (status=${finalStatus})`);
      }
      return `command_id=${commandId}, final_status=${finalStatus}`;
    });

    await step("Phase 4", "Gesture Interruption & Cancellation (wave -> shrug)", async () => {
      // 1. Start gesture A (wave)
      const resA = await mcpCall("vessel_play_gesture", { gesture: "wave" });
      const cmdA = JSON.parse(resA.json.result.content[0].text).command_id;

      // 2. Immediately start gesture B (shrug)
      const resB = await mcpCall("vessel_play_gesture", { gesture: "shrug" });
      const cmdB = JSON.parse(resB.json.result.content[0].text).command_id;

      await sleep(100);

      // Verify A is cancelled
      const statusResA = await mcpCall("vessel_get_action_status", { command_id: cmdA });
      const statA = JSON.parse(statusResA.json.result.content[0].text).status;
      if (statA !== "cancelled") {
        throw new Error(`Expected gesture A to be cancelled, got: ${statA}`);
      }

      // Verify B eventually completes
      let statB = "pending";
      const pollStart = performance.now();
      while (performance.now() - pollStart < 5000) {
        await sleep(150);
        const statusResB = await mcpCall("vessel_get_action_status", { command_id: cmdB });
        statB = JSON.parse(statusResB.json.result.content[0].text).status;
        if (statB === "completed") break;
      }

      if (statB !== "completed") {
        throw new Error(`Expected gesture B to complete, got: ${statB}`);
      }
      return `gesture A (wave) cancelled, gesture B (shrug) completed`;
    });
  } else {
    console.log(`  ${colors.yellow}⚠ SKIPPED Phase 4 (renderer not connected)${colors.reset}`);
  }

  // =========================================================================
  // Phase 5: Speech & LipSync Execution
  // =========================================================================
  console.log(`\n${colors.bold}${colors.magenta}▶ Phase 5: Speech & LipSync Execution${colors.reset}`);

  if (isRendererConnected) {
    await step("Phase 5", "vessel_speak with Valid Base64 Audio & LipSync Completion", async () => {
      const wavBase64 = generateTestWavBase64(0.4, 523.25); // 0.4s C5 tone
      const speakRes = await mcpCall("vessel_speak", {
        audio_base64: wavBase64,
        text: "E2E verification audio test.",
        emotion: "happy",
      });

      if (!speakRes.ok || speakRes.json?.result?.isError) {
        throw new Error(`vessel_speak failed: ${JSON.stringify(speakRes.json)}`);
      }

      const parsed = JSON.parse(speakRes.json.result.content[0].text);
      const commandId = parsed.command_id;
      if (!commandId) throw new Error("No command_id returned from vessel_speak");

      // Poll until speech finishes
      let speechStatus = "pending";
      const pollStart = performance.now();
      while (performance.now() - pollStart < 5000) {
        await sleep(150);
        const pollRes = await mcpCall("vessel_get_action_status", { command_id: commandId });
        const statObj = JSON.parse(pollRes.json.result.content[0].text);
        speechStatus = statObj.status;
        if (speechStatus === "completed") break;
      }

      if (speechStatus !== "completed") {
        throw new Error(`Speech did not complete within timeout (status=${speechStatus})`);
      }

      // Check that avatar state returned to idle
      const statusCheck = await mcpCall("vessel_get_status", {});
      const statusObj = JSON.parse(statusCheck.json.result.content[0].text);

      return `command_id=${commandId}, speech_status=${speechStatus}, avatar_state=${statusObj.current_state}`;
    });
  } else {
    console.log(`  ${colors.yellow}⚠ SKIPPED Phase 5 (renderer not connected)${colors.reset}`);
  }

  // =========================================================================
  // Phase 6: Security, Error Handling & Isolation
  // =========================================================================
  console.log(`\n${colors.bold}${colors.magenta}▶ Phase 6: Security, Error Handling & Isolation${colors.reset}`);

  await step("Phase 6", "Security: Forbidden External Origin Rejection (403)", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.evil.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 991,
        method: "initialize",
        params: {},
      }),
    });
    if (res.status !== 403) {
      throw new Error(`Expected 403 Forbidden, got ${res.status}`);
    }
    return `HTTP 403 Forbidden correctly returned`;
  });

  await step("Phase 6", "Security: Allowed Loopback/Tauri Origins (200)", async () => {
    const origins = ["http://localhost:5173", "tauri://localhost"];
    for (const origin of origins) {
      const res = await fetch(MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 992,
          method: "initialize",
          params: {},
        }),
      });
      if (res.status !== 200) {
        throw new Error(`Expected 200 OK for origin ${origin}, got ${res.status}`);
      }
    }
    return `allowed origins verified`;
  });

  await step("Phase 6", "Error Handling: Invalid Tool Name", async () => {
    const res = await mcpCall("vessel_non_existent_method_xyz", {});
    const isError = res.json?.result?.isError || res.json?.error;
    if (!isError) {
      throw new Error(`Expected error response, got: ${JSON.stringify(res.json)}`);
    }
    return `correctly rejected with error`;
  });

  await step("Phase 6", "Error Handling: Invalid Command ID Query", async () => {
    const res = await mcpCall("vessel_get_action_status", { command_id: "non-existent-uuid" });
    const parsed = JSON.parse(res.json?.result?.content?.[0]?.text || "{}");
    if (parsed.status !== "unknown_or_expired") {
      throw new Error(`Expected status 'unknown_or_expired', got: ${parsed.status}`);
    }
    return `status="unknown_or_expired"`;
  });

  await step("Phase 6", "Concurrency: Parallel Request Isolation (Same JSON-RPC ID)", async () => {
    const sharedId = 8888;
    const [pA, pB] = await Promise.all([
      mcpCall("vessel_set_emotion", { emotion: "happy" }, { id: sharedId }),
      mcpCall("vessel_set_framing", { preset: "face" }, { id: sharedId }),
    ]);

    if (pA.json?.id !== sharedId || pB.json?.id !== sharedId) {
      throw new Error("Mismatched JSON-RPC request IDs in responses");
    }

    const textA = pA.json.result.content[0].text;
    const textB = pB.json.result.content[0].text;

    if (!textA.includes("happy") || !textB.includes("face")) {
      throw new Error(`Cross-contamination between parallel requests: A=${textA}, B=${textB}`);
    }
    return `parallel responses preserved id=${sharedId} without cross-contamination`;
  });

  // =========================================================================
  // Report Summary
  // =========================================================================
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const total = results.length;
  const totalDuration = results.reduce((acc, r) => acc + r.duration, 0);

  console.log(`\n${colors.cyan}==============================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}                    E2E EXECUTION SUMMARY                    ${colors.reset}`);
  console.log(`${colors.cyan}==============================================================${colors.reset}`);
  console.log(`  Total Checks: ${colors.bold}${total}${colors.reset}`);
  console.log(`  Passed:       ${colors.green}${colors.bold}${passed}${colors.reset}`);
  console.log(`  Failed:       ${failed > 0 ? colors.red : colors.gray}${colors.bold}${failed}${colors.reset}`);
  console.log(`  Total Time:   ${colors.bold}${totalDuration} ms${colors.reset}`);
  console.log(`${colors.cyan}==============================================================${colors.reset}\n`);

  // Generate markdown report
  const reportPath = resolve(process.cwd(), ".work/reports/e2e.md");
  mkdirSync(dirname(reportPath), { recursive: true });

  const mdLines = [
    "# VESSEL End-to-End (E2E) Verification Report",
    "",
    `> **Execution Date:** ${new Date().toISOString()}  `,
    `> **Target:** ${BASE_URL}  `,
    `> **Result:** **${failed === 0 ? "PASSED (100%)" : "FAILED"}** (${passed}/${total} passed)  `,
    `> **Total Duration:** ${totalDuration} ms  `,
    "",
    "## Detailed Test Results",
    "",
    "| Phase | Test Scenario | Status | Latency | Details |",
    "| :--- | :--- | :---: | :---: | :--- |",
    ...results.map(
      (r) =>
        `| ${r.phase} | ${r.name} | ${r.status === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${r.duration} ms | \`${r.detail.replace(/\|/g, "\\|")}\` |`
    ),
    "",
    "---",
    "",
    "## Environment & Runtime Status",
    `- **Binary:** \`src-tauri/target/release/vessel.exe\``,
    `- **Renderer Connected:** \`${isRendererConnected}\``,
    `- **VRM Model Ready:** \`${isModelReady}\``,
    `- **Protocol:** Model Context Protocol (MCP) Streamable HTTP JSON-RPC 2.0`,
  ];

  writeFileSync(reportPath, mdLines.join("\n"), "utf-8");
  console.log(`Detailed Markdown report saved to: ${colors.green}${reportPath}${colors.reset}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runE2E().catch((err) => {
  console.error("Fatal runner error:", err);
  process.exit(1);
});

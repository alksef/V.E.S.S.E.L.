#!/usr/bin/env node
/**
 * MCP Endpoint Diagnostic and Verification Tool for VESSEL.
 * Sends JSON-RPC 2.0 requests over Streamable HTTP to verify MCP capabilities.
 */

const port = process.env.VESSEL_PORT || process.argv[2] || "8765";
const token = process.env.VESSEL_AUTH_TOKEN || "";
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
const healthUrl = `${baseUrl}/health`;

const headers = {
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

function pass(name, detail = "") {
  console.log(`  ${colors.green}✔ PASS${colors.reset} ${name} ${detail ? colors.gray + detail + colors.reset : ""}`);
}

function fail(name, error) {
  console.error(`  ${colors.red}✖ FAIL${colors.reset} ${name}: ${error}`);
  process.exit(1);
}

async function runMcpChecks() {
  console.log(`\n${colors.cyan}=================================================${colors.reset}`);
  console.log(`${colors.cyan}       VESSEL MCP Endpoint Verification${colors.reset}`);
  console.log(`${colors.cyan}       Target: ${mcpUrl}${colors.reset}`);
  console.log(`${colors.cyan}=================================================${colors.reset}\n`);

  // 1. Health check
  let isRendererConnected = false;
  try {
    const res = await fetch(healthUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.service !== "VESSEL" || data.status !== "online") {
      throw new Error(`Unexpected health payload: ${JSON.stringify(data)}`);
    }
    isRendererConnected = Boolean(data.renderer_connected);
    pass("GET /health", `(service=${data.service}, status=${data.status}, renderer_connected=${data.renderer_connected}, model_ready=${data.model_ready})`);
  } catch (err) {
    fail("GET /health", err.message);
  }

  // 2. MCP GET Discovery
  try {
    const res = await fetch(mcpUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.protocol !== "Streamable HTTP") {
      throw new Error(`Unexpected protocol info: ${JSON.stringify(data)}`);
    }
    pass("GET /mcp Discovery", `(protocol="${data.protocol}", version="${data.version}")`);
  } catch (err) {
    fail("GET /mcp Discovery", err.message);
  }

  // 3. MCP POST Initialize
  let reqId = 1;
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId++,
        method: "initialize",
        params: {},
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.jsonrpc !== "2.0" || !data.result?.serverInfo?.name) {
      throw new Error(`Invalid JSON-RPC response: ${JSON.stringify(data)}`);
    }
    pass("POST /mcp initialize", `(server="${data.result.serverInfo.name} v${data.result.serverInfo.version}")`);
  } catch (err) {
    fail("POST /mcp initialize", err.message);
  }

  // 4. MCP POST tools/list
  let toolNames = [];
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId++,
        method: "tools/list",
        params: {},
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!Array.isArray(data.result?.tools)) {
      throw new Error(`Tools array missing: ${JSON.stringify(data)}`);
    }
    toolNames = data.result.tools.map((t) => t.name);
    const requiredTools = [
      "vessel_set_emotion",
      "vessel_play_gesture",
      "vessel_set_state",
      "vessel_look_at",
      "vessel_set_framing",
      "vessel_speak",
      "vessel_get_action_status",
      "vessel_get_status",
    ];
    for (const reqTool of requiredTools) {
      if (!toolNames.includes(reqTool)) {
        throw new Error(`Expected tool "${reqTool}" not found in tools/list!`);
      }
    }
    pass("POST /mcp tools/list", `(${toolNames.length} tools registered: ${toolNames.join(", ")})`);
  } catch (err) {
    fail("POST /mcp tools/list", err.message);
  }

  // 5. MCP POST tools/call vessel_get_status
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId++,
        method: "tools/call",
        params: {
          name: "vessel_get_status",
          arguments: {},
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.result?.isError) {
      throw new Error(`Tool call failed: ${JSON.stringify(data.result)}`);
    }
    const contentText = data.result?.content?.[0]?.text;
    const parsed = JSON.parse(contentText || "{}");
    pass("POST /mcp tools/call (vessel_get_status)", `(status=${parsed.status}, current_state=${parsed.current_state})`);
  } catch (err) {
    fail("POST /mcp tools/call (vessel_get_status)", err.message);
  }

  // 6. MCP POST tools/call vessel_set_emotion
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId++,
        method: "tools/call",
        params: {
          name: "vessel_set_emotion",
          arguments: {
            emotion: "happy",
            intensity: 0.85,
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.result?.isError) {
      throw new Error(`Tool call error: ${JSON.stringify(data.result)}`);
    }
    const contentText = data.result?.content?.[0]?.text;
    pass("POST /mcp tools/call (vessel_set_emotion)", `(${contentText})`);
  } catch (err) {
    fail("POST /mcp tools/call (vessel_set_emotion)", err.message);
  }

  // 7. MCP POST tools/call vessel_set_state
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId++,
        method: "tools/call",
        params: {
          name: "vessel_set_state",
          arguments: {
            state: "thinking",
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.result?.isError) {
      throw new Error(`Tool call error: ${JSON.stringify(data.result)}`);
    }
    const contentText = data.result?.content?.[0]?.text;
    pass("POST /mcp tools/call (vessel_set_state)", `(${contentText})`);
  } catch (err) {
    fail("POST /mcp tools/call (vessel_set_state)", err.message);
  }

  // 8. MCP POST tools/call vessel_look_at
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId++,
        method: "tools/call",
        params: {
          name: "vessel_look_at",
          arguments: {
            target: "user",
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.result?.isError) {
      throw new Error(`Tool call error: ${JSON.stringify(data.result)}`);
    }
    const contentText = data.result?.content?.[0]?.text;
    pass("POST /mcp tools/call (vessel_look_at)", `(${contentText})`);
  } catch (err) {
    fail("POST /mcp tools/call (vessel_look_at)", err.message);
  }

  // 9. MCP POST tools/call vessel_play_gesture & vessel_get_action_status
  if (isRendererConnected) {
    try {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: reqId++,
          method: "tools/call",
          params: {
            name: "vessel_play_gesture",
            arguments: {
              gesture: "nod",
            },
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      if (data.result?.isError) {
        throw new Error(`Gesture tool error: ${JSON.stringify(data.result)}`);
      }
      const gestureResponse = JSON.parse(data.result?.content?.[0]?.text || "{}");
      const commandId = gestureResponse.command_id;
      pass("POST /mcp tools/call (vessel_play_gesture)", `(status=${gestureResponse.status}, command_id=${commandId})`);

      if (commandId) {
        const statRes = await fetch(mcpUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: reqId++,
            method: "tools/call",
            params: {
              name: "vessel_get_action_status",
              arguments: { command_id: commandId },
            },
          }),
        });
        const statData = await statRes.json();
        const statObj = JSON.parse(statData.result?.content?.[0]?.text || "{}");
        pass("POST /mcp tools/call (vessel_get_action_status)", `(command_id=${statObj.command_id}, status=${statObj.status})`);
      }
    } catch (err) {
      fail("POST /mcp tools/call (vessel_play_gesture)", err.message);
    }
  }

  console.log(`\n${colors.green}=================================================${colors.reset}`);
  console.log(`${colors.green}   ALL MCP ENDPOINT VERIFICATIONS PASSED! ✨    ${colors.reset}`);
  console.log(`${colors.green}=================================================${colors.reset}\n`);
}

runMcpChecks().catch((err) => {
  console.error("Unhandled verification error:", err);
  process.exit(1);
});

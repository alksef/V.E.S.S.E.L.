# Интеграции

- [MCP](mcp.md) — HTTP JSON-RPC, схемы инструментов и статусы действий.
- [WebSocket](avatar-control.md) — регистрация producer/renderer, команды и события.

Адрес по умолчанию: `127.0.0.1:8765`. Переменная `VESSEL_PORT` меняет порт
backend, `VESSEL_AUTH_TOKEN` включает Bearer-авторизацию.
`VITE_AVATAR_WS_URL` задаёт адрес сокета frontend при запуске Vite или сборке;
`VESSEL_WS_URL` — адрес для `pnpm send`.

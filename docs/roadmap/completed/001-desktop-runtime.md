# 001 — Базовый desktop runtime и управление аватаром

Статус: completed. Это сводка реализованного кода, а не акт ручной приёмки.

## Результат

- Прозрачное окно Tauri с треем и встроенным Rust/Axum backend.
- HTTP MCP и WebSocket producer/renderer с состояниями действий.
- VRM-модель, мимика, взгляд, процедурные жесты и пресеты камеры.
- Web Audio воспроизведение с процедурным липсинком.
- Unit/integration-тесты и отдельные проверки работающего приложения.

Устаревший общий документ control-spec-and-roadmap заменён этой сводкой.
Актуальные детали: [архитектура](../../development/architecture.md),
[MCP](../../integrations/mcp.md), [WebSocket](../../integrations/avatar-control.md).

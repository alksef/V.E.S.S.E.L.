# Архитектура

`src-tauri/src/main.rs` запускает окно Tauri, трей и backend в одном процессе.
С флагом `--headless` или `VESSEL_HEADLESS=1` запускается только backend.

| Компонент | Ответственность |
|---|---|
| `server.rs`, `health.rs` | Axum router, loopback, состояние сервиса |
| `service.rs`, `types.rs` | Целевое состояние, действия и их статусы |
| `mcp_server.rs` | HTTP JSON-RPC, инструменты, Origin и авторизация |
| `ws_server.rs` | Producer/renderer, доставка команд и событий |
| `src/ws-client.ts` | Соединение frontend и обработка команд |
| `src/vrm-scene.ts`, `src/vrm-avatar.ts` | Сцена, камера и загрузка VRM |
| `src/model-store.ts` | Сохранение VRM через Tauri, миграция из IndexedDB; IndexedDB для браузера |
| `src/config-store.ts`, `src-tauri/src/config.rs` | JSON-конфиг и копия VRM в `%APPDATA%\v.e.s.s.e.l.\`, сохранение кадра и зума |
| `src/animator.ts` | Поза, жесты, взгляд, мимика и липсинк |
| `src/speech-player.ts` | Воспроизведение аудио и анализ громкости |
| `src/main.ts`, `index.html` | Сборка frontend и управление окном |

MCP и producer-команды поступают в DomainService. Backend хранит целевое
состояние и передаёт команды renderer по WebSocket. Renderer исполняет
жесты и речь, отправляет начало воспроизведения и итог по `command_id`.
При смене renderer учитывается поколение соединения; целевое состояние
восстанавливается снимком при готовности модели.

Речь проигрывается в WebView через Web Audio. Липсинк процедурно выбирает
виземы по аудиосигналу; это не распознавание фонем текста.

Контракты находятся в [интеграциях](../integrations/README.md).

Файл VRM выбирается через системный file input и проверяется загрузчиком
three-vrm до замены текущего аватара. В настольном приложении сохраняются
копия VRM и её имя в JSON-конфиге, в браузере — имя и Blob в IndexedDB;
при следующем запуске создаётся временный object URL. При ошибке предыдущая
модель остаётся активной. В репозитории и frontend bundle VRM-файлов нет.

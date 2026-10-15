# V.E.S.S.E.L.

**Virtual Entity Surface for Synthetic Existence & Life** — прозрачный
настольный 3D-аватар для ИИ-агентов. Tauri 2 / Rust, Three.js и VRM.
Backend и интерфейс входят в один `vessel.exe`. На Windows требуется WebView2;
Node.js и Rust нужны для разработки и сборки.

Возможности: эмоции, взгляд, процедурные жесты, кадрирование камеры,
воспроизведение аудио с липсинком. Управление через MCP и WebSocket.
Щелчок по иконке трея показывает или скрывает окно, «Выход» завершает процесс.

## Разработка и сборка

Нужны Node.js 24, pnpm, Rust MSVC и Visual Studio C++ Build Tools.

```powershell
pnpm install --frozen-lockfile
pnpm dev:app
```

Закройте VESSEL через трей перед пересборкой исполняемого файла.

```powershell
pnpm build:release
pnpm build:debug
```

Результат: `<CargoTargetDir>/<release|debug>/vessel.exe`, по умолчанию
в `src-tauri/target`. [Настройка путей и короткие режимы r/d](docs/development/README.md#сборка).
Запускайте файл напрямую.

## Подключение

По умолчанию сервер слушает `127.0.0.1:8765`:

| Адрес | Назначение |
|---|---|
| `GET /health` | Состояние сервиса и готовность модели |
| `/mcp` | JSON-RPC, инструменты MCP |
| `/ws/avatar` | Команды и события WebSocket |

```powershell
pnpm send gesture wave
pnpm send emotion happy 1.0
pnpm check:mcp
```

На первом запуске нажмите **Choose VRM…** и выберите свою модель VRM 0.x или 1.0.
Она сохраняется локально и открывается при следующих запусках. Для замены
выберите другой файл той же кнопкой. Пересборка и скачивание модели не нужны;
модели в репозиторий и исполняемый файл не входят.

[Документация](docs/README.md) · [Разработка](docs/development/README.md) ·
[Roadmap](docs/roadmap/README.md)

Код распространяется по [MIT](LICENSE). Права на сторонние модели определяются
их собственными условиями; MIT проекта на них не распространяется.

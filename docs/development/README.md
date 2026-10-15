# Разработка

Установите Node.js 24, pnpm, Rust MSVC, Visual Studio C++ Build Tools и WebView2.
Запускайте команды из корня проекта.

```powershell
pnpm install --frozen-lockfile
pnpm dev:app
```

Для browser-режима запустите в двух терминалах `pnpm start:headless` и
`pnpm dev`. Откройте адрес Vite. При нестандартном порте задайте
`VITE_AVATAR_WS_URL` для frontend.

## Проверки

```powershell
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

При изменении интеграций запустите приложение и выполните `pnpm check:mcp`.
`pnpm test:e2e` требует подключённый renderer и загруженную модель, меняет
состояние аватара и воспроизводит тестовый звук. Отчёт: `.work/reports/e2e.md`.
Проверки HTTP не подтверждают визуальное качество анимации — его смотрят вручную.

## Сборка

```powershell
pnpm build:release
pnpm build:debug
# Короткие режимы скрипта:
.\scripts\build.ps1 r
.\scripts\build.ps1 d
# Упаковка средствами Tauri при необходимости:
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Bundle
```

Перед сборкой закройте работающий VESSEL через трей.
Tauri сам запускает сборку frontend; `build.ps1` выбирает профиль и проверяет exe.

Для настройки окружения скопируйте `scripts/build.local.example.psd1` в
`scripts/build.local.psd1` и задайте `CargoTargetDir` и, при необходимости,
`RustBinDir`. Локальный файл игнорируется Git; конкретный диск в коде не задан.
Пути могут быть абсолютными, относительными от корня проекта или содержать
переменные `%NAME%`.

Приоритет пути сборки: `-CargoTargetDir` → `CARGO_TARGET_DIR` → локальный файл →
`src-tauri/target`. Для Rust: `-RustBinDir` → `VESSEL_RUST_BIN_DIR` → локальный
файл → `%USERPROFILE%\.cargo\bin`, если он существует; иначе используется PATH.
Другой файл настроек можно передать через `-ConfigFile`.
Исполняемый файл находится в `<CargoTargetDir>/<release|debug>/vessel.exe`.
Настройки файла применяются скриптом сборки; прямые команды cargo и `pnpm dev:app`
используют своё окружение, в том числе стандартную переменную `CARGO_TARGET_DIR`.

В `scripts/` остаются четыре инструмента: сборка, отправка WS-команд,
проверка MCP и E2E. Стандартные команды запуска находятся в `package.json`.

[Архитектура](architecture.md) · [Workflow](workflow.md)

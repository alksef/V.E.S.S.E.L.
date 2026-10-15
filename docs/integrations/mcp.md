# VESSEL: Спецификация и руководство по интеграции MCP (Model Context Protocol)

> **V.E.S.S.E.L.** — **V**irtual **E**ntity **S**urface for **S**ynthetic **E**xistence & **L**ife  
> Автономный легковесный десктопный компаньон и 3D-оверлей для ИИ-агентов на базе Three.js + VRM + Tauri 2 (Rust).

---

## 1. Архитектурный обзор

VESSEL реализует нативную поддержку спецификации **Model Context Protocol (MCP)** прямо внутри настольного исполняемого файла (`vessel.exe`), без использования Python, Node.js или внешних мостов/прокси.

```mermaid
flowchart TD
    subgraph Host["Хост-среда агента"]
        Claude["Claude Desktop / Claude Code"]
        Cursor["Cursor IDE"]
        Remote["Remote MCP Clients"]
        Agent["Пользовательский агент (Python, Go, TS)"]
    end

    subgraph VesselBackend["VESSEL Core (vessel.exe :8765)"]
        Router["Axum HTTP Router"]
        Security["Проверка Origin и Bearer Auth"]
        MCPHandler["MCP Streamable HTTP / JSON-RPC"]
        Domain["Domain Service (State, Actions, Command IDs)"]
    end

    subgraph Overlay["3D WebGL Overlay (Three.js + VRM)"]
        Renderer["Рендерер аватара (Скелет, Мимика, Взгляд)"]
        Audio["Web Audio API (RMS Lipsync)"]
    end

    Claude -->|HTTP POST /mcp| Router
    Cursor -->|HTTP POST /mcp| Router
    Remote -->|Streamable HTTP /mcp| Router
    Agent -->|HTTP POST /mcp| Router

    Router --> Security
    Security --> MCPHandler
    MCPHandler --> Domain
    Domain <-->|Внутренний WS /ws/avatar| Renderer
    Renderer --> Audio
```

### Ключевые принципы
* **Zero-Python & Zero-Node Runtime:** MCP-сервер скомпилирован в нативный бинарный код на Rust (Axum + Tokio + serde_json).
* **Единый порт loopback:** HTTP, SSE, MCP и WebSocket работают на одном порту `127.0.0.1:8765`.
* **Стандартный транспорт Streamable HTTP:** Поддерживает как классический JSON-RPC 2.0 через HTTP POST, так и SSE-дискавери через HTTP GET.
* **Асинхронные действия с корреляцией:** Длительные действия (жесты, воспроизведение речи) принимаются немедленно с выдачей `command_id`, а их статус отслеживается через опрос.

---

## 2. Транспорт и сетевой протокол

* **Основной эндпоинт:** `http://127.0.0.1:8765/mcp`
* **Протокол сообщений:** JSON-RPC 2.0
* **Версия MCP:** `2024-11-05`
* **Транспорт:** MCP Streamable HTTP (SSE discovery + HTTP POST RPC)

### 2.1. GET /mcp (Discovery и SSE)
Эндпоинт `GET /mcp` предназначен для обнаружения сервиса и SSE-стриминга.

#### Обычный GET (JSON metadata)
Запрос:
```http
GET /mcp HTTP/1.1
Host: 127.0.0.1:8765
Accept: application/json
```
Ответ (`200 OK`):
```json
{
  "service": "VESSEL",
  "version": "0.1.0",
  "mcp_endpoint": "/mcp",
  "protocol": "Streamable HTTP"
}
```

#### SSE Discovery (Server-Sent Events)
Если клиент отправляет заголовок `Accept: text/event-stream`, сервер возвращает SSE-событие с адресом RPC-эндпоинта:
```http
GET /mcp HTTP/1.1
Host: 127.0.0.1:8765
Accept: text/event-stream
```
Ответ (`200 OK`):
```http
Content-Type: text/event-stream
Cache-Control: no-cache

event: endpoint
data: /mcp

```

### 2.2. POST /mcp (JSON-RPC 2.0)
Все операции с инструментами (tools) осуществляются через отправку JSON-RPC 2.0 запросов методом `POST /mcp` с `Content-Type: application/json`.

---

## 3. Безопасность и авторизация

### 3.1. Защита Origin (Origin Header Check)
Для предотвращения атак типа DNS-rebinding и несанкционированного доступа из веб-страниц браузера сервер проверяет заголовок `Origin`:
* **Разрешены:** `localhost`, `127.0.0.1`, `tauri://*`, `null`.
* **Разрешены нативные клиенты:** Запросы без заголовка `Origin` (например, от `curl`, Python-скриптов, desktop-агентов) разрешаются на loopback-интерфейсе.
* **Заблокированы:** Любые сторонние домены браузера (например, `Origin: https://evil-site.com`). Сервер отвечает `403 Forbidden`.

### 3.2. Bearer Token Аутентификация (опционально)
Если задана переменная окружения `VESSEL_AUTH_TOKEN`:
```bash
set VESSEL_AUTH_TOKEN=my-secret-agent-token
```
Сервер требует передачи токена во всех запросах к `/mcp` и `/ws/avatar`:
```http
Authorization: Bearer my-secret-agent-token
```
При отсутствии или неверном токене возвращается `401 Unauthorized` с заголовком `WWW-Authenticate: Bearer`.
Если переменная `VESSEL_AUTH_TOKEN` не задана, доступ на локальном интерфейсе `127.0.0.1` открыт без токена.

---

## 4. Жизненный цикл сессии MCP

Сервер поддерживает стандартный жизненный цикл протокола Model Context Protocol:

### 4.1. Handshake `initialize`
Клиент инициирует соединение:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "my-ai-agent",
      "version": "1.0.0"
    }
  }
}
```
Ответ сервера:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "vessel",
      "version": "0.1.0"
    }
  }
}
```

### 4.2. Уведомление `notifications/initialized`
Клиент подтверждает завершение инициализации:
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```
Сервер отвечает статусом `204 No Content`.

### 4.3. Получение каталога инструментов: `tools/list`
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```
Сервер возвращает список всех зарегистрированных инструментов и их JSON-схемы.

### 4.4. Вызов инструмента: `tools/call`
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "vessel_set_emotion",
    "arguments": {
      "emotion": "happy",
      "intensity": 0.9
    }
  }
}
```

---

## 5. Каталог инструментов (Tools Catalog)

VESSEL предоставляет 8 специализированных инструментов для управления аватаром, камерой, речью и отслеживания состояния.

### Сводная таблица инструментов

| Инструмент | Тип исполнения | Назначение |
| :--- | :--- | :--- |
| **`vessel_set_emotion`** | Синхронный | Установка мимики и эмоционального выражения лица. |
| **`vessel_play_gesture`** | Асинхронный (`command_id`) | Запуск процедурного жеста тела/головы. |
| **`vessel_set_state`** | Синхронный | Переключение состояния диалога (idle, listening, thinking, speaking). |
| **`vessel_look_at`** | Синхронный | Управление направлением взгляда и саккадами. |
| **`vessel_set_framing`** | Синхронный | Кинематографичное кадрирование камеры (планы face, bust, half_body, full_body). |
| **`vessel_speak`** | Асинхронный (`command_id`) | Воспроизведение звука с автономным RMS-липсиком рта. |
| **`vessel_get_action_status`** | Синхронный | Проверка статуса выполнения асинхронного действия по `command_id`. |
| **`vessel_get_status`** | Синхронный | Запрос общей готовности оверлея, 3D-модели и текущего состояния. |

---

### Детальная спецификация параметров инструментов

#### 1. `vessel_set_emotion`
Устанавливает эмоциональное выражение лица аватара с заданной интенсивностью через blendshapes/morph targets.
* **Свойства схемы (`inputSchema`):**
  * `emotion` (`string`, **обязательный**):
    * Допустимые значения: `"neutral"`, `"happy"`, `"angry"`, `"sorrow"`, `"sad"`, `"surprised"`, `"relaxed"`.
  * `intensity` (`number`, опциональный, по умолчанию `1.0`):
    * Диапазон: от `0.0` до `1.0`.
* **Пример аргументов:**
  ```json
  { "emotion": "happy", "intensity": 0.85 }
  ```
* **Формат успешного ответа:**
  ```json
  {
    "status": "ok",
    "action": "set_emotion",
    "emotion": "happy",
    "intensity": 0.85
  }
  ```

---

#### 2. `vessel_play_gesture`
Запускает процедурный сплайновый жест головы или тела. Действие выполняется асинхронно во времени.
* **Свойства схемы (`inputSchema`):**
  * `gesture` (`string`, **обязательный**):
    * Допустимые значения:
      * `"nod"` — утвердительный кивок головой.
      * `"shake_head"` — отрицательное покачивание головой.
      * `"tilt_head"` — вопросительный или заинтересованный наклон головы.
      * `"wave"` — взмах правой рукой с раскрытием пальцев (приветствие).
      * `"shrug"` — пожимание плечами и приподнятие рук (недоумение).
* **Пример аргументов:**
  ```json
  { "gesture": "wave" }
  ```
* **Формат успешного ответа (принято в очередь):**
  ```json
  {
    "status": "accepted",
    "action": "play_gesture",
    "gesture": "wave",
    "command_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  }
  ```
> **Важно:** Возврат статуса `accepted` означает постановку жеста в выполнение. Окончание выполнения отслеживается через вызов `vessel_get_action_status` с переданным `command_id`.

---

#### 3. `vessel_set_state`
Обновляет высокоуровневое состояние агента в диалоговом цикле. Влияет на фоновые микроанимации ожидания, дыхание и фокус взгляда.
* **Свойства схемы (`inputSchema`):**
  * `state` (`string`, **обязательный**):
    * `"idle"` — покой, расслабленное дыхание и естественный дрейф взгляда.
    * `"listening"` — слушание пользователя, внимательный контакт глазами.
    * `"thinking"` — размышление, отведение взгляда вверх-вбок, задумчивость.
    * `"speaking"` — активная фаза говорения.
* **Пример аргументов:**
  ```json
  { "state": "thinking" }
  ```
* **Формат успешного ответа:**
  ```json
  {
    "status": "ok",
    "action": "set_state",
    "state": "thinking"
  }
  ```

---

#### 4. `vessel_look_at`
Направляет взгляд глаз и доворот головы аватара.
* **Свойства схемы (`inputSchema`):**
  * `target` (`string`, **обязательный**):
    * `"user"` — прямой контакт с пользователем (координаты по умолчанию `[0.0, 0.1]`).
    * `"away"` — отведение взгляда в сторону (`[0.45, 0.5]`).
    * `"custom"` — произвольная точка на экране.
  * `x` (`number`, опциональный, для `custom`):
    * Горизонтальная координата от `-1.0` (крайний левый) до `1.0` (крайний правый).
  * `y` (`number`, опциональный, для `custom`):
    * Вертикальная координата от `-1.0` (вниз) до `1.0` (вверх).
* **Пример аргументов:**
  ```json
  { "target": "custom", "x": -0.4, "y": 0.2 }
  ```
* **Формат успешного ответа:**
  ```json
  {
    "status": "ok",
    "action": "look_at",
    "target": "custom",
    "x": -0.4,
    "y": 0.2
  }
  ```

---

#### 5. `vessel_set_framing`
Плавно переключает кинематографический план камеры (slerp/lerp позиции, точки фокуса и угла обзора FOV).
* **Свойства схемы (`inputSchema`):**
  * `preset` (`string`, **обязательный**):
    * `"face"` — крупный план лица (портрет, акцент на мимике).
    * `"bust"` — средний погрудный план (по умолчанию, оптимален для диалога).
    * `"half_body"` — поясной план (хорошо видны жесты рук).
    * `"full_body"` — общий ростовой план аватара.
* **Пример аргументов:**
  ```json
  { "preset": "face" }
  ```
* **Формат успешного ответа:**
  ```json
  {
    "status": "ok",
    "action": "set_framing",
    "preset": "face"
  }
  ```

---

#### 6. `vessel_speak`
Запускает воспроизведение аудиофайла на аватаре со встроенным анализом спектра через Web Audio API и динамической анимацией рта (`aa`) в реальном времени.
* **Свойства схемы (`inputSchema`):**
  * `audio_url` (`string`, опциональный):
    * HTTP или HTTPS ссылка на аудиофайл (`.mp3`, `.wav`, `.ogg`). Прямые пути файловой системы (`file://`, `C:\...`) не поддерживаются в целях безопасности.
  * `audio_base64` (`string`, опциональный):
    * Data URI аудио в формате base64 (например, `data:audio/wav;base64,...`).
  * `text` (`string`, опциональный):
    * Текстовая фраза для отладки и субтитров.
  * `emotion` (`string`, опциональный):
    * Эмоция, удерживаемая во время произнесения речи (`"neutral"`, `"happy"`, `"angry"`, `"sorrow"`, `"sad"`, `"surprised"`, `"relaxed"`).
* **Валидация:** Обязательно должен быть указан хотя бы один из параметров: `audio_url` или `audio_base64`.
* **Пример аргументов:**
  ```json
  {
    "audio_url": "http://127.0.0.1:8000/tts_output.wav",
    "text": "Здравствуйте, чем я могу помочь вам сегодня?",
    "emotion": "happy"
  }
  ```
* **Формат успешного ответа (принято в очередь):**
  ```json
  {
    "status": "accepted",
    "action": "speak",
    "command_id": "4a2c5f11-92e1-4bb3-b271-89d2ec1d4f20"
  }
  ```

---

#### 7. `vessel_get_action_status`
Опрашивает статус выполнения асинхронного действия (жеста или воспроизведения речи) по присвоенному `command_id`.
* **Свойства схемы (`inputSchema`):**
  * `command_id` (`string`, **обязательный**):
    * Идентификатор команды, полученный при вызове `vessel_play_gesture` или `vessel_speak`.
* **Пример аргументов:**
  ```json
  { "command_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" }
  ```
* **Формат ответа:**
  ```json
  {
    "command_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "action": "gesture",
    "status": "completed",
    "error": null,
    "created_at_ms": 1728939600120,
    "finished_at_ms": 1728939602450
  }
  ```
* **Возможные статусы (`status`):**
  * `"pending"` — действие выполняется в данный момент.
  * `"completed"` — действие успешно завершено (жест отыгран, аудио доиграло до конца).
  * `"cancelled"` — действие было прервано новым жестом или новой фразой речи.
  * `"failed"` — возникла ошибка при выполнении (например, сетевая ошибка загрузки аудио).
  * `"unknown_or_expired"` — указанный `command_id` не найден или устарел.

---

#### 8. `vessel_get_status`
Запрашивает состояние готовности сервиса VESSEL, активность рендерера, готовность VRM-модели и текущие целевые параметры.
* **Свойства схемы (`inputSchema`):** аргументы отсутствуют (`{}`).
* **Формат ответа:**
  ```json
  {
    "service": "VESSEL",
    "status": "online",
    "renderer_connected": true,
    "model_ready": true,
    "active_command_count": 0,
    "desired_state": {
      "state": "idle",
      "expression": {
        "name": "happy",
        "intensity": 0.85
      },
      "gaze": {
        "x": 0.0,
        "y": 0.1
      },
      "framing": "bust"
    }
  }
  ```

---

## 6. Модель исполнения команд: Синхронность, Очереди и Отмена

### 6.1. Синхронные постоянные свойства (Desired State)
Команды `set_emotion`, `set_state`, `look_at`, `set_framing` обновляют целевое состояние (Desired State) в памяти ядра VESSEL.
* Они применяются мгновенно.
* При временном разрыве соединения или реконнекте оверлея текущее состояние автоматически пересылается аватару в виде целостного снимка (`snapshot`).

### 6.2. Асинхронные действия и вытеснение (Preemption)
Команды `vessel_play_gesture` и `vessel_speak` требуют времени на проигрывание:
1. Сервер регистрирует команду в реестре действий со статусом `pending` и генерирует UUID `command_id`.
2. Если в этот момент уже проигрывался другой жест (или речь), предыдущая активная команда **автоматически вытесняется и переходит в статус `cancelled`**. Оверлей получает команду немедленной остановки предыдущего действия.
3. По завершении анимации или воспроизведения оверлей отправляет сигнал завершения, и статус действия переходит в `completed`.

### 6.3. Готовность рендерера (Readiness Gate)
Если 3D-оверлей еще не загрузился или VRM-модель еще находится в процессе парсинга (`model_ready == false`), вызов жестов или речи не выполняется вслепую, а немедленно отклоняется с ошибкой:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "{\"error\":\"renderer_not_ready\",\"message\":\"Avatar renderer is not connected or model is not loaded yet\",\"status\":\"rejected\"}"
      }
    ]
  }
}
```

---

## 7. Обработка ошибок

### 7.1. Стандартные ошибки JSON-RPC 2.0
Если запрос не соответствует спецификации JSON-RPC 2.0, сервер возвращает стандартные коды ошибок:

| Код | Описание | Причина |
| :--- | :--- | :--- |
| **`-32700`** | Parse error | Невалидный JSON в теле запроса. |
| **`-32600`** | Invalid Request | Тело запроса не является объектом или отсутствует поле `method`. |
| **`-32601`** | Method not found | Неизвестный метод (поддерживаются `initialize`, `notifications/initialized`, `tools/list`, `tools/call`). Также возвращается при вызове несуществующего инструмента в `tools/call`. |
| **`-32602`** | Invalid params | Некорректные параметры (например, неизвестное имя жеста или отсутствие аудио-данных для речи). |

Пример ошибки неизвестного метода:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Unknown tool 'vessel_invalid_tool'"
  }
}
```

### 7.2. Ошибки бизнес-логики инструментов (Tool Execution Errors)
Если синтаксис JSON-RPC корректен, но инструмент не может быть выполнен (например, рендерер не готов), сервер возвращает успешный JSON-RPC ответ с флагом `isError: true` в соответствии со спецификацией MCP:
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "{\"error\":\"renderer_not_ready\",\"message\":\"Avatar renderer is not connected or model is not loaded yet\",\"status\":\"rejected\"}"
      }
    ]
  }
}
```

---

## 8. Практические примеры вызовов

### 8.1. Инициализация и получение инструментов через cURL

```bash
# 1. Проверка статуса сервиса
curl -s http://127.0.0.1:8765/health

# 2. Инициализация MCP
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 3. Запрос каталога инструментов
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### 8.2. Установка радостной эмоции
```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 10,
    "method": "tools/call",
    "params": {
      "name": "vessel_set_emotion",
      "arguments": {
        "emotion": "happy",
        "intensity": 1.0
      }
    }
  }'
```

### 8.3. Запуск жеста взмаха рукой (wave)
```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 11,
    "method": "tools/call",
    "params": {
      "name": "vessel_play_gesture",
      "arguments": {
        "gesture": "wave"
      }
    }
  }'
```

### 8.4. Опрос завершения действия
```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 12,
    "method": "tools/call",
    "params": {
      "name": "vessel_get_action_status",
      "arguments": {
        "command_id": "<COMMAND_ID_ИЗ_ПРЕДЫДУЩЕГО_ОТВЕТА>"
      }
    }
  }'
```

---

## 9. Подключение клиента

Укажите HTTP-эндпоинт `http://127.0.0.1:8765/mcp` в MCP-клиенте.
При заданном `VESSEL_AUTH_TOKEN` передавайте заголовок
`Authorization: Bearer <token>`. Формат настроек зависит от клиента.
Для проверки реализации VESSEL используйте `pnpm check:mcp`.

---

## 10. Диагностика и отладка

1. **Проверка жизнеспособности сервиса (`/health`):**
   ```bash
   curl http://127.0.0.1:8765/health
   ```
   Должно возвращать:
   ```json
   {
     "service": "VESSEL",
     "version": "0.1.0",
     "status": "online",
     "renderer_connected": true,
     "model_ready": true,
     "active_command_count": 0
   }
   ```
2. **Если `model_ready: false`:**
   * Откройте окно оверлея и выберите корректный VRM-файл кнопкой **Choose VRM…**.
3. **Отправка команд из CLI (быстрый тест через встроенный скрипт):**
   ```bash
   pnpm send gesture wave
   pnpm send emotion happy 1.0
   pnpm send framing face
   ```

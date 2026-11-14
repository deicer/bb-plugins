---
name: api-models
description: Use when the user asks to connect, list, or configure pi models from API addresses through the «Api модели» BB plugin panel.
---

# Api модели (clirelay-test)

Панель bb «Api модели» управляет кастомными провайдерами pi в `~/.pi/agent/models.json`.

- Раскладка: две вкладки. «Аккаунты» — карточки квот аккаунтов relay (бары остатка с % и сбросом, бейджи план/провайдер/Success Rate/restriction), данные `GET {origin}/v0/management/ai-accounts/status`; доступ — логин/пароль админки relay в secret-настройках `managementUser`/`managementPassword` (плагин сам логинится и продлевает сессию). «Подключение» — аккордеон на API-адрес → слева доступные модели (`GET {baseUrl}/models`, минус подключённые), справа подключённые; аккордеон модели → форма настроек. Несколько провайдеров на одном адресе → вложенная группа адреса.
- Конфиг: креды админки per-URL — кнопка «Креды» у группы адреса (диалог); глобальный fallback — `bb plugin config clirelay-test set managementUser <логин>` / `set managementPassword <пароль>` (+ reload); путь к файлу pi — `set modelsPath <путь>`, дефолт `~/.pi/agent/models.json`.
- RPC: `providers_list`, `provider_save`, `provider_delete`, `models_discover`, `model_connect`, `model_disconnect`, `model_update`, `model_toggle` (вкл/выкл: выключенные записи с настройками живут в kv `disabled-models:<providerId>`, pi видит только включённые), `model_test` (минимальный chat-запрос, латентность + ответ; только `openai-completions`, таймаут 30с), `relay_accounts` (квоты аккаунтов relay; без кредов → `configured:false`; `disabled`/`auth_name` мержатся из `GET /auth-files`, у shared-аккаунтов `disabled` из `health_status`), `relay_account_toggle` (вкл/выкл аккаунта: `PATCH /auth-files/status {name, disabled}`), `relay_creds_set` / `relay_creds_clear` (креды админки per-origin в server-side kv).
- UI: группировки по семейству модели в обеих колонках «Подключения»; фильтр Все/Вкл/Выкл; на «Аккаунтах» — сворачиваемые секции провайдеров, фильтры по состоянию и провайдеру, тумблеры аккаунтов; лейблы квот на русском (`lib/quota-labels.ts`); автозагрузка списков без ретраев после ошибки (`lib/auto-load.ts`).
- v1 поля модели: `name`, `reasoning`, `contextWindow`, `maxTokens`, `input`. Остальные поля файла сохраняются нетронутыми.
- pi подхватывает изменения при открытии `/model`.
- Секретность: ключи и адреса живут только в `models.json` вне репо, креды админки — в secret-настройках плагина, сессии — в server-side kv; не коммитить и не логировать их. `apiKey` фронтенду не возвращается.
- Ограничения: ключи `!command` не резолвятся для discovery; таргет только pi.
- Тестовый шов: `PI_MODELS_PATH` переопределяет путь к файлу (используется в тестах).

# Плагины BB от deicer

Публичная подборка плагинов BB, которые я поддерживаю или существенно доработал.

## Что здесь есть

### `session-history`

Единый список сессий разных агентов:

- Claude Code, Codex, Qwen, Pi и Command Code;
- сессии с подключённых компьютеров;
- группировка по папкам, в которых работал агент;
- быстрый показ ранее найденных сессий из кеша;
- фоновый поиск новых сессий;
- удаление отдельной сессии или всех сессий папки с подтверждением;
- открытие сессии для продолжения работы.

[Подробная документация session-history](plugins/session-history/README.md)

### `file-manager-multi-host`

Файловый менеджер для работы с файлами на разных подключённых компьютерах BB. Позволяет просматривать каталоги, открывать и скачивать файлы, загружать файлы на выбранный компьютер и выполнять основные операции с архивами.

[Подробная документация file-manager-multi-host](plugins/file-manager-multi-host/README.md)

### `kanban-board`

Доска для организации потоков BB по этапам работы. Потоки можно раскладывать по колонкам и перемещать между ними, чтобы видеть текущие задачи и их состояние.

[Подробная документация kanban-board](plugins/kanban-board/README.md)

### `clirelay-test` («Api модели»)

Панель для лёгкого подключения моделей с API-адресов в [pi](https://pi.dev). Источник истины — `~/.pi/agent/models.json` pi; плагин читает и правит его напрямую, pi подхватывает изменения при открытии `/model`.

- иконка «Api модели» в левом рейле → панель с аккордеонами API-адресов;
- несколько провайдеров на одном адресе показываются вложенно под общей группой адреса;
- внутри адреса слева — доступные модели (`GET {baseUrl}/models` минус уже подключённые) и ручное добавление по id, справа — подключённые;
- аккордеон подключённой модели → форма настроек по типам полей pi (`name`, `reasoning` bool, `contextWindow`/`maxTokens` int, `input` multiselect); неизвестные поля файла сохраняются;
- кнопка «Тест» у модели: минимальный реальный запрос (`POST /chat/completions`, `max_tokens: 8`, таймаут 30с) → латентность и кусочек ответа в тосте; ошибки санитизируются (v1: только `openai-completions`);
- путь к файлу pi конфигурируется: `bb plugin config clirelay-test set modelsPath <путь>` + `bb plugin reload clirelay-test`;
- запись атомарная (tmp + rename) с ротацией `.bak`; ключи и адреса живут только в `models.json` вне репо и никогда не возвращаются фронтенду целиком.

[Подробная документация clirelay-test](plugins/clirelay-test/README.md)

### `usage-rings`

Остатки лимитов провайдеров над кнопкой настроек: кольца с иконками, 5-часовой лимит или недельный, включение провайдеров и сортировка списка.

[Подробная документация usage-rings](plugins/usage-rings/README.md)

### `ru`

Русская локализация интерфейса BB и связанные с ней переводы. Плагин нужен, если вы хотите пользоваться основными экранами BB на русском языке.

[Подробная документация ru](plugins/ru/README.md)

## Установка

Для установки одного плагина выполните команду в терминале:

```powershell
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --plugin session-history
```

Вместо `session-history` можно указать другой идентификатор:

```text
clirelay-test
file-manager-multi-host
kanban-board
ru
```

Например, установить файловый менеджер:

```powershell
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --plugin file-manager-multi-host
```

Также можно установить плагин напрямую из его каталога:

```powershell
bb plugin install git:https://github.com/deicer/bb-plugins.git@main --subdirectory plugins/session-history
```

После установки BB сам соберёт плагин и подключит его. Обновить установленный плагин можно командой:

```powershell
bb plugin update session-history
```

## Важно

В репозитории хранятся исходники и документация. Кеши сессий, базы данных, `node_modules`, каталоги сборки и личные данные в него не входят.

## Репозиторий

[github.com/deicer/bb-plugins](https://github.com/deicer/bb-plugins)

# CLI для ИИ-агентов

`eaw-hub.cmd` входит в клиентский пакет Windows. Из исходников можно запустить `node apps/agent/src/cli.mjs`. Для чтения совместных документов и отправки предложений нужен Desktop Agent и сервер из сборки с поддержкой CLI.

## Доступ

1. Войдите в Desktop Agent, запустите его и откройте **Доступ CLI**.
2. Выберите режим и нажмите **Применить**. По умолчанию CLI выключен. **Только чтение** открывает поиск, текст, обсуждения, брони, тикеты и историю. **Чтение и изменения** также позволяет отправлять предложения правок, создавать обсуждения, отвечать и бронировать ключи на себя.
3. Укажите имя агента и срок. Нажмите **Выдать доступ** и **Скопировать токен**. Передайте значение через секрет `EAW_HUB_CLI_TOKEN` в окружении процесса либо через локальный файл с `--token-file PATH`. Храните такой файл вне Git.

В том же окне можно отозвать отдельное разрешение. При переключении на чтение выданные токены теряют право изменения. Для разрешения изменений после обратного переключения выдайте новый токен. Выключение CLI отзывает все токены. Сам выбор режима сохраняется после перезапуска Desktop Agent.

Токен привязан к открытому аккаунту и репозиторию Desktop Agent и действует 15, 60 или 240 минут. Выход из аккаунта или остановка Agent прекращает действие токена. Права и авторство операций определяет сервер хаба.

## Команды

Примеры для PowerShell из каталога клиента. Пути после `--file` отсчитываются от репозитория, настроенного в Desktop Agent.

```powershell
.\eaw-hub.cmd status --json
.\eaw-hub.cmd search --key FOCUS_NAME --lang ru --json
.\eaw-hub.cmd read --file localisation/russian/region_l_russian.yml --key FOCUS_NAME --json
.\eaw-hub.cmd discussion list --file localisation/russian/region_l_russian.yml --key FOCUS_NAME --json
.\eaw-hub.cmd reservation list --file localisation/russian/region_l_russian.yml --json
.\eaw-hub.cmd ticket list --json
.\eaw-hub.cmd ticket read --id TICKET_ID --json
.\eaw-hub.cmd history list --file localisation/russian/region_l_russian.yml --json
.\eaw-hub.cmd history read --file localisation/russian/region_l_russian.yml --id VERSION_ID --json
.\eaw-hub.cmd suggestion preview --file localisation/russian/region_l_russian.yml --key FOCUS_NAME --text-file replacement.txt --json
.\eaw-hub.cmd suggestion submit --plan PLAN_ID --json
```

`search` ищет точные совпадения в локальном Git HEAD. Для актуального совместного текста используйте `read`. Без `--key` он возвращает целый файл. Для русского ключа `read` также пытается найти английский оригинал в Git или в базовом коммите тикета. Поле `english` равно `null`, если оригинал получить не удалось. Чтобы читать документ в контексте тикета, передайте `--ticket TICKET_ID`. Если совместная версия файла ещё не создана, `read` возвращает Git-версию ветки или базового коммита тикета с `revision: null`. Списки обсуждений, броней и истории в этом случае пусты.

`preview` возвращает `diff.before`, `diff.after`, `revision` и `planId`. План действителен до 15 минут в пределах срока разрешения. Если очередь предпросмотров заполняется, ранее отправленный план может быть удалён из неё раньше. `submit` сверяет ревизию на сервере и возвращает ID сохранённого предложения. Предложение появляется в Review. Если совместная версия ещё не создана, сначала откройте файл ветки или тикета в Review. Она нужна для предпросмотра предложения, комментариев, ответов и создания броней. Ключ с дубликатами или неоднозначными кавычками требует ручного выбора. Для одного значения используйте UTF-8 и литеральное `\n` для переноса внутри игры. Текст можно передать через `--text-file` или `--text-stdin`.

```powershell
.\eaw-hub.cmd discussion create --file localisation/russian/region_l_russian.yml --key FOCUS_NAME --revision SHA256 --text-file comment.txt --json
.\eaw-hub.cmd discussion reply --file localisation/russian/region_l_russian.yml --kind suggestion --id SUGGESTION_ID --text-file reply.txt --json
.\eaw-hub.cmd reservation create --file localisation/russian/region_l_russian.yml --key FOCUS_NAME --revision SHA256 --json
```

Используйте `--kind comment` для ответа на комментарий. Для создания обсуждения или брони подставьте `data.revision` из `read`. Создание брони закрепляет один ключ за вошедшим пользователем. Необязательное примечание можно передать одной строкой через `--text-file` или `--text-stdin`. Списки поддерживают `--offset` и `--limit`. Следующую страницу указывает `data.nextOffset`. Для каждого обсуждения выдаются до десяти последних видимых сообщений и их общее количество. Передайте `discussion list --id ID` вместе с путём к файлу, чтобы прочитать все видимые сообщения конкретного обсуждения.

## Контракт для автоматизации

- При успехе `--json` пишет один объект `{"ok":true,"data":{…}}` и возвращает код 0. Ошибка имеет вид `{"ok":false,"error":{"code":"…","message":"…"}}` и даёт ненулевой код выхода.
- `STALE_REVISION` означает, что нужно перечитать совместный документ и заново подготовить действие. `AMBIGUOUS_KEY` требует проверить файл и его совпадения. `CLI_DISABLED` означает, что CLI выключен в Desktop Agent. `READ_ONLY` означает, что токен разрешает чтение. `GRANT_REQUIRED` или `GRANT_REVOKED` требуют действующего разрешения.
- `WRITE_REJECTED` означает, что сервер отклонил операцию. Сначала устраните причину, указанную в сообщении.
- При `OUTCOME_UNKNOWN` или `WRITE_UNCONFIRMED` сохранение могло состояться. Повторите ту же отправку с тем же `--plan` либо тем же `--request-id`. Для новых обсуждений, ответов и броней лучше заранее генерировать случайный UUID и задавать `--request-id`, чтобы его можно было повторить даже после прерывания процесса. Повтор должен содержать тот же текст и тот же путь. Если план больше недоступен, сначала проверьте список предложений по его ID.
- Принятие предложения и изменение общего текста выполняются пользователем в Review.

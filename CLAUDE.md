# rescade

Надстройка над restic: каскады команд по расписанию, YAML-конфиги, демон с API, CLI и (позже) веб-интерфейс.
Автор общается по-русски; код, идентификаторы и сообщения об ошибках в проекте на английском.

Полный дизайн и все принятые решения: @docs/DESIGN.md. Не пересматривай их без явной просьбы, а если находишь
противоречие или дыру, скажи об этом и предложи вариант.

## Статус

Готово: монорепо, `packages/core`: загрузчик конфигов (`src/config`: разбор по файлам, слияние по имени, `${VAR}`,
схема zod, перекрёстные проверки, диагностика `файл:строка:колонка`), адаптер restic (`src/restic`: запуск процессов
с группой и SIGTERM→SIGKILL, аргументы и окружение, ensure/init по кодам выхода), исполнитель одного каскада
(`src/run/cascade.ts`: события, статусы шагов, код 3 как `warning`, сверка `chunker_polynomial` перед `copy`, отмена
через `AbortSignal`), мьютексы репо (`src/run/locks.ts`, берутся вокруг шага через `RunOptions.lock`),
оркестратор (`src/run/runner.ts`: `on-busy`, без самоналожения каскада, статусы `queued`/`running`, запись в хранилище,
события), планировщик (`src/schedule.ts`, croner), хранилище (`src/store/store.ts`, `node:sqlite`).
Прогрев репо при старте (`src/restic/warmup.ts`), проверка версии restic (`src/restic/version.ts`, предупреждение
в `rescaded` и `run --local`), чтение токена (`src/token.ts`).
`packages/daemon`: `rescaded` (`settings.ts` флаги/env/токен/Host, `server.ts` Fastify-маршруты и SSE, `daemon.ts` запуск,
SIGHUP, остановка с `interrupted`, чистка истории раз в час, `repos.ts` состояние репо в памяти, `schemas.ts` схемы
ответов для сериализации и `GET /api/openapi.json` и Swagger UI на `/api/docs` без токена; копия в `docs/openapi.json`;
API под `/api`, остальные пути отдают собранный веб-интерфейс с fallback на `index.html`). Срок хранения истории
и логов `Store.prune`, локи restic `src/restic/lockfiles.ts` (читаются в ensure перед каждым шагом). `packages/cli`: `validate`, `run --local`, а через
демон `run [--detach]`, `status`, `runs`, `show`, `log`, `cancel`, `repos`, `snapshots`, `ls`, `restore` (`client.ts` HTTP и SSE, `remote.ts` команды).
`packages/web`: веб-интерфейс (React, TanStack Query, Tailwind 4, Vite, `wouter`; `api.ts`/`token.ts` запросы и токен,
`sse.ts` поток событий через fetch, `queries.ts` хуки и `applyEvent`, `log.ts` склейка лога по `id`, `groups.ts` и `components/Group.tsx` группы по полю `group` у репо и каскадов (свёрнутые помнятся в `localStorage`, `collapsed.ts`), `pages/*`), демон
находит его сборку через `import.meta.resolve("@rescade/web/package.json")`.
Просмотр снапшотов (`src/restic/snapshots.ts`: `restic snapshots`/`ls` без мьютекса, `--retry-lock 10s`; маршруты
`/api/repos/:name/snapshots[/:id/ls]`, CLI `snapshots` и `ls`, страница репо `pages/Repo.tsx` (состояние и снапшоты, ссылка с имени на `/repos`),
снапшот деревом `components/SnapshotTree.tsx` (`@headless-tree`, подгрузка каталога при раскрытии, чекбоксы для restore, логика выбора в `selection.ts`); у шага backup поле
`repo`, схема базы v2 с миграцией в `Store.open`). Бэкенды restic (`src/config/backends.ts`: префикс `path`, опции по бэкенду, конфликты `env`/`options` в парах
`copy`/`from`; описание в `docs/backends.md`). 318 тестов vitest (проекты `node` и `web`), фейковый restic в `packages/core/test/fake-restic.mjs`, 9 интеграционных с настоящим restic
(проверено на 0.19.1), пример в `examples/config`.

Шаги 1–7 из DESIGN.md сделаны. Шаг 8: `Dockerfile`, `.github/workflows/ci.yaml` (тесты, затем образ
в `ghcr.io/artss/rescade` для amd64/arm64), пример `examples/docker`. Виджет для homepage: `GET /api/summary` (плоские счётчики для `customapi`), конфиг в README.
Лицензия Apache-2.0 (`LICENSE`, `NOTICE` со ссылкой на репо, в образе в `/usr/share/licenses/` вместе с лицензией restic).
Отложено: экран логов демона, веб-редактор конфига.

Шаг 9 (восстановление): просмотр снапшотов и restore в ядре, API и CLI сделаны (`runRestore`/`restoreStep` в
`src/run/cascade.ts`, `Runner.restore`, запуск без `cascade` с полем `restore`, схема базы v3, `--restore-dir` /
`RESCADE_RESTORE_DIR` у демона, `POST /api/repos/:name/snapshots/:id/restore`, CLI `restore`, в вебе чекбоксы
в дереве снапшота и кнопка Restore; каталог восстановления в `GET /api/status` как `restoreDir`).

Повтор с проваленного шага (см. DESIGN.md): `rerunFrom` и `Runner.rerun` (`src/run/runner.ts`), `fromStep` в `runCascade`,
схема базы v4 (`rerun_of`, `from_step`), `POST /api/runs/:id/rerun`, CLI `rerun`, кнопка Rerun from failed на странице запуска
(`canRerun` в `queries.ts`; проверку меток шагов делает только демон), на карточке каскада после `failed`/`cancelled`/`interrupted`
она же вместо Run и под ней ссылка Run from start (`canRerunLast`: шагов последнего запуска у карточки нет, поэтому без `skipped`).

Перезагрузка конфига без перезапуска: SIGHUP, `POST /api/reload` (200 с `{ at, ok, errors }`, перезагрузки
по одной), CLI `reload`, пункт Reload config в меню шапки веба (`HeaderMenu` в `Layout.tsx`, там же Sign out; версия демона и ссылка на GitHub в футере).

Уведомления в Telegram (см. DESIGN.md): секция `notifications` в YAML (схема в `config/schema.ts`, ссылки на каскады
в `semantic.ts`), `packages/daemon/src/notify.ts` (`Notifier`: подписчик на `Runner`, проверки репо, итоги reload,
очередь на уведомление с повторами), `Store.previousOutcome` для `recovered`, `markInterrupted` возвращает записи,
`RESCADE_PUBLIC_URL` для ссылок, `POST /api/notifications/:name/test`, CLI `notify-test`. В тестах фейковый Bot API
`packages/daemon/test/telegram.ts`, адрес через `DaemonOptions.telegramApi`.

Страницы истории: `offset` и `Store.countRuns`, у `GET /api/runs` заголовок `X-Total-Count` (открыт для CORS),
в вебе `?page=` в URL и переключатель Newer/Older в `pages/Runs.tsx` (`paging.ts`).

Проверено на Linux: `pnpm test:integration` (restic 0.19.1 с релиза), образ с bind mount настоящих каталогов
под `/host` (backup файлов только для root, родительский снапшот при повторе, `copy` с `from`, restore со снятием префикса,
SIGHUP, `interrupted` после `docker stop` и после `kill -9`). Релиз из CI: тег `v0.1.0`, публичный образ
`ghcr.io/artss/rescade:0.1.0` для amd64 и arm64, `rescade --version` в нём `0.1.0`.

## Команды

    pnpm install
    pnpm test                # vitest, все пакеты (с фейковым restic)
    pnpm test:integration    # с настоящим restic ($RESCADE_RESTIC или из PATH), ~30 с
    pnpm build               # сборка (project references, потом vite для web), нужна перед запуском CLI
    pnpm --filter @rescade/web dev   # UI на vite с прокси /api на демон ($RESCADE_URL)
    pnpm validate:example    # собирает и валидирует examples/config
    pnpm vitest run -u packages/daemon/test/server.test.ts   # обновить docs/openapi.json после смены API

## Соглашения

- TypeScript строгий (`strict`, `noUncheckedIndexedAccess`), ESM, `module: NodeNext`: импорты с расширением `.js`.
- В `tsconfig.base.json` явно `"types": ["node"]` (в TypeScript 7 типы Node по умолчанию не подключаются).
- Node >= 26 (текущая LTS, проверялось на 26.13): `node:sqlite` без флага и без ExperimentalWarning. `.nvmrc` = `26`, `engineStrict` в
  `pnpm-workspace.yaml` (проверяет только `pnpm install`, не `pnpm test`). Зависимости: `yaml`, `zod` (v4), `croner`, в CLI и web `date-fns` (`formatTime`), в web `@headless-tree/core` и `/react`, иконки `@mdi/js` (компонент `Icon`); тесты `vitest`.
- Ядро (`core`) без сетевого кода и без обращений к `process` вне CLI/демона. Внешние процессы запускать
  через `spawn` без shell, секреты передавать через окружение процесса, а не через аргументы.
- Ошибки конфигурации всегда с позицией (файл, строка, колонка). Одна проверка выдаёт как можно больше ошибок за прогон.
- Тесты демона, CLI и web берут ядро из исходников: в vitest алиас `@rescade/core` → `packages/core/src`, а CLI в сквозных
  тестах запускается как `node --conditions=source --import tsx` (условие `source` в `exports` ядра).
- `web` берёт из ядра только типы (`import type`): значение из `@rescade/core` притащило бы в бандл Node-код.
  У `web` свой tsconfig (`Bundler`, DOM, `noEmit`), не в project references; тесты демона в нём подключаются
  относительным путём, а не зависимостью (демон сам зависит от `@rescade/web`, был бы цикл).
- Каждое новое поведение сопровождается тестом; для исполнителя нужен фейковый restic, а не настоящий.
- Без лишних зависимостей и без абстракций «на вырост»: проект маленький, решения должны оставаться простыми.
- Сообщения коммитов по commitlint (`@commitlint/config-conventional`): `type(scope)?: subject`, тип из `feat`, `fix`,
  `refactor`, `test`, `docs`, `chore`, `build`, `ci`, `perf`, `style`, `revert`; subject со строчной буквы, без точки
  в конце, заголовок до 100 символов, тело через пустую строку. Работа ведётся в ветках, в `main` через PR.

## Ловушки, на которые уже наступали

- Неквотированный `**/venv` в YAML читается как alias (`yaml` бросает `ReferenceError` при `toJS()`), поэтому алиасы
  проверяются заранее через `visit`. В `{}` и `[]` ссылка `${VAR}` требует кавычек.
- `true`, `123` в списке `command` YAML читает как boolean и число; сообщение об ошибке подсказывает про кавычки.
- Нужен restic >= 0.17 (о старом предупреждают `rescaded` и `run --local`; в Ubuntu 24.04 из apt 0.16.4): только
  с него «репо нет» = код 10 и «неверный пароль» = код 12. На старом restic отсутствующий репо даёт код 1 и считается `unreachable`, то есть init не произойдёт (безопасно, но молча не работает).
- С `--json` ошибки restic в stderr тоже JSON, последняя строка `{"message_type":"exit_error",...}`; для лога и причины
  отказа они переводятся в текст (`readableBackupLine`).
- Недоступный REST/S3-бэкенд restic ретраит минутами (`cat config` на закрытый порт не закончился за 2 минуты),
  sftp на несуществующий хост падает сразу с кодом 1. Поэтому у `cat config` таймаут (`repoCheckTimeoutMs`).
- После SIGTERM restic дописывает в stderr шум (`signal terminated received`, `context canceled`, адрес репо);
  для причины таймаута берётся `stderrBeforeStop`, последняя строка до сигнала.
- На macOS дочерний процесс всегда получает `__CF_USER_TEXT_ENCODING`, даже с пустым `env`; тесты на окружение его отфильтровывают.
- `runProcess` убивает группу процессов (`process.kill(-pid)`, `detached: true`): иначе внуки шелла держат пайпы
  открытыми и `close` не приходит. Это единственное обращение к `process` в ядре, осознанное.
- `fetch` в Node отказывается ходить на «плохие» порты (1, 9 и др.) с `bad port`; в тестах на «нет связи» брать свободный порт.
- Разрешённые `Host` считаются после `listen`: при `port: 0` настоящий порт известен только тогда.
- Локи читаются с `--no-lock`, чтобы не оставлять своих; короткий id `restic cat lock` не принимает, нужен полный (64 hex).
- `fake.trace()` не показывает чтение локов (`list`, `cat lock`), чтобы старые проверки последовательностей вызовов не менялись.
- `path` вида `host:dir` без известного префикса restic 0.19 отвергает (`invalid backend`, подсказывает `local:`), а опции
  чужого бэкенда (`-o s3.region` у sftp) молча игнорирует; неизвестная опция своего бэкенда = `Fatal`.
- `copy` и `init --from-repo` идут одним процессом: свои переменные у источника только `RESTIC_FROM_REPOSITORY*`/`PASSWORD*`,
  ключи бэкенда (`AWS_*` и т. п.) и `-o` общие на оба репо.
- Fastify сериализует ответ по схеме маршрута и молча выбрасывает поля, которых в схеме нет. Новое поле в
  `RunRecord`/`StepRecord`/`RepoView` и т. п. надо добавить в `schemas.ts`, иначе клиент его не увидит; `server.test.ts`
  сверяет ответы на полностью заполненных записях с тем, что вернул обработчик.
- `@fastify/swagger` видит только маршруты, объявленные после его загрузки, поэтому `buildServer` асинхронная
  (`await app.register(swagger)` до маршрутов).
- `@fastify/static` 10 передаёт в `setHeaders` `reply`, а не `res`. Его wildcard-маршрут ловит и неизвестные `/api/...`,
  поэтому токен проверяется и по маршруту, и по пути. `inject` читает `//api/...` как URL с хостом `api`.
- В lib.dom `pipeThrough(new TextDecoderStream())` не сходится по типам с `ReadableStream<Uint8Array>`, поэтому поток
  событий декодируется `TextDecoder` вручную. `ReadableStream` не везде async-итерируем, читаем через `getReader`.
- Ответ 401 сбрасывает токен, только если он тот же, с которым ушёл запрос: иначе поздние 401 от неверного токена
  стирали только что введённый верный.
- happy-dom в тестах печатает `socket hang up` при отмене fetch (SSE при уходе со страницы), это не ошибка.
- `tsc` не ставит бит исполнения на `dist/*.js`: в образе `rescaded`/`rescade` — обёртки на `sh`.
- В Node 26 нет встроенного corepack: в `Dockerfile` он ставится через `npm install -g corepack@<версия>`
  (pnpm потом берётся из `packageManager`); в CI pnpm ставит `pnpm/action-setup`.
- Версию в `package.json` не править: там всегда `0.0.0-dev`, настоящая — из git-тега, её вписывает
  `scripts/version.mjs set` в `Dockerfile`. Тег, запушенный с `GITHUB_TOKEN`, других workflow не запускает,
  поэтому образ собирается до тега в том же job, а не по тегу. `docs/openapi.json` поэтому тоже с `0.0.0-dev`.
- `actions/setup-node@v5` сам включает кэш по `packageManager` из `package.json` и ищет pnpm; в джобе без
  `pnpm/action-setup` нужен `package-manager-cache: false`.
- `pnpm deploy` копирует пакет целиком, если нет `files`; у всех пакетов `"files": ["dist"]`. Зависимости `web`
  (React и т. п.) в `devDependencies`: в рантайме нужен только собранный `dist`.
- Стадии сборки в `Dockerfile` идут на `$BUILDPLATFORM`: результат — JS без нативных модулей, restic качается под
  `TARGETARCH`; эмуляция arm64 нужна только для `apk add` последней стадии. При смене версии restic обновить обе суммы.
- На Docker Desktop для macOS restic не читает файлы с bind mount (ФС `fakeowner`): после `open` он включает
  `O_NOATIME` через `fcntl(F_SETFL)`, и `read` даёт `EIO` (`cat` и `open(..., O_NOATIME)` при этом работают).
  Проверять образ там на именованных томах; на Linux-хосте bind mount обычный.
- `RESTIC_HOST` в окружении restic — не только имя для `backup`, но и фильтр по умолчанию в `forget`, `copy`, `check`,
  `snapshots` (restic 0.19.1). Имя хоста в контейнере фиксируется `hostname:` в compose, а не этой переменной.
- sftp на хост не из `known_hosts`: ssh без терминала (дочерние процессы в своей сессии) пишет `Host key verification
  failed.`, restic передаёт это строкой `subprocess ssh: ...` и падает с кодом 1 и `unexpected EOF`. Причину собирает
  `failureReason` (`restic.ts`): последняя строка плюс последнее слово ssh/rclone. В образе поэтому `accept-new`,
  `known_hosts` в томе `/var/lib/rescade` (в `/root/.ssh` он пропадал бы при пересоздании контейнера).
- Смонтированный `/root/.ssh` сохраняет uid с хоста: `config` не от root ssh отвергает (`Bad owner or permissions`),
  ключ от root с правами шире 600 игнорирует, ключ чужого uid не проверяет вовсе (проверено на OpenSSH 10.3 в образе).
- `restic ls <id> <path>` на отсутствующий путь ничего не выводит и выходит с 0; каталог сам идёт первой строкой узлов
  (кроме `/`), по этому и отличаем «нет пути» от пустого каталога. Неизвестный id: код 1, `no matching ID found`.
- Схема SQLite меняется через `MIGRATIONS` в `store.ts` (ключ = версия, с которой обновляем) и `SCHEMA_VERSION`;
  `SCHEMA` всегда описывает последнюю версию для новой базы.
- `date-fns` импортируется по подпутям (`date-fns/format`): индекс пакета грузит все функции, это ~1 с на каждый запуск
  CLI, и сквозные тесты CLI упирались в таймаут.
- `restic restore --include` на путь, которого нет в снапшоте, выходит с 0 и ничего не восстанавливает; поэтому
  `files_restored + files_skipped` = 0 при заданных путях считается `failed`. Ошибки записи — строки `error` и код 1.
- Fastify (ajv с `removeAdditional`) молча выкидывает лишние поля тела при `additionalProperties: false`, а не
  отвечает 400. POST без тела валидируется как `undefined` («body must be object»), поэтому у restore `preValidation`
  подставляет `{}`.
- headless-tree (1.8): если `getChildrenWithData` бросает, каталог навсегда остаётся «загружается» (а `expand` при загрузке
  ничего не делает), поэтому загрузчик ловит ошибку и отдаёт строку-заметку с Retry (`invalidateChildrenIds`). Встроенный
  `checkboxesFeature` с `propagateCheckedState` при отметке каталога рекурсивно грузит всё поддерево; выбор свой.
  Клик по строке (`getProps().onClick`) раскрывает каталог, поэтому у чекбокса `stopPropagation`.
- В режиме `--allow-missing-env` значения подменяются на `<NAME is unset>`: годится для валидации, не для запуска
  (список в `LoadResult.missingEnv`).
- Токен Telegram стоит в URL Bot API (`/bot<token>/sendMessage`): ошибку `fetch` описываем по `cause.code`, а не
  целиком, и URL в лог не пишем. Очереди уведомлений свои у каждого, поэтому порядок сообщений гарантирован только
  внутри одного уведомления.

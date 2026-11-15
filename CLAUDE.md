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
Прогрев репо при старте (`src/restic/warmup.ts`), чтение токена (`src/token.ts`).
`packages/daemon`: `rescaded` (`settings.ts` флаги/env/токен/Host, `server.ts` Fastify-маршруты и SSE, `daemon.ts` запуск,
SIGHUP, остановка с `interrupted`, чистка истории раз в час, `repos.ts` состояние репо в памяти, `schemas.ts` схемы
ответов для сериализации и `GET /api/openapi.json` и Swagger UI на `/api/docs` без токена; копия в `docs/openapi.json`;
API под `/api`, остальные пути отдают собранный веб-интерфейс с fallback на `index.html`). Срок хранения истории
и логов `Store.prune`, локи restic `src/restic/lockfiles.ts` (читаются в ensure перед каждым шагом). `packages/cli`: `validate`, `run --local`, а через
демон `run [--detach]`, `status`, `runs`, `show`, `log`, `cancel`, `repos` (`client.ts` HTTP и SSE, `remote.ts` команды).
`packages/web`: веб-интерфейс (React, TanStack Query, Tailwind 4, Vite, `wouter`; `api.ts`/`token.ts` запросы и токен,
`sse.ts` поток событий через fetch, `queries.ts` хуки и `applyEvent`, `log.ts` склейка лога по `id`, `pages/*`), демон
находит его сборку через `import.meta.resolve("@rescade/web/package.json")`.
Бэкенды restic (`src/config/backends.ts`: префикс `path`, опции по бэкенду, конфликты `env`/`options` в парах
`copy`/`from`; описание в `docs/backends.md`). 191 тест vitest (проекты `node` и `web`), фейковый restic в `packages/core/test/fake-restic.mjs`, 7 интеграционных с настоящим restic
(проверено на 0.19.1), пример в `examples/config`.

Шаги 1–7 из DESIGN.md сделаны. Отложено: экран логов демона, уведомления, веб-редактор конфига.

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
- Node >= 22.13 (проверялось на 22.23): нужен `node:sqlite` без флага. Зависимости: `yaml`, `zod` (v4), `croner`; тесты `vitest`.
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
- Нужен restic >= 0.17: только с него «репо нет» = код 10 и «неверный пароль» = код 12. На старом restic отсутствующий
  репо даёт код 1 и считается `unreachable`, то есть init не произойдёт (безопасно, но молча не работает).
- С `--json` ошибки restic в stderr тоже JSON, последняя строка `{"message_type":"exit_error",...}`; для лога и причины
  отказа они переводятся в текст (`readableBackupLine`).
- Недоступный REST/S3-бэкенд restic ретраит минутами (`cat config` на закрытый порт не закончился за 2 минуты),
  sftp на несуществующий хост падает сразу с кодом 1. Поэтому у `cat config` таймаут (`repoCheckTimeoutMs`).
- После SIGTERM restic дописывает в stderr шум (`signal terminated received`, `context canceled`, адрес репо);
  для причины таймаута берётся `stderrBeforeStop`, последняя строка до сигнала.
- На macOS дочерний процесс всегда получает `__CF_USER_TEXT_ENCODING`, даже с пустым `env`; тесты на окружение его отфильтровывают.
- `runProcess` убивает группу процессов (`process.kill(-pid)`, `detached: true`): иначе внуки шелла держат пайпы
  открытыми и `close` не приходит. Это единственное обращение к `process` в ядре, осознанное.
- `node:sqlite` на Node 22 при загрузке печатает ExperimentalWarning, поэтому `Store.open` грузит его динамически:
  `validate` и `run --local` его не видят. В тестах предупреждение видно, это нормально.
- Бинарник демона начинается с `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning`, иначе первая строка
  каждого лога была бы предупреждением `node:sqlite`. `tsc` не ставит бит исполнения на `dist/*.js`.
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
- В режиме `--allow-missing-env` значения подменяются на `<NAME is unset>`: годится для валидации, не для запуска
  (список в `LoadResult.missingEnv`).

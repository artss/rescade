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
`packages/cli`: `rescade validate`, `rescade run --local <cascade>`. 116 тестов vitest, фейковый
restic в `packages/core/test/fake-restic.mjs`, 6 интеграционных с настоящим restic (проверено на 0.19.1), пример в `examples/config`.

Следующий шаг (4): демон (связать `Runner`, `Scheduler`, `Store`, SIGHUP → `setConfig` + `update`), HTTP API, CLI-клиент.

## Команды

    pnpm install
    pnpm test                # vitest, все пакеты (с фейковым restic)
    pnpm test:integration    # с настоящим restic ($RESCADE_RESTIC или из PATH), ~30 с
    pnpm build               # сборка (project references), нужна перед запуском CLI
    pnpm validate:example    # собирает и валидирует examples/config

## Соглашения

- TypeScript строгий (`strict`, `noUncheckedIndexedAccess`), ESM, `module: NodeNext`: импорты с расширением `.js`.
- В `tsconfig.base.json` явно `"types": ["node"]` (в TypeScript 7 типы Node по умолчанию не подключаются).
- Node >= 22.13 (проверялось на 22.23): нужен `node:sqlite` без флага. Зависимости: `yaml`, `zod` (v4), `croner`; тесты `vitest`.
- Ядро (`core`) без сетевого кода и без обращений к `process` вне CLI/демона. Внешние процессы запускать
  через `spawn` без shell, секреты передавать через окружение процесса, а не через аргументы.
- Ошибки конфигурации всегда с позицией (файл, строка, колонка). Одна проверка выдаёт как можно больше ошибок за прогон.
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
- В режиме `--allow-missing-env` значения подменяются на `<NAME is unset>`: годится для валидации, не для запуска
  (список в `LoadResult.missingEnv`).

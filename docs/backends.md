# Бэкенды restic и аутентификация

rescade не знает протоколов: всё, что нужно restic, задаётся в репо тремя полями.

| Поле       | Как попадает в restic                                                        |
|------------|------------------------------------------------------------------------------|
| `path`     | `RESTIC_REPOSITORY` (для источника `copy` и `from` это `RESTIC_FROM_REPOSITORY`) |
| `password` | `RESTIC_PASSWORD` (`RESTIC_FROM_PASSWORD`)                                   |
| `env`      | переменные процесса restic поверх окружения демона                           |
| `options`  | `-o ключ=значение`                                                           |

Секреты в YAML не пишутся. Значение берётся из окружения демона через `${VAR}`, а файлы (ключи ssh,
JSON сервисного аккаунта, сертификаты) указываются путём. В systemd окружение удобно задавать так:

    [Service]
    EnvironmentFile=/etc/rescade/secrets.env    # chmod 600, владелец root

Переменные, которые задаёт сам rescade (`RESTIC_REPOSITORY*`, `RESTIC_PASSWORD*` и их `FROM_`-варианты),
в `env` репо запрещены. Из окружения демона они не передаются.

## По бэкендам

Список опций сверен с `restic options` (0.19.1). У всех бэкендов есть `<backend>.connections`.

### local

`path: /srv/restic/system`. Аутентификации нет, доступ решают права на каталог. Если в имени каталога есть
двоеточие, нужен префикс: `local:backups:2024`. Опции: `local.connections`.

### sftp

`sftp:user@host:/abs/path`, `sftp:host:relative/path`, `sftp://user@[::1]:2222//abs/path`, `sftp:alias:/path`
(alias из `~/.ssh/config`).

Аутентификация только по ключу без пароля: restic запускает `ssh`, запросить пароль некому. Ключ задаётся:

- в `~/.ssh/config` пользователя, от которого работает демон (обычно root: `/root/.ssh/config`):
  `Host i1.backups.lan` + `IdentityFile /etc/rescade/ssh/id_ed25519`, `User`, `Port`, `ServerAliveInterval`;
- либо опцией репо: `options: { sftp.args: "-i /etc/rescade/ssh/id_ed25519 -o BatchMode=yes" }`.

Хост должен быть заранее в `known_hosts`: иначе ssh спросит подтверждение и шаг упадёт. Переменных окружения
у бэкенда нет. Опции: `sftp.command` (своя команда целиком), `sftp.args`.

### rest (rest-server)

`rest:https://host:8000/`, `rest:https://user:pass@host:8000/repo/`, `rest:http+unix:///run/rest.sock:/repo/`.

Логин и пароль HTTP basic: в URL (`rest:https://backup:${REST_PASSWORD}@host:8000/repo/`) или через
`RESTIC_REST_USERNAME` / `RESTIC_REST_PASSWORD` в `env`. Лучше в URL: так они свои у каждого репо (см. «copy»
ниже). В `GET /api/repos` пароль из URL заменяется на `***`.

TLS: `RESTIC_CACERT` (свой CA или самоподписанный сертификат, системные CA тогда не используются),
`RESTIC_TLS_CLIENT_CERT` (клиентский сертификат и ключ в одном PEM).

### s3 (AWS, MinIO, Wasabi, Alibaba OSS, прочие S3-совместимые)

`s3:s3.eu-central-1.amazonaws.com/bucket/path`, `s3:https://minio.lan:9000/bucket`.

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, временные ключи плюс `AWS_SESSION_TOKEN`;
- `AWS_DEFAULT_REGION` или опция `s3.region` (для не-AWS по умолчанию `us-east-1`);
- `AWS_PROFILE` + `AWS_SHARED_CREDENTIALS_FILE`: профиль из файла ключей;
- без ключей restic пробует IAM-роль инстанса (EC2/ECS).

Опции: `s3.region`, `s3.bucket-lookup` (`auto|dns|path`; MinIO обычно `path`, OSS `dns`), `s3.storage-class`,
`s3.list-objects-v1`, `s3.retries`, `s3.unsafe-anonymous-auth`, `s3.enable-restore` и `s3.restore-*` (Glacier).

### swift (OpenStack)

`swift:container:/path`. Переменные те же, что в OpenStack RC-файле, по способу входа:

- Keystone v1: `ST_AUTH`, `ST_USER`, `ST_KEY`;
- v2: `OS_AUTH_URL`, `OS_REGION_NAME`, `OS_USERNAME`, `OS_PASSWORD`, `OS_TENANT_ID`, `OS_TENANT_NAME`;
- v3: `OS_AUTH_URL`, `OS_REGION_NAME`, `OS_USERNAME` или `OS_USER_ID`, `OS_PASSWORD`, `OS_USER_DOMAIN_NAME`
  или `OS_USER_DOMAIN_ID`, `OS_PROJECT_NAME`, `OS_PROJECT_DOMAIN_NAME` или `OS_PROJECT_DOMAIN_ID`, `OS_TRUST_ID`;
- application credential: `OS_AUTH_URL`, `OS_APPLICATION_CREDENTIAL_ID` + `OS_APPLICATION_CREDENTIAL_SECRET`
  (или `OS_USERNAME`, `OS_USER_DOMAIN_NAME`, `OS_APPLICATION_CREDENTIAL_NAME` + секрет);
- готовый токен: `OS_STORAGE_URL`, `OS_AUTH_TOKEN`.

Плюс `SWIFT_DEFAULT_CONTAINER_POLICY`. Опции: `swift.connections`.

### b2 (Backblaze)

`b2:bucket:path`. `B2_ACCOUNT_ID` (keyID) и `B2_ACCOUNT_KEY` (applicationKey); ключ может быть не мастер,
но с чтением и записью. Опции: `b2.connections`. Документация restic советует ходить в B2 через его S3 API
(бэкенд `s3`): у нативного хуже обработка ошибок.

### azure (Blob Storage)

`azure:container:/path`. `AZURE_ACCOUNT_NAME` и одно из:

- `AZURE_ACCOUNT_KEY`;
- `AZURE_ACCOUNT_SAS` (SAS-токен);
- ничего: тогда стандартная цепочка Azure (managed identity, workload identity, переменные сервисного
  аккаунта `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET`), а с `AZURE_FORCE_CLI_CREDENTIAL=true`
  вход через `az login`. Нужна роль Storage Blob Data Contributor.

`AZURE_ENDPOINT_SUFFIX` для облаков вне общего Azure. Опции: `azure.access-tier` (`Hot|Cool|Cold`).

### gs (Google Cloud Storage)

`gs:bucket:/path`. `GOOGLE_PROJECT_ID` и одно из:

- `GOOGLE_APPLICATION_CREDENTIALS`: путь к JSON-ключу сервисного аккаунта (файл с правами 600);
- ничего: сервисный аккаунт инстанса GCE;
- `GOOGLE_ACCESS_TOKEN`: короткоживущий токен (главнее остальных способов, нужен scope `devstorage.read_write`).
  Для расписания не подходит: протухнет.

Опции: `gs.region` (по умолчанию `us`, где создавать бакет).

### rclone (всё, что умеет rclone)

`rclone:remote:path`. restic запускает `rclone serve restic --stdio`, аутентификация целиком на стороне rclone:

- remote в `rclone.conf`; путь к нему `RCLONE_CONFIG` в `env` (иначе `~/.config/rclone/rclone.conf` пользователя
  демона), пароль от зашифрованного конфига `RCLONE_CONFIG_PASS`;
- или remote целиком из переменных, без файла: `RCLONE_CONFIG_<REMOTE>_TYPE`, `RCLONE_CONFIG_<REMOTE>_<KEY>`
  (имя remote в верхнем регистре). Так у каждого репо свой remote со своими ключами.

Опции: `rclone.program` (можно `ssh user@host rclone`), `rclone.args`, `rclone.timeout`. Для отладки
`RCLONE_VERBOSE`, ограничение полосы `RCLONE_BWLIMIT`.

## copy и `from`: один restic на два репо

`copy` и `init --from-repo` запускают один процесс restic. Отдельные переменные для источника есть только
у адреса и пароля (`RESTIC_FROM_*`), а ключи бэкенда и опции `-o` общие для обоих репо. rescade кладёт в
окружение `env` источника, поверх него `env` цели, поэтому при совпадении имён побеждает цель.

Остальные шаги (`backup`, `retain`, `prune`, `check`) запускают restic на одно репо, поэтому сколько угодно репо
одного бэкенда с разными ключами в конфиге не мешают друг другу. Ограничение касается только пар `copy`/`from`:

- репо на разных бэкендах (local → s3, sftp → b2) не мешают друг другу;
- два репо на одном бэкенде с одними ключами (один бакет, разные пути) работают;
- два репо на одном бэкенде с разными ключами напрямую не скопировать.

Обходы для последнего случая, по порядку предпочтения:

1. Копировать в оба из репо на другом бэкенде: не цепочка `s3-a → s3-b`, а звезда `local → s3-a`, `local → s3-b`,
   и у обоих `from: system-local`. Чтение из локального репо ещё и быстрее, чем из облака.
2. Для rest логин в URL, для sftp `Host` в `~/.ssh/config` с разными `IdentityFile`: эти настройки свои у каждого репо.
3. rclone с отдельным remote на каждый аккаунт: `RCLONE_CONFIG_<A>_*` и `RCLONE_CONFIG_<B>_*` не пересекаются.
   Достаточно перевести на rclone одну сторону пары. Формат репо не зависит от бэкенда, так что репо, созданное
   через `s3:`, открывается через `rclone:` с тем же бакетом и путём.

```yaml
repos:
  system-s3-a:
    path: s3:s3.eu-central-1.amazonaws.com/bucket-a/system
    password: ${SYSTEM_S3_A_PASSWORD}
    env:
      AWS_ACCESS_KEY_ID: ${S3_A_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${S3_A_SECRET}
  system-s3-b:
    # другой аккаунт: через rclone, чтобы его ключи не пересекались с AWS_* источника
    path: rclone:s3b:bucket-b/system
    password: ${SYSTEM_S3_B_PASSWORD}
    from: system-s3-a
    env:
      RCLONE_CONFIG_S3B_TYPE: s3
      RCLONE_CONFIG_S3B_PROVIDER: AWS
      RCLONE_CONFIG_S3B_REGION: eu-central-1
      RCLONE_CONFIG_S3B_ACCESS_KEY_ID: ${S3_B_KEY_ID}
      RCLONE_CONFIG_S3B_SECRET_ACCESS_KEY: ${S3_B_SECRET}
```

## Что проверяет `validate`

- `path` с префиксом, который restic не знает (`i1.lan:backups` без `sftp:`, `S3:bucket`), = ошибка: restic 0.19
  его тоже отвергает (`invalid backend`), но только при запуске шага. Для каталога с двоеточием `local:`.
- Опция чужого бэкенда (`s3.region` у sftp-репо) = ошибка: restic её молча игнорирует. Опция без пространства имён
  или с неизвестным = ошибка. Неизвестное имя в своём пространстве (`sftp.argz`) = предупреждение: restic такое
  отвергнет, но новые версии могут добавить опции.
- `RESTIC_REPOSITORY*` / `RESTIC_PASSWORD*` в `env` = ошибка.
- Пара `copy` или `from`: одинаковое имя в `env` или `options` с разными значениями на одном бэкенде = ошибка,
  на разных бэкендах (только `env`) = предупреждение; настройка, заданная только у одного репо пары на одном
  бэкенде, = предупреждение (она подействует и на второй).

Наличие файлов по путям в `env` и `options` не проверяется: конфиг могут валидировать на другой машине.

## Открытые вопросы

- Пароль репо из файла (`password-file` → `RESTIC_PASSWORD_FILE`): нужен для systemd `LoadCredential=` и
  docker secrets, где секрет лежит в файле, а не в окружении. Сейчас по дизайну секреты только из env демона.
- Пароль из команды (`RESTIC_PASSWORD_COMMAND`, например из `pass` или Vault) по той же причине не поддержан.

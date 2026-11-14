# Лимиты результатов, PgBouncer и поставка пакетов, 2026-11-14

Продолжение [первого внешнего измерения и physical failover](github-results-2026-11-14.md).
Использованы стандартные GitHub Actions runners публичного форка
`maxbronnikov10/node-postgres`. Студенческие кредиты не активировались.

## Проверенные версии

| Роль                       | GitHub commit                              | Git tree                                   |
| -------------------------- | ------------------------------------------ | ------------------------------------------ |
| До общих result budgets    | `2550426b2bcb0664d12aaeccbd1493be609e47dc` | `74f98c1f93422a5aad0925f07559fb7c3b68ce38` |
| Первая реализация budgets  | `7315ebb06c486343659f787fa23828fc74972679` | `98a75ab9088d625c7ffc2b38b5968d0b1b62875b` |
| Проверенный кандидат       | `fdba8c23136b567a9d8b9245736595ab95268997` | `949c25bace8cdb54e6aadef02cb82b66b1fa49b5` |
| До группировки TLS records | `c0022e4fc848848656e74bdb2ada47ef9267bc9c` | `ed2b2cc379571df30d80625a1229be35a49c6cf8` |

GitHub snapshots имеют точно те же деревья, что локальные исходники; commit IDs
различаются из-за отдельной истории публикации. Архивы пакетов ниже собраны именно
из `fdba8c23136b`, до добавления этого отчёта.

`maxResultRows=100000` и `maxResultBytes=67108864` ограничивают незавершённые
результаты всего QueryExecutor. Учитываются строки и исходные wire bytes
RowDescription/DataRow/CommandComplete, до пользовательских type parsers.
При превышении — `PG_EXECUTOR_RESULT_LIMIT`, `outcome=unknown`,
`safeToRetry=false`; соединение отбрасывается, назначенный SQL не повторяется.
Тест с уже committed INSERT RETURNING проверяет отсутствие повторной записи
в таблице без UNIQUE.

Это не лимит heap: завершённые Results у вызывающего кода, параметры и память
пользовательских parsers учитываются приложением. Один входящий frame отдельно
ограничен `maxMessageSize=16777216`. Подробный контракт —
[QueryExecutor](../docs/pages/apis/query-executor.mdx).

## Методика

Каждый job получает отдельную Ubuntu 24.04 VM, четыре vCPU, Node 22.22.1,
PostgreSQL 18.7 из закреплённого Docker digest. Установки обоих вариантов
независимые, frozen lockfile; workers проверяют локальное разрешение protocol/pool.
Проверяются `fsync`, `full_page_writes`, `synchronous_commit`: все `on`.
Logged UPDATE меняет горячие ключи; CHECKPOINT выполняется перед фазой.

Два процесса каждого варианта. В executor-фазах — четыре прогретых frontend-
соединения на процесс, 16 одновременных независимых запросов. Порядок процессов сбалансирован
по позициям и сохранён для каждого раунда. Прогрев — две секунды на процесс.
SELECT и 500-row SELECT: восемь раундов по три секунды; UPDATE: восемь по пять;
PgBouncer: четыре по три. Ответы проверяются во время измерения.

Коэффициент — медиана попарных head/base, шум — максимальное отклонение
base2/base и head2/head от единицы. Это наблюдаемый контроль, не доверительный
интервал. Порог качества 10% установлен до запуска. Заметное изменение требует
эффекта не меньше 2%, превышения шума и одного направления во всех раундах.

PgBouncer 1.25.2 работает в transaction mode, backend pool 4,
`max_prepared_statements=200`. Обе стороны используют TLS 1.3; backend —
`verify-full`. Маленькие запросы сравнивают Pool.query и QueryExecutor одного
кандидата через relay с задержкой каждого фрагмента минимум 3 мс на направление.
Это контролируемый стенд, без утверждения о точном RTT или реальном WAN.

Большие параметры сравнивают кандидата с версией до TLS grouping: два bytea по
1 MiB, тот же PgBouncer, локальный TCP без искусственной задержки. Этот baseline
включает и последующие изменения runtime, поэтому сравнение не изолирует одну
TLS-правку. В этой фазе один Client на процесс посылает два запроса одновременно;
три соединения остальных steady-сценариев простаивают у каждого варианта.
Проверка burst из 16 запросов наблюдает два application TLS records
до изменения и один после, 1298 и 1276 encrypted bytes; это не оценка CPU или QPS.

## Первый запуск: сохранённая регрессия

[Run 43642582872](https://github.com/maxbronnikov10/node-postgres/actions/runs/43642582872),
кандидат `7315ebb06c48`, harness `5397f14258c679cb5dc8afee09c1649dfaef4dda`.
Все regression и measurement jobs прошли. В ячейках коэффициент / шум:

| Сценарий                                      |   VM 1, EPYC 7763 | VM 2, Xeon 6975P-C | VM 3, Xeon 6975P-C |
| --------------------------------------------- | ----------------: | -----------------: | -----------------: |
| Budgets после/до, point SELECT                |    0,977× / 2,08% |     0,998× / 5,95% |     0,978× / 6,51% |
| Budgets после/до, 500-row SELECT              |    0,974× / 5,86% |     0,971× / 3,41% |     0,928× / 2,12% |
| Budgets после/до, logged UPDATE               |    1,002× / 2,46% |     0,994× / 3,07% |     1,000× / 2,74% |
| QueryExecutor / Pool.query, PgBouncer + relay |    3,622× / 1,62% |  4,205× / 10,10%\* |     4,144× / 4,72% |
| TLS candidate/before, 2 × 1 MiB               | 1,016× / 10,87%\* |     1,006× / 1,38% |     0,999× / 3,09% |

`*` — неопределённо: контрольный шум превышает 10%, даже если коэффициент большой.
На VM 1 point SELECT потерял 2,27%; на VM 3 bulk потерял 7,21% с превышением
контрольного шума. UPDATE заметного изменения не показал. Для крупных параметров
подтверждённого ускорения нет. Эти результаты сохранены вместе с повтором.

После bulk-регрессии убрано создание объекта контекста на каждом result frame:
контекст создаётся один раз на запрос. Лимиты и ветви ошибок сохранены.
Повтор отдельно сравнивает эту правку с первой bounded-реализацией, а также весь
кандидат с версией без budgets. Так цена защиты отделяется от эффекта оптимизации.

## Повтор

[Run 43646613495](https://github.com/maxbronnikov10/node-postgres/actions/runs/43646613495),
кандидат `fdba8c23136b`, harness `0f656277251331c3539286345a720f99cecc6a40`.
VM 2 в первом attempt остановилась до тестов: Docker не смог занять host port 32774. Измерений на ней не было; повторён только этот job с тем же source.
Все три измерения завершились успешно. VM 1 и 3 — attempt 1, VM 2 — attempt 2;
успешные jobs не перемерялись.

| Сценарий                                                 |   VM 1, EPYC 9V74 | VM 2, EPYC 7763 | VM 3, Xeon 6975P-C |
| -------------------------------------------------------- | ----------------: | --------------: | -----------------: |
| Весь кандидат / до budgets, point SELECT                 |    0,986× / 1,71% |  0,973× / 1,61% |     0,982× / 6,42% |
| Весь кандидат / до budgets, 500-row SELECT               |    0,967× / 4,39% |  0,952× / 5,72% |     0,960× / 3,74% |
| Правка контекста / первая budgets-версия, 500-row SELECT |    0,996× / 6,93% |  0,998× / 4,85% |     0,998× / 3,54% |
| Весь кандидат / до budgets, logged UPDATE                | 1,025× / 30,71%\* |  0,994× / 2,05% |     0,999× / 3,15% |
| QueryExecutor / Pool.query, PgBouncer + relay            |    3,923× / 3,48% |  3,868× / 1,81% |     4,096× / 0,63% |
| TLS candidate/before, 2 × 1 MiB                          |    1,002× / 3,28% |  0,967× / 7,98% |     0,998× / 1,37% |

Для PgBouncer выигрыш повторился на всех трёх VM и во всех раундах:
3,87–4,10×, около 1758–2211 запросов/с против 453–540 у Pool.query. Перенос контекста не
дал подтверждённого ускорения. Весь кандидат на VM 3 теряет 4,03% на bulk с
превышением шума; снижение с прежних 7,21% между разными VM-запусками нельзя
приписывать правке контекста. Лимиты результатов имеют измеримую цену, которая
сохраняется ради ограничения незавершённых результатов. На VM 2 point SELECT
теряет 2,73% с превышением шума 1,61%; другие point-изменения меньше порога заметности.
Для больших TLS-параметров
подтверждённого изменения QPS нет. UPDATE VM 1 неопределённый из-за шума 30,71%.

Сырые данные первого запуска: [VM 1](results/github-budgets-2026-11-14/initial-trial-1.json),
[VM 2](results/github-budgets-2026-11-14/initial-trial-2.json),
[VM 3](results/github-budgets-2026-11-14/initial-trial-3.json).
Повтор: [VM 1](results/github-budgets-2026-11-14/final-trial-1.json),
[VM 2](results/github-budgets-2026-11-14/final-trial-2.json),
[VM 3](results/github-budgets-2026-11-14/final-trial-3.json).
[Независимый пересчёт](results/github-budgets-2026-11-14/final-analysis.json)
проверяет identities, коэффициенты, controls, направления и баланс позиций.
Копии JSON отформатированы без удаления полей и изменения значений.
Source identities, SHA256 исходных ZIP и исключённая инфраструктурная ошибка —
в [provenance](results/github-budgets-2026-11-14/provenance.json).

## Регрессии и совместимость

[Обычная CI-матрица кандидата](https://github.com/maxbronnikov10/node-postgres/actions/runs/43645702048)
полностью прошла: Node 16/18/20/22/24/26 с PG 18 и Node 26 с PG 13–17,
плюс lint. Это 11 сочетаний и lint, не полное декартово произведение версий.
Read-only fixture и SCRAM-роли настроены штатным workflow.

[Отдельный regression job](https://github.com/maxbronnikov10/node-postgres/actions/runs/43646613495/job/132605741217)
прошёл 1038 кейсов: pg 718, protocol 126, pool 93, cursor 43,
query-stream 40, native 15, workerd 3. В том числе 41 result-budget регрессия,
восстановление после лимита, общие бюджеты соединений, abort из parser,
abort при кодировании параметра, timeout и committed-write/no-replay.
Один прежний pool-тест pending; отдельный regression job без специальных
SCRAM-ролей не подменяет проверку SCRAM в обычной матрице.
[Команды и их исходы](results/github-budgets-2026-11-14/final-regressions.json)
и [результаты штатной матрицы](results/github-budgets-2026-11-14/ordinary-ci.json).

Дополнительные assertions проверяют CA/hostname rejection, подтверждённый TLS,
целый 1 MiB binary payload, изоляцию SQL-ошибок и named statements после
PgBouncer RECONNECT. Итоговый короткий TLS log содержит record counters;
остальные проверки подтверждаются успешным завершением assertion-скрипта.

QueryExecutor требует runtime с `events.addAbortListener` и отсутствует в
`pg.native`. На Node 16 проверяется явный unsupported outcome и обычный Client;
executor-only suites там не исполняются. Обычные Client/Pool сохраняют поддержку
Node 16. Workerd cases проверяют Client, без обещания recovery QueryExecutor.
Две реальные physical-promotion проверки описаны в первом отчёте; read-only
fixture GitHub не считается физической репликой.

## Восемь согласованных пакетов

[Job поставки](https://github.com/maxbronnikov10/node-postgres/actions/runs/43646613495/job/132606320789)
дважды собрал восемь архивов; все SHA256 совпали. Node 22.22.1, npm 10.9.4.
Внутренние зависимости закреплены на точные experimental versions
`*-perf.20261114.gfdba8c23136b`; source manifests не изменяются.

В чистом consumer вне checkout установлены семь JS-архивов: проверены отсутствие
source symlinks, точные версии, CJS/ESM, executor recovery, отрицательный binary
int4, cursor и query-stream. Затем восьмой, pg-native, установлен с обычной
сборкой libpq и выполнил реальные SELECT/parameter queries. Ручной ремонт
native build в этом GitHub job не потребовался. Native не получает QueryExecutor.

Исходники сборки — [package-build.js](package-build.js) и
[package-check.js](package-check.js). Реестр npm не менялся. Artifact
`coordinated-packages-1` хранится в Actions один день; recipe и manifest остаются
в репозитории. Два build одного source commit проверены на побайтное совпадение;
это не гарантия одинаковых архивов при любой версии npm.

Воспроизведение из установленного чистого checkout указанного source commit:

```bash
git checkout fdba8c23136b567a9d8b9245736595ab95268997
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile --non-interactive
yarn build
node benchmark/package-build.js /tmp/nodepg-packages
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=postgres \
  node benchmark/package-check.js /tmp/nodepg-packages /tmp/nodepg-consumer
```

Нужны доступный тестовый PostgreSQL и новые output/consumer directories.
`package-check.js` устанавливает семь JS-пакетов; optional native проверен отдельным
шагом workflow с libpq-dev. Проверки реального Cloudflare окружения для установленных
tarballs нет; source workerd suite прошла.

[Manifest с версиями и SHA256 восьми пакетов](results/github-budgets-2026-11-14/packages-manifest.json),
[успешные assertion logs чистого consumer](results/github-budgets-2026-11-14/packages-checks.json).
Для локальной полной workspace-сборки нужны Node 22.22.1, npm 10.9.4,
C++ toolchain и libpq-dev; GitHub workflow устанавливает build dependency сам.

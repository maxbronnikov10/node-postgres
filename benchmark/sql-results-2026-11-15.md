# SQL API, PgBouncer и сравнение с Postgres.js 4.1.1

Ветка `feat/sql-tag-client` содержит компактный SQL API на strict TypeScript.
Удалены `pg-native`, Cloudflare, cursor, query-stream и browser bundler package.
Остались `pg` и три внутренних пакета: protocol, pool, connection-string.

Подтверждены два практических выигрыша:

- **Transaction PgBouncer, prepare:false, строки, 16 concurrent:** 4.68–4.99× на трёх VM против стандартного Postgres.js 4.1.1.
- **Входящий bytea 1 MiB, TLS + relay:** 1.88–1.97× на трёх VM.

Обычные повторяемые prepared SELECT пока уступают Postgres.js. Явный `sql.typed(value, 25)` у Postgres.js устраняет заметный выигрыш нашего клиента в unprepared text-сценарии. Общий титул самого быстрого клиента эти измерения не обосновывают.

## API

```ts
import postgres from 'pg'

interface User {
  id: number
  name: string
}
const sql = postgres(process.env.DATABASE_URL, { max: 4 })
try {
  const user = await sql<User>`SELECT id, name FROM users WHERE id = ${42}`.maybeOne()
  await sql.begin(async (tx) => {
    await tx`UPDATE jobs SET done = ${true} WHERE id = ${42}`
  })
} finally {
  await sql.end()
}
```

Есть ленивые параметризованные теги, вложенные фрагменты, безопасные идентификаторы,
`unsafe` для доверенного SQL с отдельными параметрами, `.values()`, `.one()` и
`.maybeOne()`. Повторный await одного объекта не повторяет SQL. Результаты — массивы
с неперечисляемыми `count`, `command`, `columns`. [Полный API](../packages/pg/README.md).

`begin` резервирует соединение из того же `max`. Timeout, abort и общий бюджет
результатов действуют внутри транзакции. Ошибка количества строк после INSERT
не предлагает replay; при потерянном подтверждении COMMIT — `outcome=unknown`,
`safeToRetry=false`. Транзакция не повторяется автоматически.
Node.js 20.5+. Generic описывает ожидаемые значения и не валидирует схему БД.

## Проверки и поставка

[CI 43666835647](https://github.com/maxbronnikov10/node-postgres/actions/runs/43666835647):
10 jobs успешны. Девять сочетаний: Node 20/22/24 с PG 18; Node 26 с PG 13–18;
отдельно lint. Это не полное декартово произведение версий.
В Node 22 / PG 18 — **1118 проверок**: pg 781, pool 92, protocol 126,
connection-string 93, ESM 26. Отдельная компиляция type fixtures не включена в счёт.
[Исходы jobs и состав счёта](results/sql-2026-11-15/ci.json).

Новые проверки защищают параметры/идентификаторы от SQL injection, вложенную
нумерацию, однократное выполнение записи, cardinality errors, commit/rollback,
перехваченную SQL-ошибку, закрытый transaction scope, общий лимит соединений,
ранний release и лимиты результата. Изъятие transaction budget из временного
скомпилированного runtime делает соответствующую регрессию красной; после
восстановления исходных байтов она зелёная.

Реальный TCP fault fixture обрывает ответ после серверного COMMIT. Контрольное
соединение видит ровно один неуникальный marker; callback выполнен один раз,
исход клиенту неизвестен. Новые SELECT учитывают документированный endpoint
cooldown и повторяются только при `not-sent`; исходный INSERT не повторяется.
Проверены custom/global parsers, int4 min/max, binary, int8/numeric precision,
метаданные с `__proto__`, мутация возвращённых descriptors и DDL без replay.

Первый CI остановился на оставшихся cursor/native-only тестах после удаления
адаптеров. Удалены pending cursor fixture и native-only timeout case;
весь оставшийся pool suite и финальная матрица прошли.

Согласованные четыре архива проверены установкой вне checkout, CJS/ESM runtime,
strict CJS/ESM types, tagged SQL и transaction. Установленный ESM default
проверен и через живой PgBouncer: внутри begin сохраняется один backend PID. У пары сборок одного commit
совпали SHA256. В whitelist добавлены только flat dist и crypto: старые
`dist/native` от предыдущей ветки не попадают в архив даже при наличии на диске.
Self-check воспроизводит включение такого остатка до whitelist и исключение после.
[Manifest поставки](results/sql-2026-11-15/packages-manifest.json).
Нового API в npm пока нет; `npm install pg` устанавливает upstream.

## Версии и воспроизводимость

| Роль                 | GitHub commit                              | Tree                                       |
| -------------------- | ------------------------------------------ | ------------------------------------------ |
| Основные сравнения   | `99fc7dd1a6de5e06e9b47fe3d1cbf383b4c51f5f` | `4a837ed532164a40a0bd0a9ae693eb8abd081dd0` |
| Финальный runtime CI | `d9192c211b52e0e2ebf49ec546e711370cbd2360` | `b2cfa42d2555cfb23b09f437e90954244e53be5e` |
| Whitelist поставки   | `13b6ba72e90e78cb74e1b0b06566be9d3aa0bf4b` | `de0c84b476c1c2205cc5635c75553eb78ece4e67` |
| Unprepared harness   | `e8503b133e75b870caabdf0109fa986505b16c37` | `1df4ea62e9275f1930e0e38cfc81725d51332e39` |

Поздние изменения касаются тестов, поставки и harness. Исходники runtime совпадают
побайтно; [список SHA256](results/sql-2026-11-15/runtime-parity.json).
Локальные commit IDs отличаются от GitHub snapshot IDs при одинаковых деревьях.
[Provenance, источники и SHA256 ZIP](results/sql-2026-11-15/provenance.json).

[Основной run 43665321310](https://github.com/maxbronnikov10/node-postgres/actions/runs/43665321310),
[unprepared run 43670474914](https://github.com/maxbronnikov10/node-postgres/actions/runs/43670474914).
Все шесть VM jobs успешны; качество каждой ячейки проверяется отдельно.
GitHub Ubuntu 24.04, четыре vCPU, Node 22.22.1, PostgreSQL 18.7 из закреплённого
образа. Postgres.js 4.1.1 проверен по npm lock integrity и registry gitHead.
Студенческие кредиты не активировались; использованы обычные hosted runners.

## Методика

На каждом стенде четыре долгоживущих процесса: две копии Postgres.js и две нашего
клиента. В каждый момент измеряется один процесс. Восемь раундов по три секунды,
прогрев две секунды; каждый actor занимает каждую позицию дважды.
Одинаковы четыре frontend-соединения, max pipeline 16, SQL, входные значения и
формат строк. Все поля прочитаны и проверены. Байтовый сценарий сравнивает весь
переданный MiB на сервере. Обычные запросы: 16 concurrent; bytea: два.

Сохранены `fsync`, `full_page_writes`, `synchronous_commit=on`, logged UPDATE и
CHECKPOINT вне измерения. В основном тесте prepare:true; обеим библиотекам хватает
кеша на весь набор. Наши deadlines/result budgets включены; Postgres.js использует
свои остальные defaults. Это сравнение публичных API с указанными возможностями,
а не изолированное сравнение декодеров.

Коэффициент — медиана head/base по раундам. Шум — максимальное наблюдаемое
отклонение base2/base и head2/head от единицы, включая изменчивость PostgreSQL.
Порог качества задан заранее: выше **10%** — неопределённо. Заметный эффект
превышает шум и 2%, все раунды направлены одинаково. Это наблюдаемый контрольный
диапазон, без утверждения о доверительном интервале.

TLS требует доверенный CA и TLS 1.3; `pg_stat_ssl` проверен на четырёх backend PID
каждого actor. Relay задерживает фрагменты минимум на 3 мс в каждом направлении;
точный RTT, WAN, потери и ограничение bandwidth этим не моделируются.

## TCP

Значения: наш API / Postgres.js; после `/` — шум контроля. `*` означает неопределённый результат.

| Сценарий                 | VM 1, Xeon 6975P-C | VM 2, EPYC 7763 |   VM 3, EPYC 9V74 |
| ------------------------ | -----------------: | --------------: | ----------------: |
| Point SELECT, sequential |     0.842× / 3.11% |  0.829× / 2.66% |    0.811× / 9.36% |
| Point SELECT, x16        |     0.739× / 1.62% |  0.868× / 1.65% |    0.858× / 3.76% |
| 500 rows, object, x16    |     0.582× / 7.13% |  0.581× / 6.57% |    0.552× / 4.11% |
| 500 rows, array, x16     |     0.779× / 8.91% |  0.788× / 8.00% |    0.770× / 5.03% |
| 500 rows, mixed, x16     |     0.686× / 2.56% |  0.747× / 4.06% |    0.713× / 5.48% |
| 1 MiB bytea input, x2    |  3.440× / 14.84%\* |  3.102× / 7.12% | 3.237× / 10.25%\* |
| Logged UPDATE, x16       |     0.869× / 4.19% |  0.908× / 5.28% | 0.917× / 76.22%\* |

## TLS 1.3 + relay 3 мс на направление

Значения: наш API / Postgres.js; после `/` — шум контроля. `*` означает неопределённый результат.

| Сценарий                 | VM 1, Xeon 6975P-C | VM 2, EPYC 7763 |   VM 3, EPYC 9V74 |
| ------------------------ | -----------------: | --------------: | ----------------: |
| Point SELECT, sequential |     0.991× / 2.86% |  0.991× / 2.38% | 0.979× / 21.00%\* |
| Point SELECT, x16        |     0.979× / 1.75% |  0.972× / 2.53% |    0.985× / 4.57% |
| 500 rows, object, x16    |     0.854× / 1.23% |  0.812× / 3.84% |    0.863× / 2.32% |
| 500 rows, array, x16     |     0.930× / 1.15% |  0.909× / 2.82% |    0.944× / 2.85% |
| 500 rows, mixed, x16     |     0.833× / 3.80% |  0.827× / 3.12% |    0.829× / 3.26% |
| 1 MiB bytea input, x2    |     1.913× / 2.72% |  1.968× / 1.98% |    1.877× / 7.49% |
| Logged UPDATE, x16       |     0.978× / 1.17% |  0.974× / 2.46% | 0.975× / 54.86%\* |

TCP bytea: подтверждены 3.10× только на VM 2; две другие ячейки выше порога шума.
TLS bytea: подтверждены все три выигрыша, 1.88–1.97×. Входной Buffer передаётся
node-postgres в binary parameter format; Postgres.js использует hex text encoding. ([код сериализатора Postgres.js](https://github.com/porsager/postgres/blob/1cc66f42c06e328636952774852b63a8ee4620ed/src/types.js), [наш codec](../packages/pg/src/utils.ts)).
Это преимущество протокольного пути для данного входа, не ускорение от TypeScript.
Prepared SELECT в этих сценариях выигрывает Postgres.js.

## Transaction PgBouncer без tracking prepared statements

Новый стенд: PgBouncer 1.25.2, transaction mode, четыре backend-соединения,
`max_prepared_statements=0`, TLS 1.3 на frontend и backend, backend verify-full.
Живой SHOW CONFIG и TLS проверены отдельным admin-клиентом.
Отключение named preparation согласовано с [настройкой pooler](https://www.pgbouncer.org/config.html#max_prepared_statements).
Оба клиента используют `prepare:false`. Запрос — параметризованный text echo,
отдельные statement вне BEGIN. Relay действует между клиентом и pooler.

Три варианта Postgres.js: defaults, `infer:true`, явный `sql.typed(value, 25)`.
Наш API во всех вариантах получает обычную строку. У настроенного контроля
больше информации о типе входа; это позволяет оценить доступное пользователю ускорение.
Ни один вариант исходных данных не исключён.

Значения: наш API / Postgres.js; после `/` — шум. Это три новые VM, их CPU сохранены в raw JSON.

| Postgres.js | Сценарий      |              VM 1 |              VM 2 |              VM 3 |
| ----------- | ------------- | ----------------: | ----------------: | ----------------: |
| Defaults    | Sequential    | 1.972× / 20.37%\* | 1.970× / 18.47%\* |    1.966× / 9.18% |
| Defaults    | 16 concurrent |    4.874× / 7.55% |    4.679× / 4.73% |    4.987× / 1.80% |
| infer:true  | Sequential    | 1.965× / 24.58%\* | 1.978× / 15.51%\* |    1.989× / 5.11% |
| infer:true  | 16 concurrent | 4.880× / 14.17%\* | 4.668× / 16.40%\* | 5.027× / 14.43%\* |
| text OID 25 | Sequential    |    0.997× / 6.48% | 1.002× / 24.42%\* |    1.001× / 8.79% |
| text OID 25 | 16 concurrent |    0.984× / 8.31% |    0.994× / 2.18% |    0.993× / 5.81% |

Против стандартного Postgres.js подтверждены **4.68–4.99× при 16 concurrent на всех
трёх VM**. Последовательный выигрыш подтверждён только на VM 3, около 1.97×;
два других стенда шумные. У infer:true concurrent-контролей шум выше порога,
скоростного вывода по этим трём ячейкам нет.

При явном text OID у Postgres.js заметной разницы в 16 concurrent нет на всех VM;
коэффициенты 0.984–0.994. Строковые defaults Postgres.js требуют описания параметра
перед Bind; заранее заданный OID позволяет отправить полный запрос сразу.
Наш клиент отправляет строку как текстовый параметр в одном обмене.
Это объяснение опирается на протокольный код и согласуется с контролем;
универсальный выигрыш над настроенным Postgres.js не заявлен.

## Что осталось

В этой работе добавлены TCP coalescing, byte-based int4 parsing, ограниченная
специализация int4 rows и кеш int4 descriptions. Custom parsers и остальные типы
сохраняют прежний путь; отключённая генерация кода использует fallback.
Специализация не обеспечила победу обычных prepared SELECT. Следующий кандидат —
уменьшить диспетчеризацию DataRow и повторное построение metadata в SQL-only пути;
для него нужны отдельный профиль и сохранение протокольных проверок.

Измерения — прогретая синтетическая нагрузка. Cold start, реальный WAN,
production/RPO и поведение всех внешних адаптеров не проверены.
COPY, LISTEN, streaming, savepoints и полная API-совместимость Postgres.js в эту
компактную реализацию не входят. [Raw JSON и независимый пересчёт](results/sql-2026-11-15/).

## Повторить

Используйте одноразовую БД: setup пересоздаёт `benchmark_sql_rows`.
Установите competitor отдельно от библиотечных зависимостей и задайте PG environment:

```sh
npm install --prefix /tmp/pg-compare --ignore-scripts --no-audit --no-fund --save-exact postgres@4.1.1
PG_BENCH_POSTGRESJS_MODULE=/tmp/pg-compare/node_modules/postgres node benchmark/compare.js --base . --head . --profile postgresjs --rounds 8 --duration 3 --warmup 2 --json-output /tmp/result.json
```

Для pooler доступны `postgresjs-unprepared`, `postgresjs-unprepared-infer`,
`postgresjs-unprepared-typed`. Полная подготовка disposable TLS/pooler fixture
и три VM заданы в [основном workflow](../.github/workflows/benchmark.yml) и
[unprepared workflow](../.github/workflows/benchmark-unprepared.yml).

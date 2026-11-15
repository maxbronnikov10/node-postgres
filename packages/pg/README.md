# Typed SQL

Компактный API по образцу Postgres.js, на TypeScript-ядре node-postgres.
Node.js 20.5+. Экспериментальная ветка: нового API в npm пока нет.
Совместимость со всеми возможностями Postgres.js не заявлена.

```ts
import postgres from 'pg'

interface User {
  id: number
  name: string
}
const sql = postgres(process.env.DATABASE_URL, { max: 4 })
try {
  const users = await sql<User>`SELECT id, name FROM users WHERE active = ${true}`
  const user = await sql<User>`SELECT id, name FROM users WHERE id = ${42}`.maybeOne()
  const one = await sql<User>`SELECT id, name FROM users WHERE id = ${42}`.one()
  const tuples = await sql`SELECT id, name FROM users`.values<[number, string]>()
} finally {
  await sql.end()
}
```

CommonJS: `const postgres = require('pg')`; в TypeScript CJS также доступен
`import { postgres } from 'pg'`. Generic задаёт ожидаемый тип результата;
проверку фактической схемы PostgreSQL при исполнении он не заменяет.

## Параметры и динамический SQL

`${value}` становится параметром `$1`, а не текстом SQL. Кавычки вокруг
интерполяции не нужны. `sql('public.users')` обозначает идентификатор,
`sql.identifier('schema.with.dot', 'users')` экранирует части буквально.
Вложенные SQL-фрагменты получают правильные номера параметров.

```ts
const filter = sql`AND age >= ${18}`
const rows = await sql`SELECT id FROM ${sql('public.users')} WHERE active = ${true} ${filter}`
const existingSql = await sql.unsafe('SELECT id FROM users WHERE id = $1', [42])
```

`unsafe` принимает доверенный SQL-текст: значения передавайте отдельным массивом.
Параметризованный `unsafe` нельзя вкладывать во фрагменты.

Запрос ленивый: выполнение начинается при `await`, `.then()` или `.execute()`.
Повторное ожидание того же объекта возвращает тот же результат без повторного SQL.
`.values()` выбирается до начала выполнения. Результат — массив с
неперечисляемыми `count`, `command`, `columns`; `map` и JSON работают привычно.
`one()` требует одну строку, `maybeOne()` допускает ноль или одну. Ошибка количества
строк возникает после SQL: запись могла уже зафиксироваться.

## Транзакции

```ts
await sql.begin(async (tx) => {
  await tx`INSERT INTO jobs (id, done) VALUES (${42}, ${false})`
  await tx`UPDATE jobs SET done = ${true} WHERE id = ${42}`
})
```

`begin` резервирует соединение из общего лимита `max`. Другие запросы не попадают
внутрь транзакции. Успешный callback приводит к COMMIT, ошибка — к ROLLBACK.
Перехват ошибки SQL в callback не превращает откатившуюся транзакцию в успешную.
Объект `tx` действует только внутри callback. Вложенные транзакции/savepoints,
session state вне `begin`, LISTEN, COPY и streaming этот API не предоставляет.

Лимиты результата и timeout действуют также внутри транзакции. При обрыве
транспорта во время COMMIT исход неизвестен: автоматического replay нет.
`end()` ждёт уже запущенные запросы и активные транзакции; неотправленные
ленивые запросы после закрытия не выполняются.

## Настройки

`postgres(url?, options?)` либо `postgres(options)`; соединение берёт настройки
также из обычных PG environment variables. `username` — синоним `user`.

| Настройка        | По умолчанию | Назначение                                  |
| ---------------- | -----------: | ------------------------------------------- |
| `max`            |            2 | Общий предел соединений, включая транзакции |
| `max_pipeline`   |           16 | Независимых запросов на соединение          |
| `prepare`        |         true | Автоматические prepared statements          |
| `maxAutoPrepare` |          256 | Предел подготовленных SQL на соединение     |
| `maxPending`     |         1024 | Предел ожидающих запросов                   |
| `query_timeout`  |        30000 | Deadline в миллисекундах; 0 отключает       |
| `maxResultRows`  |       100000 | Общий бюджет буферизуемых строк             |
| `maxResultBytes` |     67108864 | Общий бюджет протокольных байтов результата |

`ssl`, `sslnegotiation`, `endpoints`, `targetSessionAttrs` и пользовательские
`types` используют [контракт ядра](../../docs/pages/apis/query-executor.mdx).
Для PgBouncer transaction mode подготовка требует tracking prepared statements
на стороне pooler; иначе укажите `prepare: false`.
`int8` и `numeric` остаются строками без потери точности.
Client/Pool доступны для миграции и продвинутых сценариев; native удалён.

Бенчмарк сравнивает Postgres.js 4.1.1 и этот API на одинаковых запросах,
соединениях, pipeline depth и форматах результата. Исходные замеры сохраняются.

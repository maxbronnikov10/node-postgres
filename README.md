# Tagged SQL for Node.js

Экспериментальный TypeScript-форк node-postgres: компактный SQL API с параметрами,
транзакциями и ограниченным pipelining. [Документация API](packages/pg/README.md).

```ts
import postgres from 'pg'

const sql = postgres(process.env.DATABASE_URL, { max: 4 })
try {
  const users = await sql<{ id: number }>`SELECT id FROM users WHERE active = ${true}`
  const user = await sql<{ id: number }>`SELECT id FROM users WHERE id = ${42}`.maybeOne()
  await sql.begin(async (tx) => {
    await tx`UPDATE jobs SET done = ${true} WHERE id = ${42}`
  })
} finally {
  await sql.end()
}
```

Новый API не опубликован в npm. `npm install pg` устанавливает upstream, который
не содержит этот интерфейс. Сборка ветки: `yarn install --frozen-lockfile && yarn build`.
Для отдельного приложения — согласованные архивы через
`node benchmark/package-build.js /tmp/pg-sql-packages` из чистого checkout.

Node.js 20.5+. Без native bindings, Cloudflare, отдельного cursor и query-stream.
MIT; исходная реализация и авторство node-postgres сохранены.

[Результаты сравнения с Postgres.js](benchmark/sql-results-2026-11-15.md):
PgBouncer unprepared и bytea имеют подтверждённые выигрыши; обычные prepared SELECT пока медленнее.

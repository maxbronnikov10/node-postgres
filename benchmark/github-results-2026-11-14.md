# Внешние измерения и физический failover, 2026-11-14

Продолжение с общими result budgets, реальным PgBouncer, полной CI-матрицей
и согласованными пакетами — [следующий отчёт](github-results-budgets-2026-11-14.md).
Ниже сохранены исходные измерения предыдущего кандидата.

[Завершённый GitHub Actions run](https://github.com/maxbronnikov10/node-postgres/actions/runs/43633165056)
в публичном форке `maxbronnikov10/node-postgres`: регрессии и три отдельных VM
прошли успешно. Использованы стандартные GitHub runners; студенческие кредиты
не активировались и не расходовались.

Для 16 параллельных независимых SELECT вне транзакции QueryExecutor оказался
быстрее Pool.query в **3,75–4,25 раза** в описанном TLS-relay стенде. Последовательные
запросы подтверждённого выигрыша не дали. На двух стабильных VM последние правки
надёжности не показали заметной регрессии logged UPDATE; третий замер UPDATE
неопределённый из-за шума. Успешный CI сам по себе не доказывает ускорение.

## Что сравнивалось

| Роль | GitHub commit | Git tree |
| --- | --- | --- |
| До HA/framing-правок | `662beb7d0b258ef0503342a918783d0e9fc0ed70` | `0d45f95dc5b3c3efc0ef491887358f00416d29f4` |
| Проверенный кандидат | `5668408bcafe5f0ebfcdd214a02fddc2339061a1` | `ce6c175709ea7245b532762677f7fd885834034e` |
| Benchmark harness | `fbd4c0260c3653519662f3e330f7cd9a1a56a486` | `dc6abc5793da6c65ce386591cd8a8c1183596ca9` |

Это snapshots с точным совпадением деревьев локальных `c33d6cac` и `c1950bee`;
история локальных commits не имитировалась. Полные идентификаторы, SHA256
артефактов и история исключённых запусков — в
[provenance.json](results/github-2026-11-14/provenance.json).
[Workflow закреплён по commit](https://github.com/maxbronnikov10/node-postgres/blob/fbd4c0260c3653519662f3e330f7cd9a1a56a486/.github/workflows/reproducible-benchmarks.yml).

Каждая VM независимо устанавливала и собирала оба checkout по frozen lockfile.
Workers проверяли, что `pg-protocol` и `pg-pool` разрешаются внутри измеряемого
checkout. Node **22.22.1**, PostgreSQL **18.7**, Ubuntu 24.04, по **4 vCPU**:

| VM | CPU | Доступная RAM |
| --- | --- | ---: |
| 1 | AMD EPYC 9V45 | 15,61 GiB |
| 2 | Intel Xeon 6975P-C | 15,33 GiB |
| 3 | AMD EPYC 7763 | 15,61 GiB |

На PostgreSQL проверены `fsync=on`, `full_page_writes=on`,
`synchronous_commit=on`, `checkpoint_timeout=5min`. Таблица обычная logged;
один CHECKPOINT выполнялся перед фазой вне измерения. UPDATE меняет фиксированные
горячие ключи, поэтому это микробенчмарк, а не оценка всех типов записи.

У каждого варианта четыре прогретых frontend-соединения, cache подготовки 16;
каждый ответ проверяется. У QueryExecutor depth 16, pending 1024. Четыре процесса
измеряются последовательно: два экземпляра каждого варианта. За четыре раунда
каждый процесс занимает каждую позицию. Фактический порядок сохранён в JSON.

Коэффициент — медиана попарных `head/base` по раундам. Контрольный шум —
максимальное отклонение `base2/base` и `head2/head` от единицы. Это наблюдаемый
шум, а не доверительный интервал. Заранее установлен порог качества 10%; для
заметного изменения также нужны эффект не меньше 2%, превышение шума и одинаковое
направление всех раундов.

## Результаты

В ячейках: **коэффициент / контрольный шум**.

| Сравнение | VM 1 | VM 2 | VM 3 |
| --- | ---: | ---: | ---: |
| QueryExecutor после/до HA, 16 concurrent logged UPDATE | 1,029× / 21,8% | 1,012× / 2,0% | 1,005× / 1,8% |
| QueryExecutor / Pool.query, TLS, 16 concurrent SELECT | 3,995× / 3,8% | 4,250× / 1,4% | 3,751× / 2,1% |
| QueryExecutor / Pool.query, TLS, последовательный SELECT | 1,008× / 17,9% | 1,000× / 17,2% | 1,015× / 3,7% |

UPDATE: VM 1 неопределённая. На VM 2 и 3 изменение меньше порога заметности;
это свидетельство отсутствия обнаруженной регрессии в данном тесте, без гарантии
эквивалентности на произвольной нагрузке.

Параллельный SELECT: эффект повторился на всех трёх VM и во всех измеренных
раундах. Pool.query давал 532–556 запросов/с, QueryExecutor — 2009–2262 запросов/с.
Оба варианта используют один кандидат, проверенный TLS 1.3, общий TLS context
и direct negotiation. TCP-relay задерживает каждый полученный фрагмент байтов
минимум на 3 мс в каждом направлении; TCP handshake в задержку не включён.
Это не измерение реального WAN или точного RTT. Изолированный эффект TLS handshake
и группировки TLS records в этом прогоне не измерялся.

Последовательный SELECT: VM 1 и 2 неопределённые, VM 3 не показывает заметного
изменения. Подтверждённого ускорения нет.

Сырые повторы и снимки CPU/RAM/I/O pressure до и после каждой фазы:
[VM 1](results/github-2026-11-14/trial-1.json),
[VM 2](results/github-2026-11-14/trial-2.json),
[VM 3](results/github-2026-11-14/trial-3.json).
UPDATE: восемь раундов по пять секунд на процесс; TLS: четыре по три секунды.
Прогрев — две секунды на процесс вне сохраняемых раундов. Коэффициенты, шум
и баланс позиций независимо пересчитаны из скачанных данных.

## Регрессии и восстановление

**997 прошедших кейсов**: pg 677 в 118 файлах, protocol 126, pool 93,
cursor 43, query-stream 40, native 15, настоящий workerd 3. Дополнительно прошли
TLS endpoint/role/URI/exactly-once assertions и шесть CLI/queue self-check scenarios.
[Результаты всех 130 команд](results/github-2026-11-14/regressions.json).
Сохранился один прежний pending pool-тест; optional SCRAM suite не запускалась
без специальных ролей. Workerd проверяет Client, а не recovery QueryExecutor.

На GitHub роль read-only задаётся настройкой отдельного сервера. Физический
standby дополнительно проверен **дважды локально**, на таком же pinned PG image:
`pg_basebackup -R -X stream`, начальное `pg_is_in_recovery()=true`, подтверждённый
WAL replay, SIGKILL primary во время INSERT с pg_sleep, ручной `pg_promote`,
новая запись через тот же QueryExecutor.

В обоих запусках прерванная операция получила `PG_EXECUTOR_UNKNOWN`,
`outcome=unknown`, `safeToRetry=false`; её повторной записи нет. Таблица без UNIQUE:
до отказа одна marker-запись, после повышения одна, прерванная — ноль.
[Первый запуск](results/github-2026-11-14/physical-1.json),
[повтор с setup-скриптом](results/github-2026-11-14/physical-2.json).
Наблюдаемое время от SIGKILL до новой успешной записи: 1,012 и 0,288 секунды.
Это два наблюдения с ручным повышением, без SLA, автоматических выборов и RPO-гарантии.
Seed WAL был явно воспроизведён до отказа; sleeping INSERT ещё не committed.
Эта физическая проверка использует обычный TCP; TLS проверен отдельным внешним сценарием.
Временные physical-контейнеры, volumes второго setup и сеть удалены.

Воспроизведение физической проверки на Linux с Docker и passwordless sudo:

```bash
python3 benchmark/standby-fixture.py --output /tmp/nodepg-physical-fixture.json
python3 - <<'PY'
import json, os, subprocess
fixture = json.load(open('/tmp/nodepg-physical-fixture.json'))
env = os.environ.copy()
env.update(PG_PHYSICAL_PRIMARY_PORT=str(fixture['primaryPort']),
           PG_PHYSICAL_STANDBY_PORT=str(fixture['standbyPort']),
           PG_PHYSICAL_PRIMARY_CONTAINER=fixture['primary'],
           PG_PHYSICAL_OUTPUT='/tmp/nodepg-physical-result.json')
subprocess.run(['node', 'benchmark/standby-check.js'], env=env, check=True)
PY
sudo docker rm -fv nodepg-physical-rw-20261114 nodepg-physical-standby-20261114
sudo docker network rm nodepg-physical-20261114
```

Setup отказывается заменять существующие ресурсы с этими именами; это проверено
повторным запуском без изменения container IDs. После неудачного setup очистка
производится теми же командами вручную. Внешний benchmark воспроизводится повторным
запуском jobs по ссылке Actions выше, с закреплёнными source commits.

## Ограничения и открытые пункты

Аудит исправил ошибку прежнего scheduler: rotation вместе с reversal закрепляли
варианты за чётными/нечётными позициями. Пробный run `43632411079` отменён;
его performance-цифры исключены. Более ранние цифры старого scheduler следует
считать предварительными до повторения. Два предыдущих запуска остановились
на подготовке runner: отсутствовал rg, затем pgpass fixture имела права 0644.
Runner использует pathlib и выставляет 0600; тесты не отключались.

[Историческая CI-матрица кандидата](https://github.com/maxbronnikov10/node-postgres/actions/runs/43630360633)
упала из-за отсутствующих HA-фикстур на 32774/32775. В следующем этапе fixtures
настроены и [матрица нового кандидата](https://github.com/maxbronnikov10/node-postgres/actions/runs/43645702048)
полностью прошла. Общие result budgets, внешний PgBouncer и сборка восьми
согласованных пакетов проверены отдельно; результаты и ограничения сохранены
в следующем отчёте. Реестр npm не изменялся.

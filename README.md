# @deepseek-ai/dsh-skill-mcp

Провайдер скиллов DeepSeek Harness, который превращает MCP-ресурсы `skill://` в
скиллы dsh — без упаковки скилла в плагин.

Идея (DRY): скилл живёт в одном месте — на MCP-сервере, а этот адаптер служит
переиспользуемым мостом «MCP `skill://` resources → dsh skills». Любой MCP-сервер,
реализующий [контракт `skill://`](CONTRACT.md), начинает «транслировать» свои
скиллы в dsh без ручной упаковки.

## Как это работает

Адаптер — это Cordis-плагин с провайдером скиллов:

- **Не держит своего MCP-соединения.** Он читает ресурсы из сервиса
  `mcpResources`, то есть из уже открытых соединений
  [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp).
  Сервер конфигурируется один раз (в `dsh-mcp-client`), второй процесс MCP не
  поднимается.
- `list()` перечисляет видимые в scope серверы (или берёт `config.servers`),
  запрашивает `resources/list`, отбирает URI `skill://<name>`, читает каждый
  такой ресурс и строит кандидата из его `SKILL.md`.
- `get()` повторно читает ресурс и возвращает полное определение скилла.
- Сбой сервера или отдельного ресурса не роняет каталог: адаптер помечает
  наблюдение неполным (`complete: false`), чтобы реестр не закэшировал частичный
  результат, и логирует диагностику.

Тот же `SKILL.md` (YAML-frontmatter `name`/`description`/`whenToUse`/
`disable-model-invocation`/`user-invocable`/`metadata` + markdown-тело) работает
и как файловый скилл (`dsh-skill-filesystem`), и как MCP-ресурс.

## Установка

Подключите пакет как зависимость профиля (через Plugin Manager или в
`package.json` профиля) и добавьте строку плагина в `cordis.yml`.

Пакет можно взять напрямую из этого репозитория, без публикации в npm:

```bash
npm install github:SpamX-dev/dsh-skills-over-mcp-plugin
```

## Настройка

Два шага: (1) обычный `dsh-mcp-client` для сервера, (2) одна строка адаптера.

```yaml
# 1) MCP-сервер: инструменты и ресурсы (стандартный dsh-mcp-client).
- id: mcp-ast-index
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: ast-index
    transport: stdio
    command: ast-index-mcp        # команда запуска вашего MCP-сервера
    args: ['serve']

# 2) Адаптер скиллов: один раз на весь профиль.
- id: skill-mcp
  name: '@deepseek-ai/dsh-skill-mcp'
  config:
    servers: ['ast-index']        # необязательно; пустой массив = все видимые серверы
```

После старта скилл `ast-index` появится в каталоге `available_skills`, а тулза
`skill` загрузит его инструкции (тело `SKILL.md`), как любой файловый скилл.

### Поля конфигурации

| Поле         | По умолчанию | Назначение                                                                 |
|--------------|--------------|-----------------------------------------------------------------------------|
| `providerName` | `mcp`       | Значение `provider` у кандидатов/определений (видно в результатах `skill`)   |
| `servers`    | `[]`         | Allow-list имён серверов для «скиллификации»; пустой — автообнаружение всех видимых |
| `rank`       | `650`        | Ранг кандидатов (меньше = выше приоритет; 650 > bundled 600, т.е. уступает локальным) |

## Проверка с эталонным сервером

В репозитории лежит фикстура [`fixtures/skill-mcp-fixture`](fixtures/skill-mcp-fixture/README.md) —
маленький MCP-сервер, раздающий два скилла как `skill://`-ресурсы.

```bash
cd fixtures/skill-mcp-fixture && npm install
```

Затем в `cordis.yml`:

```yaml
- id: mcp-fixture
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: fixture
    transport: stdio
    command: node
    args: ['fixtures/skill-mcp-fixture/src/server.mjs']

- id: skill-mcp
  name: '@deepseek-ai/dsh-skill-mcp'
  config:
    servers: ['fixture']
```

После старта в каталоге появятся `ast-index` и `code-review`.

## Логика без внешних зависимостей

Чистые помощники вынесены в `lib/skill-frontmatter.js` и покрыты smoke-тестом,
который работает без Cordis/MCP-клиента:

```bash
node test/smoke.test.mjs
```

## Ограничения

- Адаптер читает только ресурсы с URI строго `skill://<name>`; прочие ресурсы
  доступны модели через штатные тулзы `list_mcp_resources` / `read_mcp_resource`.
- Автообнаружение серверов опирается на scoped-слой `mcpResources` (тот же, что
  использует системный промпт сервиса). Если нужно жёстко ограничить набор —
  задайте `servers` явно.
- Скиллы MCP не участвуют в hot-reload файловой системы; изменения подхватываются
  при следующем обновлении каталога скиллов (по инвалидации реестра).

# skill-mcp-fixture

Эталонный MCP-сервер, публикующий два скилла как ресурсы `skill://`. Нужен для
проверки адаптера `@deepseek-ai/dsh-skill-mcp` без подключения реального
`ast-index-mcp`.

## Установка и запуск

```bash
cd fixtures/skill-mcp-fixture
npm install          # поставит @modelcontextprotocol/sdk
node src/server.mjs  # stdio-сервер; ждёт JSON-RPC на stdin
```

Сервер не пишет ничего в stdout, кроме MCP-сообщений, поэтому запускать его
вручную стоит только для отладки. Для dsh он запускается самим
`dsh-mcp-client` через stdio (см. `../../README.md`).

## Что сервер отдаёт

- `resources/list` → `skill://ast-index` и `skill://code-review`.
- `resources/read` → полный SKILL.md (YAML-frontmatter + markdown-тело).
- `tools/list` → пустой список (скиллы и тулзы независимы).

/**
 * Эталонный MCP-сервер, публикующий скиллы как ресурсы `skill://`.
 *
 * Демонстрирует контракт из `../../CONTRACT.md`: сервер объявляет capability
 * `resources`, отдаёт дескрипторы скиллов в `resources/list` и полный SKILL.md
 * текстом в `resources/read`. Никаких тулзов не публикуем — контракт скиллов
 * от них не зависит (тулзы регистрировал бы `dsh-mcp-client` отдельно).
 *
 * Запуск (stdio): `node src/server.mjs`. В `dsh-mcp-client` он конфигурируется
 * как stdio-сервер с `command: node`, `args: ["src/server.mjs"]`.
 *
 * @module skill-mcp-fixture
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Каталог скиллов, которые раздаёт фикстура. `name` дублируется в frontmatter
 * SKILL.md (как требует контракт), `description` — однострочное описание для
 * `resources/list`.
 */
const SKILLS = [
  {
    name: "ast-index",
    description: "Быстрый поиск по кодовой базе, символам, usages и зависимостям проекта.",
    markdown: [
      "---",
      "name: ast-index",
      "description: Быстрый поиск по кодовой базе, символам, usages и зависимостям проекта.",
      "whenToUse: Использовать, когда нужен поиск символов, usages, иерархий или структуры проекта.",
      "---",
      "",
      "# ast-index",
      "",
      "Это скилл-заглушка. В реальном `ast-index-mcp` здесь были бы инструкции по",
      "использованию инструментов поиска по индексу кодовой базы."
    ].join("\n")
  },
  {
    name: "code-review",
    description: "Ревью изменений с упором на корректность и читаемость.",
    markdown: [
      "---",
      "name: code-review",
      "description: Ревью изменений с упором на корректность и читаемость.",
      "disable-model-invocation: false",
      "user-invocable: true",
      "---",
      "",
      "# code-review",
      "",
      "Скилл-заглушка: проверяет diff на корректность, читаемость и отсутствие",
      "очевидных ошибок."
    ].join("\n")
  }
];

/**
 * Создаёт сервер, объявляющий capability `resources`.
 */
const server = new Server(
  { name: "skill-mcp-fixture", version: "1.0.0" },
  { capabilities: { resources: {} } }
);

/**
 * Обработчик `resources/list`: возвращает дескрипторы всех скиллов.
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: SKILLS.map((skill) => ({
    uri: `skill://${skill.name}`,
    name: skill.name,
    description: skill.description,
    mimeType: "text/markdown"
  }))
}));

/**
 * Обработчик `resources/read`: возвращает полный SKILL.md по URI.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const name = uri.startsWith("skill://") ? uri.slice("skill://".length) : null;
  const skill = SKILLS.find((entry) => entry.name === name);
  if (skill === undefined) {
    throw new Error(`Resource not found: ${uri}`);
  }
  return {
    contents: [{
      uri,
      mimeType: "text/markdown",
      text: skill.markdown
    }]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

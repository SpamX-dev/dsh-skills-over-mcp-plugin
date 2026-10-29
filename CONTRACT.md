# Контракт `skill://` — MCP-ресурсы как скиллы

Этот документ описывает способ, которым MCP-сервер публикует свои скиллы в виде
ресурсов, чтобы адаптер `@deepseek-ai/dsh-skill-mcp` превратил их в скиллы
DeepSeek Harness без упаковки скилла в плагин.

Смысл контракта — **DRY**: один и тот же `SKILL.md` работает и как файловый
скилл (читается `@deepseek-ai/dsh-skill-filesystem` из `.dsh/skills` и
`~/.agents/skills`), и как MCP-ресурс. Сервер остаётся единственным местом, где
скилл живёт; адаптер — лишь мост.

## 1. URI

Скилл — это MCP-ресурс с URI вида:

```
skill://<name>
```

- `<name>` — kebab-case имя скилла: `[a-z0-9]+(?:-[a-z0-9]+)*` (например,
  `ast-index`, `office`, `my-code-review`).
- Префикс схемы строго `skill://`.

## 2. Дескриптор ресурса (`resources/list`)

Элемент `resources` должен содержать:

| Поле         | Тип      | Обязательность | Назначение                                                                 |
|--------------|----------|----------------|----------------------------------------------------------------------------|
| `uri`        | string   | да             | `skill://<name>`                                                          |
| `name`       | string   | да             | Имя скилла (`<name>`)                                                     |
| `description`| string   | да             | Однострочное описание для каталога скиллов                                |
| `mimeType`   | string   | желательно     | Рекомендуется `text/markdown`                                             |

Дескриптор используется для того, чтобы MCP-клиент и человек видели ресурс
без чтения его содержимого. Авторитетными остаются `name` и `description` из
frontmatter читаемого SKILL.md; адаптер читает ресурс и берёт значения оттуда.

## 3. Чтение ресурса (`resources/read`)

Запрос `resources/read` с `{ uri: "skill://<name>" }` возвращает полный
`SKILL.md` как **один текстовый блок**:

```json
{
  "contents": [
    {
      "uri": "skill://<name>",
      "mimeType": "text/markdown",
      "text": "---\nname: <name>\ndescription: ...\n---\n\n# ...\n"
    }
  ]
}
```

Бинарные блоки (`blob`) для скиллов не допускаются.

## 4. Содержимое SKILL.md

Формат совпадает с файловым SKILL.md (`dsh-skill-filesystem`):

````markdown
---
name: ast-index
description: Использовать, когда нужен быстрый поиск по кодовой базе, поиск символов, usages, иерархии и т.д.
# опционально:
whenToUse: "Уточняющий триггер для модели"
disable-model-invocation: false
user-invocable: true
metadata:
  owner: platform
---

# Тело скилла (markdown-инструкции)

...
````

Поля frontmatter:

| Поле                       | Тип      | Обязательность | Назначение                                                                 |
|----------------------------|----------|----------------|----------------------------------------------------------------------------|
| `name`                     | string   | да             | Имя скилла (должно совпадать с `<name>` из URI)                           |
| `description`              | string   | да             | Однострочное описание (используется в каталоге)                           |
| `whenToUse`                | string   | нет            | Дополнительный триггер для модели                                         |
| `disable-model-invocation` | boolean  | нет            | `true` запрещает вызов модели через тулзу `skill` (по умолчанию `false`)  |
| `user-invocable`           | boolean  | нет            | `false` запрещает явный вызов человеком (по умолчанию `true`)             |
| `metadata`                 | object   | нет            | Произвольные метаданные (передаются как есть)                             |

Legacy-ключи (`disableModelInvocation`, `modelInvocable`, `userInvocable`)
отклоняются: используйте канонические имена из таблицы.

## 5. Требуемые возможности сервера

Сервер должен объявлять capability `resources`. Публикация тулзов не
обязательна и не связана с контрактом: скиллы транслируются только из ресурсов,
а тулзы (если есть) регистрирует `dsh-mcp-client` под именами
`mcp__<server>__<tool>`.

## 6. Отображение на скиллы dsh

Адаптер читает из сервера только ресурсы с URI `skill://…` и строит:

- кандидата: `name`, `description`, `whenToUse`, `invocation`, `source`
  (имя сервера), `rank`, `locator = { server, uri }`;
- определение (по `resources/read`): те же поля плюс `content` (тело SKILL.md).

Сбои сервера или отдельного ресурса не роняют каталог: адаптер помечает
наблюдение неполным (`complete: false`) и логирует диагностику.

## 7. Пример (минимум)

`resources/list`:

```json
{
  "resources": [
    {
      "uri": "skill://ast-index",
      "name": "ast-index",
      "description": "Быстрый поиск по кодовой базе, символам, usages и зависимостям.",
      "mimeType": "text/markdown"
    }
  ]
}
```

`resources/read` на `skill://ast-index` возвращает SKILL.md с frontmatter
`name: ast-index` и тем же `description`, плюс markdown-инструкции в теле.

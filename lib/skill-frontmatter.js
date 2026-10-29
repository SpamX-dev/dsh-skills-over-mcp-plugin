/**
 * Чистые помощники контракта `skill://` и разбора SKILL.md.
 *
 * Этот модуль не зависит ни от Cordis, ни от MCP-клиента: здесь собраны только
 * функции, превращающие MCP-ресурс вида `skill://<name>` и его текстовое
 * содержимое (SKILL.md с YAML-frontmatter) в структуры, из которых провайдер
 * скиллов строит кандидатов и определения. Модуль выделен отдельно ради двух
 * потребителей: провайдера (`./index.js`) и smoke-теста, проверяющего логику
 * без внешних зависимостей (реальный YAML-парсер подменяется заглушкой).
 *
 * Принятые ограничения (совпадают с `@deepseek-ai/dsh-skill-filesystem`):
 *   - имя скилла — kebab-case `[a-z0-9]+(?:-[a-z0-9]+)*`;
 *   - URI скилла — строго `skill://<name>`;
 *   - содержимое — тот же SKILL.md, что читает файловый провайдер:
 *     YAML-frontmatter между строками `---` и markdown-тело после него;
 *   - frontmatter-поля: `name` и `description` обязательны, `whenToUse`,
 *     `disable-model-invocation`, `user-invocable`, `metadata` — опциональны.
 *
 * @module @deepseek-ai/dsh-skill-mcp/skill-frontmatter
 */

/** Префикс схемы URI для skill-ресурсов MCP-сервера. */
const SKILL_URI_PREFIX = "skill://";

/** Грамматика публичного имени скилла (kebab-case, строчные буквы и цифры). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Проверяет, что значение является валидным skill-URI вида `skill://<name>`.
 *
 * @param {unknown} uri - кандидат в URI ресурса из `resources/list`.
 * @returns {boolean} true, если URI адресует скилл с валидным именем.
 */
export function isSkillUri(uri) {
  if (typeof uri !== "string") return false;
  if (!uri.startsWith(SKILL_URI_PREFIX)) return false;
  return SKILL_NAME.test(uri.slice(SKILL_URI_PREFIX.length));
}

/**
 * Извлекает имя скилла из URI `skill://<name>`.
 *
 * @param {string} uri - URI ресурса скилла.
 * @returns {string | undefined} имя скилла, либо undefined при невалидном URI.
 */
export function skillNameFromUri(uri) {
  if (!isSkillUri(uri)) return void 0;
  return uri.slice(SKILL_URI_PREFIX.length);
}

/**
 * Разделяет полный текст SKILL.md на YAML-frontmatter и markdown-тело.
 *
 * Ожидает, что первый «логический» символ файла — строка `---` (допустим
 * trailing `\r`), за ней идёт YAML до строки-разделителя `---`, после которой
 * начинается тело. Отсутствие открывающего или закрывающего разделителя
 * возвращает undefined, как и пустая первая строка.
 *
 * @param {string} raw - полный текст SKILL.md.
 * @returns {{ yaml: string, body: string } | undefined} текст YAML и тело,
 *   либо undefined при отсутствии корректного frontmatter.
 */
export function splitFrontmatter(raw) {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0) return void 0;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return void 0;
  const start = firstLineEnd + 1;
  const closing = findClosingFrontmatter(raw, start);
  if (closing === void 0) return void 0;
  return {
    yaml: raw.slice(start, closing.start),
    body: raw.slice(closing.bodyStart)
  };
}

/**
 * Находит закрывающую строку `---` frontmatter, начиная с заданной позиции.
 *
 * Ищет только строки, целиком равные `---` (с допустимым trailing `\r`), чтобы
 * markdown-горизонтальная линия внутри YAML или тела не считалась разделителем.
 *
 * @param {string} raw - полный текст SKILL.md.
 * @param {number} start - позиция первого символа после открывающего `---\n`.
 * @returns {{ start: number, bodyStart: number } | undefined} позиция начала
 *   строки-разделителя и позиция первого символа тела, либо undefined.
 */
function findClosingFrontmatter(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return {
        start: lineStart,
        bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1
      };
    }
    if (nextNewline < 0) return void 0;
    lineStart = nextNewline + 1;
  }
}

/**
 * Достаёт первый связный текст из результата `resources/read`.
 *
 * MCP возвращает `{ contents: [...] }`, где текстовые блоки несут поле `text`,
 * а бинарные — `blob` (base64). Скилл обязан быть текстовым, поэтому бинарные
 * блоки пропускаются, а текстовые склеиваются переводом строки.
 *
 * @param {unknown} readResult - результат `resources/read` от MCP-сервера.
 * @returns {string | undefined} склеенный текст, либо undefined, если текста нет.
 */
export function extractResourceText(readResult) {
  if (typeof readResult !== "object" || readResult === null) return void 0;
  const contents = readResult.contents;
  if (!Array.isArray(contents)) return void 0;
  const texts = [];
  for (const block of contents) {
    if (typeof block !== "object" || block === null) continue;
    if (typeof block.text === "string") texts.push(block.text);
  }
  return texts.length > 0 ? texts.join("\n") : void 0;
}

/**
 * Разбирает полный SKILL.md в структуру скилла dsh.
 *
 * Возвращаемая структура нейтральна к провайдеру: из неё `list()` строит
 * кандидата, а `get()` — определение. YAML-парсер передаётся снаружи, чтобы
 * модуль оставался чистым и тестируемым (в проде это `parse` из `yaml`, в
 * smoke-тесте — заглушка).
 *
 * @param {string} raw - полный текст SKILL.md.
 * @param {(text: string) => unknown} parseYaml - парсер YAML-текста в объект.
 * @param {(message: string) => void} [warn] - приёмник диагностики о пропуске
 *   файла (по умолчанию игнорирует).
 * @returns {{ name: string, description: string, whenToUse?: string,
 *   invocation: { modelInvocable: boolean, userInvocable: boolean },
 *   metadata?: object, content: string } | undefined} разобранный скилл, либо
 *   undefined, если файл не является валидным SKILL.md.
 */
export function parseSkillContent(raw, parseYaml, warn = () => {}) {
  const parts = splitFrontmatter(raw);
  if (parts === void 0) {
    warn("missing YAML frontmatter");
    return void 0;
  }
  let data;
  try {
    data = parseYaml(parts.yaml);
  } catch (error) {
    warn(`invalid YAML frontmatter: ${errorMessage(error)}`);
    return void 0;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    warn("frontmatter must be a YAML mapping");
    return void 0;
  }
  const name = stringField(data, "name");
  const description = stringField(data, "description");
  if (name === void 0 || description === void 0) {
    warn("frontmatter requires name and description");
    return void 0;
  }
  if (!SKILL_NAME.test(name)) {
    warn(`invalid skill name "${name}"`);
    return void 0;
  }
  let invocation;
  try {
    invocation = parseInvocationPolicy(data);
  } catch (error) {
    warn(`invalid invocation frontmatter: ${errorMessage(error)}`);
    return void 0;
  }
  return {
    name,
    description,
    ...optionalString(data, "whenToUse"),
    invocation,
    ...optionalMetadata(data),
    content: parts.body.trim()
  };
}

/**
 * Читает непустое строковое поле из frontmatter-объекта.
 *
 * @param {Record<string, unknown>} data - разобранный frontmatter.
 * @param {string} key - имя поля.
 * @returns {string | undefined} значение, либо undefined при не-строке/пустоте.
 */
function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}

/**
 * Упаковывает непустое строковое поле в объект `{ key: value }` для spread.
 *
 * @param {Record<string, unknown>} data - разобранный frontmatter.
 * @param {string} key - имя поля.
 * @returns {Record<string, string>} одно поле, либо пустой объект.
 */
function optionalString(data, key) {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}

/**
 * Разбирает политику вызова скилла из frontmatter-полей.
 *
 * Поля `disable-model-invocation` и `user-invocable` дублируют семантику
 * `dsh-skill-filesystem`: модель может вызывать скилл по умолчанию, человек —
 * тоже; legacy-ключи отклоняются с диагностикой.
 *
 * @param {Record<string, unknown>} data - разобранный frontmatter.
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }} политика.
 */
function parseInvocationPolicy(data) {
  rejectLegacyInvocationKey(data, "disableModelInvocation", "disable-model-invocation");
  rejectLegacyInvocationKey(data, "modelInvocable", "disable-model-invocation");
  rejectLegacyInvocationKey(data, "userInvocable", "user-invocable");
  const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
  const userInvocable = frontmatterBoolean(data, "user-invocable");
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false
  };
}

/**
 * Отклоняет legacy-имя поля, указывая каноническую замену.
 *
 * @param {Record<string, unknown>} data - разобранный frontmatter.
 * @param {string} legacy - недопустимое имя.
 * @param {string} canonical - каноническое имя.
 */
function rejectLegacyInvocationKey(data, legacy, canonical) {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`);
  }
}

/**
 * Читает логическое поле frontmatter, допуская строки и 0/1.
 *
 * @param {Record<string, unknown>} data - разобранный frontmatter.
 * @param {string} key - имя поля.
 * @returns {boolean | undefined} значение, либо undefined при отсутствии поля.
 */
function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return void 0;
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true":
      case "yes":
      case "on": return true;
      case "false":
      case "no":
      case "off": return false;
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

/**
 * Упаковывает объект `metadata` из frontmatter для spread.
 *
 * @param {Record<string, unknown>} data - разобранный frontmatter.
 * @returns {Record<string, object>} поле `metadata`, либо пустой объект.
 */
function optionalMetadata(data) {
  const value = data.metadata;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { metadata: value };
  }
  return {};
}

/**
 * Безопасно приводит произвольное значение ошибки к строке.
 *
 * @param {unknown} error - перехваченная ошибка.
 * @returns {string} её строковое представление.
 */
function errorMessage(error) {
  return String(error);
}

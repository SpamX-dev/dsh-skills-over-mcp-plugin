/**
 * Smoke-тест чистых помощников адаптера `skill://`.
 *
 * Не требует Cordis, MCP-клиента и пакета `yaml`: YAML подменяется маленьким
 * парсером плоских frontmatter-полей. Проверяет контрактные преобразования:
 * фильтрацию URI, разбор frontmatter, извлечение текста из результата
 * `resources/read` и построение структуры скилла.
 *
 * Запуск: `node test/smoke.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractResourceText,
  isSkillUri,
  parseSkillContent,
  skillNameFromUri,
  splitFrontmatter
} from "../lib/skill-frontmatter.js";

/**
 * Парсит плоский YAML-frontmatter: строки, булевы и вложенный `metadata`.
 * Достаточен для проверки контракта, который использует только эти формы.
 *
 * @param {string} text - текст YAML.
 * @returns {Record<string, unknown>} разобранный объект.
 */
function flatYaml(text) {
  const result = {};
  let metadata = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.match(/^ */)[0].length;
    const match = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match === null) continue;
    const key = match[1];
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    if (indent === 0) {
      if (key === "metadata") {
        metadata = {};
        result.metadata = metadata;
      } else {
        result[key] = value;
      }
    } else if (metadata !== null) {
      metadata[key] = value;
    }
  }
  return result;
}

test("isSkillUri принимает только валидные skill:// URI", () => {
  assert.equal(isSkillUri("skill://ast-index"), true);
  assert.equal(isSkillUri("skill://office-docx"), true);
  assert.equal(isSkillUri("skill://a"), true);
  assert.equal(isSkillUri("skill://ast_index"), false); // подчёркивание
  assert.equal(isSkillUri("skill://Ast-Index"), false); // заглавные
  assert.equal(isSkillUri("skill://ast-index/path"), false); // лишний путь
  assert.equal(isSkillUri("file://ast-index"), false);
  assert.equal(isSkillUri("skill://"), false);
  assert.equal(isSkillUri(123), false);
  assert.equal(isSkillUri(null), false);
});

test("skillNameFromUri извлекает имя", () => {
  assert.equal(skillNameFromUri("skill://ast-index"), "ast-index");
  assert.equal(skillNameFromUri("skill://nope_index"), undefined);
});

test("splitFrontmatter разделяет YAML и тело", () => {
  const parts = splitFrontmatter("---\nname: x\ndescription: d\n---\n\n# Body\n");
  assert.deepEqual(parts, { yaml: "name: x\ndescription: d\n", body: "\n# Body\n" });

  // CRLF
  const crlf = splitFrontmatter("---\r\nname: x\r\n---\r\nbody");
  assert.deepEqual(crlf, { yaml: "name: x\r\n", body: "body" });

  // отсутствие открывающего разделителя
  assert.equal(splitFrontmatter("name: x\n---\nbody"), undefined);
  // отсутствие закрывающего разделителя
  assert.equal(splitFrontmatter("---\nname: x\n"), undefined);
  // первая строка не ровно "---"
  assert.equal(splitFrontmatter("---x\nname: x\n---\nbody"), undefined);
});

test("extractResourceText достаёт текст и игнорирует blob", () => {
  const result = {
    contents: [
      { uri: "skill://x", mimeType: "text/markdown", text: "a" },
      { uri: "skill://x", mimeType: "text/markdown", text: "b" },
      { uri: "skill://x", mimeType: "application/octet-stream", blob: "AAAA" }
    ]
  };
  assert.equal(extractResourceText(result), "a\nb");
  assert.equal(extractResourceText({ contents: [{ blob: "AAAA" }] }), undefined);
  assert.equal(extractResourceText({ contents: [] }), undefined);
  assert.equal(extractResourceText(null), undefined);
});

test("parseSkillContent строит полный скилл", () => {
  const raw = [
    "---",
    "name: ast-index",
    "description: Быстрый поиск по коду",
    "whenToUse: Использовать для поиска символов",
    "metadata:",
    "  owner: platform",
    "---",
    "",
    "# ast-index",
    "",
    "Инструкции."
  ].join("\n");
  const skill = parseSkillContent(raw, flatYaml, () => {});
  assert.ok(skill !== undefined);
  assert.equal(skill.name, "ast-index");
  assert.equal(skill.description, "Быстрый поиск по коду");
  assert.equal(skill.whenToUse, "Использовать для поиска символов");
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.deepEqual(skill.metadata, { owner: "platform" });
  assert.equal(skill.content, "# ast-index\n\nИнструкции.");
});

test("parseSkillContent учитывает политику вызова", () => {
  const raw = [
    "---",
    "name: private",
    "description: d",
    "disable-model-invocation: true",
    "user-invocable: false",
    "---",
    "body"
  ].join("\n");
  const skill = parseSkillContent(raw, flatYaml, () => {});
  assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: false });
});

test("parseSkillContent отклоняет невалидные скиллы", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);

  // нет frontmatter
  assert.equal(parseSkillContent("# no frontmatter", flatYaml, warn), undefined);
  // нет description
  assert.equal(parseSkillContent("---\nname: x\n---\nbody", flatYaml, warn), undefined);
  // невалидное имя
  assert.equal(parseSkillContent("---\nname: Bad_Name\ndescription: d\n---\nbody", flatYaml, warn), undefined);
  // legacy-ключ invocation
  assert.equal(
    parseSkillContent("---\nname: x\ndescription: d\ndisableModelInvocation: true\n---\nbody", flatYaml, warn),
    undefined
  );

  assert.ok(warnings.length >= 4, "все пропуски должны логироваться");
});

test("parseSkillContent обрабатывает некорректный YAML", () => {
  const warnings = [];
  const skill = parseSkillContent("---\nname: [\n---\nbody", () => {
    throw new Error("bad yaml");
  }, (message) => warnings.push(message));
  assert.equal(skill, undefined);
  assert.ok(warnings.some((w) => w.includes("invalid YAML frontmatter")));
});

console.log("smoke: all tests passed");

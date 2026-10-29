/**
 * Провайдер скиллов dsh, транслирующий MCP-ресурсы `skill://` в скиллы.
 *
 * Плагин регистрирует на сервисе `skills` провайдера, который НЕ держит
 * собственного MCP-соединения, а читает ресурсы из сервиса `mcpResources` —
 * то есть из уже открытых соединений `@deepseek-ai/dsh-mcp-client`. Это даёт
 * единую точку конфигурации сервера (он задаётся один раз в `dsh-mcp-client`)
 * и исключает второй процесс MCP на тот же сервер.
 *
 * Поведение:
 *   - `list()` перечисляет видимые в scope серверы (или берёт `config.servers`),
 *     запрашивает у каждого `resources/list`, отбирает URI вида `skill://<name>`,
 *     читает каждый такой ресурс и строит кандидата из его SKILL.md;
 *   - `get()` повторно читает ресурс из локатора кандидата и возвращает полное
 *     определение скилла;
 *   - сбой одного сервера или ресурса не роняет весь список: он помечает
 *     наблюдение неполным (`complete: false`), чтобы реестр не кэшировал
 *     частичный результат, и логирует диагностику.
 *
 * Зависимости (сервисы): `skills` (реестр скиллов) и `mcpResources` (доступ к
 * ресурсам MCP). Обе входят в штатные профили dsh.
 *
 * @module @deepseek-ai/dsh-skill-mcp
 */
import z from "@deepseek-ai/schemastery";
import { parse as parseYaml } from "yaml";
import { extractResourceText, isSkillUri, parseSkillContent } from "./skill-frontmatter.js";

/** Имя Cordis-плагина для диагностики загрузчика. */
const name = "skill-mcp";

/** Сервисы, требуемые плагином. */
const inject = ["skills", "mcpResources"];

/** Имя провайдера по умолчанию (поле `provider` у кандидатов и определений). */
const DEFAULT_PROVIDER_NAME = "mcp";

/**
 * Ранг по умолчанию. Чем меньше ранг, тем выше приоритет при совпадении имён
 * между провайдерами. MCP-скиллы ставятся выше bundled-ранга (600), то есть
 * уступают локальным/проектным/пользовательским скиллам с тем же именем, но
 * доступны, когда локального нет. Ранг переопределяется через `config.rank`.
 */
const DEFAULT_RANK = 650;

/** Схема конфигурации плагина (валидируется Schemastery). */
const Config = z.object({
  /** Имя провайдера, публикуемое в `provider` кандидатов и определений. */
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  /** Явный список серверов для «скиллификации»; пустой массив — все видимые. */
  servers: z.array(z.string()).default([]),
  /** Ранг кандидатов этого провайдера. */
  rank: z.number().default(DEFAULT_RANK)
});

/**
 * Регистрирует провайдера на `ctx.skills`. Жизненным циклом провайдера владеет
 * реестр: при выгрузке плагина `registerProvider` абортирует `control.signal` и
 * удаляет регистрацию, поэтому дополнительных эффектов здесь не требуется.
 *
 * @param ctx - Cordis-контекст плагина.
 * @param config - нормализованная конфигурация плагина.
 */
function apply(ctx, config = {}) {
  ctx.skills.registerProvider(() => new McpSkillProvider(ctx, config));
}

/**
 * Провайдер, отображающий `skill://`-ресурсы MCP в каталог `ctx.skills`.
 */
class McpSkillProvider {
  /** Cordis-контекст (доступ к `mcpResources`, логгеру и т.д.). */
  ctx;

  /** Имя провайдера, публикуемое в `provider`. */
  name;

  /** Явный allow-list серверов (пустой — автообнаружение). */
  servers;

  /** Ранг кандидатов. */
  rank;

  /**
   * @param {object} ctx - Cordis-контекст плагина.
   * @param {Record<string, unknown>} config - конфигурация плагина.
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.name = config.providerName ?? DEFAULT_PROVIDER_NAME;
    this.servers = Array.isArray(config.servers) ? [...config.servers] : [];
    this.rank = config.rank ?? DEFAULT_RANK;
    if (typeof this.rank !== "number" || !Number.isFinite(this.rank)) {
      throw new TypeError(`skill-mcp: rank must be a finite number, got ${String(this.rank)}`);
    }
  }

  /**
   * Строит каталог кандидатов: перечисляет серверы, читает их `skill://`-ресурсы
   * и парсит каждый SKILL.md.
   *
   * @param {object} options - опции просмотра от `SkillRegistry`:
   *   `scope` (агент/ключ области), `cwd`, `signal`.
   * @returns {Promise<object[] | { candidates: object[], complete: boolean }>}
   *   массив кандидатов, либо наблюдение с флагом `complete: false` при сбое.
   */
  async list(options) {
    const servers = this.resolveServers(options.scope);
    const candidates = [];
    let complete = true;
    for (const server of servers) {
      throwIfAborted(options.signal);
      let listed;
      try {
        listed = await this.request(server, { method: "resources/list" }, options);
      } catch (error) {
        if (options.signal?.aborted === true) throw toError(options.signal.reason);
        complete = false;
        this.ctx.logger.warn(`skill-mcp: server "${server}" skipped: ${errorMessage(error)}`);
        continue;
      }
      const resources = Array.isArray(listed?.resources) ? listed.resources : [];
      for (const resource of resources) {
        throwIfAborted(options.signal);
        if (!isSkillUri(resource?.uri)) continue;
        let candidate;
        try {
          candidate = await this.readCandidate(server, resource.uri, options);
        } catch (error) {
          if (options.signal?.aborted === true) throw toError(options.signal.reason);
          // Транзиентный сбой чтения: наблюдение неполное, но список не роняем.
          complete = false;
          this.ctx.logger.warn(`skill-mcp: failed to read ${resource.uri} from "${server}": ${errorMessage(error)}`);
          continue;
        }
        // undefined означает «постоянно невалидный SKILL.md» — пропускаем без
        // пометки неполным, чтобы реестр не перечитывал его бесконечно.
        if (candidate === void 0) continue;
        candidates.push(candidate);
      }
    }
    return complete ? candidates : { candidates, complete };
  }

  /**
   * Загружает полное определение скилла по локатору кандидата.
   *
   * @param {object} candidate - выигравший кандидат этого провайдера.
   * @param {object} options - опции просмотра (`signal` отменяет чтение).
   * @returns {Promise<object | undefined>} определение скилла, либо undefined,
   *   если ресурс исчез или перестал быть валидным SKILL.md.
   */
  async get(candidate, options) {
    const locator = candidate.locator;
    let readResult;
    try {
      readResult = await this.request(locator.server, { method: "resources/read", uri: locator.uri }, options);
    } catch (error) {
      if (options.signal?.aborted === true) throw toError(options.signal.reason);
      this.ctx.logger.warn(`skill-mcp: failed to read ${locator.uri} from "${locator.server}": ${errorMessage(error)}`);
      return void 0;
    }
    const raw = extractResourceText(readResult);
    if (raw === void 0) return void 0;
    const parsed = parseSkillContent(raw, parseYaml, (message) => {
      this.ctx.logger.warn(`skill-mcp: ${message} (${locator.uri})`);
    });
    if (parsed === void 0) return void 0;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: {
        kind: "opaque",
        description: `MCP resource ${locator.uri} served by server "${locator.server}"`
      },
      ...(parsed.metadata !== void 0 ? { metadata: parsed.metadata } : {}),
      content: parsed.content
    };
  }

  /**
   * Читает один `skill://`-ресурс и строит из него кандидата.
   *
   * Контракт возврата: транзиентный сбой чтения ПРОБРАСЫВАЕТСЯ исключением
   * (кроме отмены, которая тоже пробрасывается как отмена), а невалидный
   * SKILL.md возвращает `undefined` — так `list()` отличает «повторить позже»
   * от «пропустить навсегда».
   *
   * @param {string} server - имя MCP-сервера.
   * @param {string} uri - URI ресурса вида `skill://<name>`.
   * @param {object} options - опции просмотра.
   * @returns {Promise<object | undefined>} кандидат, либо undefined при
   *   невалидном SKILL.md.
   */
  async readCandidate(server, uri, options) {
    let readResult;
    try {
      readResult = await this.request(server, { method: "resources/read", uri }, options);
    } catch (error) {
      if (options.signal?.aborted === true) throw toError(options.signal.reason);
      throw error;
    }
    const raw = extractResourceText(readResult);
    if (raw === void 0) return void 0;
    const parsed = parseSkillContent(raw, parseYaml, (message) => {
      this.ctx.logger.warn(`skill-mcp: ${message} (${uri})`);
    });
    if (parsed === void 0) return void 0;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== void 0 ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      provider: this.name,
      source: server,
      rank: this.rank,
      locator: { server, uri },
      resourceBase: {
        kind: "opaque",
        description: `MCP resource ${uri} served by server "${server}"`
      },
      ...(parsed.metadata !== void 0 ? { metadata: parsed.metadata } : {})
    };
  }

  /**
   * Выполняет запрос к MCP-серверу через сервис `mcpResources`.
   *
   * @param {string} server - имя сервера, видимое в scope.
   * @param {object} request - метод (`resources/list` | `resources/read`) и его параметры.
   * @param {object} options - опции просмотра; `scope` становится `exec.agent`
   *   для резолва сервера, `signal` — сигналом отмены.
   * @returns {Promise<unknown>} результат запроса.
   */
  request(server, request, options) {
    return this.ctx.mcpResources.request(server, request, {
      agent: options.scope,
      signal: options.signal
    });
  }

  /**
   * Определяет список серверов для опроса.
   *
   * Если `config.servers` непустой — используется как есть (allow-list). Иначе
   * серверы автообнаруживаются через тот же scoped-слой `mcpResources`, который
   * использует системный промпт сервиса (`layers.merge(scope, l => l.servers)`).
   *
   * @param {unknown} scope - ключ области просмотра.
   * @returns {string[]} имена серверов.
   */
  resolveServers(scope) {
    if (this.servers.length > 0) return this.servers;
    try {
      const layers = this.ctx.mcpResources?.layers;
      if (layers === void 0) {
        this.ctx.logger.warn("skill-mcp: mcpResources service exposes no layers; no servers will be discovered");
        return [];
      }
      const merged = layers.merge(scope, (layer) => layer.servers);
      return [...merged.keys()].sort();
    } catch (error) {
      this.ctx.logger.warn(`skill-mcp: failed to enumerate MCP servers: ${errorMessage(error)}`);
      return [];
    }
  }
}

/**
 * Бросает ошибку, если сигнал уже отменён.
 *
 * @param {AbortSignal | undefined} signal - сигнал отмены.
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw toError(signal.reason);
}

/**
 * Приводит произвольную причину отмены/ошибки к объекту Error.
 *
 * @param {unknown} error - причина.
 * @returns {Error} объект ошибки.
 */
function toError(error) {
  try {
    if (error instanceof Error) return error;
  } catch {
    /* v8 ignore next -- instanceof в редких случаях бросает на экзотических объектах. */
  }
  return new Error(errorMessage(error));
}

/**
 * Безопасно приводит ошибку к строке.
 *
 * @param {unknown} error - ошибка.
 * @returns {string} строковое представление.
 */
function errorMessage(error) {
  try {
    return String(error);
  } catch {
    return "[unrenderable thrown value]";
  }
}

export { Config, McpSkillProvider, apply, inject, name };

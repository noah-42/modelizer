import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";

/**
 * The LLM models this machine uses, and the provider each one is served — and billed — under.
 *
 * Association is declared, not inferred. The same model can be reachable through more than one
 * provider (a GPT model through OpenAI directly, or through a router that resells it), and a
 * provider's card can serve several models, so a model name alone does not say who charged you.
 *
 * Kept next to the points rather than inside an adapter: adapters report model strings, this
 * answers "whose model is that".
 */

/** One `[[model]]` block. */
export interface LlmModel {
  /** Model string exactly as an adapter reports it, e.g. `claude-sonnet-5-5`. */
  id: string;
  /** Display name; defaults to `id`. */
  name: string;
  /** Provider id that serves it, matching the card ids (`claude`, `codex`, `zai`, …). */
  provider: string;
  /** Where the entry was read from, when it was added by URL rather than by hand. */
  sourceUrl?: string | undefined;
  /** Context window in tokens, as the provider states it. */
  contextLength?: number | undefined;
  /** USD per million prompt tokens. Kept as quoted, not converted: the rate is theirs. */
  promptUsdPerMTok?: number | undefined;
  /** USD per million completion tokens. */
  completionUsdPerMTok?: number | undefined;
  /** Display rank: lower shows earlier. Unset models follow, alphabetically by name. */
  order?: number | undefined;
}

export class ModelConfigError extends Error {}

export const DEFAULT_MODELS_PATH = "models.toml";

/** Read the catalogue; a missing file is an empty catalogue, a broken one is an error. */
export function loadModels(path = DEFAULT_MODELS_PATH): LlmModel[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const raw = parse(text) as { model?: unknown };
  const blocks = raw.model;
  if (blocks === undefined) return [];
  if (!Array.isArray(blocks)) throw new ModelConfigError(`${path}: [[model]] must be an array of tables`);

  const models = blocks.map((block, index) => parseEntry(block, index, path));
  const seen = new Set<string>();
  for (const model of models) {
    const key = modelKey(model.id);
    if (seen.has(key)) {
      throw new ModelConfigError(`${path}: model "${model.id}" appears more than once — one block per model`);
    }
    seen.add(key);
  }
  return models;
}

function parseEntry(block: unknown, index: number, path: string): LlmModel {
  const where = `${path}: model #${index + 1}`;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new ModelConfigError(`${where}: expected a table`);
  }
  const b = block as Record<string, unknown>;
  const id = requireText(b.id, `${where}: id`);
  const provider = requireText(b.provider, `${where}: provider`);
  const name = b.name === undefined ? id : requireText(b.name, `${where}: name`);
  return {
    id,
    name,
    provider,
    sourceUrl: b.source_url === undefined ? undefined : requireText(b.source_url, `${where}: source_url`),
    contextLength: optionalNumber(b.context_length, `${where}: context_length`),
    promptUsdPerMTok: optionalNumber(b.prompt_usd_per_mtok, `${where}: prompt_usd_per_mtok`),
    completionUsdPerMTok: optionalNumber(b.completion_usd_per_mtok, `${where}: completion_usd_per_mtok`),
    order: optionalNumber(b.order, `${where}: order`),
  };
}

function optionalNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelConfigError(`${where} must be a number`);
  }
  return value;
}

function requireText(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ModelConfigError(`${where} must be a non-empty string`);
  }
  return value.trim();
}

function modelKey(id: string): string {
  return id.trim().toLowerCase();
}

/** A later model cannot be told apart from a missing one, so adding refuses to overwrite a key. */
export class ModelExistsError extends ModelConfigError {}

/** Removing a model that is not in the catalogue. */
export class ModelNotFoundError extends ModelConfigError {}

/**
 * Append one entry to the catalogue, leaving the rest of the file untouched. Written to a temporary
 * sibling and renamed into place so a crash mid-write cannot truncate a catalogue you curated.
 */
export function appendModel(model: LlmModel, path = DEFAULT_MODELS_PATH): void {
  const existing = loadModels(path);
  if (existing.some((m) => modelKey(m.id) === modelKey(model.id))) {
    throw new ModelExistsError(`${path}: "${model.id}" is already in the catalogue`);
  }
  const current = readTextOrEmpty(path);
  const separator = current.trim() === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const next = `${current}${separator}${serializeModel(model, path)}\n`;
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Remove one entry from the catalogue by id, matching the way resolution does: case-insensitive,
 * trimmed. The block is cut out textually, so every other byte of the file — comments, field
 * order, hand-added fields this build does not know — is preserved. Written to a temporary sibling
 * and renamed into place, like appending.
 */
export function removeModel(id: string, path = DEFAULT_MODELS_PATH): void {
  const target = modelKey(id);
  if (target === "") throw new ModelConfigError(`${path}: id must be a non-empty string`);
  const current = readTextOrEmpty(path);
  const lines = current.split("\n");
  const kept: string[] = [];
  let removed = false;
  // One block runs from its `[[model]]` header to the next header or end of file.
  let block: string[] | null = null;
  let blockId: string | null = null;
  const flush = () => {
    if (block === null) return;
    if (blockId === target && !removed) {
      removed = true;
    } else {
      kept.push(...block);
    }
    block = null;
    blockId = null;
  };
  for (const line of lines) {
    if (line.trim() === "[[model]]") {
      flush();
      block = [line];
      blockId = null;
    } else if (block !== null) {
      block.push(line);
      if (blockId === null) {
        const match = /^\s*id\s*=\s*(['"])(.*)\1\s*$/.exec(line);
        if (match !== null) blockId = modelKey(match[2] ?? "");
      }
    } else {
      kept.push(line);
    }
  }
  flush();
  if (!removed) throw new ModelNotFoundError(`${path}: "${id}" is not in the catalogue`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, kept.join("\n"), { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Set the display order of the given ids, in the sequence given: the first id gets `order = 1`,
 * the second `order = 2`, and so on. Ids not listed keep whatever they have. Each `[[model]]`
 * block is edited textually — the `order` line is replaced in place or inserted right after the
 * id line — so comments, field order and hand-added fields survive untouched. Written to a
 * temporary sibling and renamed into place, like appending and removing.
 */
export function setModelOrder(ids: string[], path = DEFAULT_MODELS_PATH): void {
  const targets = new Map<string, number>();
  ids.forEach((id, index) => {
    const key = modelKey(id);
    if (key !== "" && !targets.has(key)) targets.set(key, index + 1);
  });
  if (targets.size === 0) return;
  const lines = readTextOrEmpty(path).split("\n");
  const next: string[] = [];
  let written = 0;
  let block: string[] | null = null;
  let blockId: string | null = null;
  let orderLineSeen = false;
  let idLineAt = -1;
  const flush = () => {
    if (block === null) return;
    if (blockId !== null && targets.has(blockId)) {
      const rank = targets.get(blockId) as number;
      let body: string[];
      if (orderLineSeen) {
        body = block.map((line) => (/^\s*order\s*=/.test(line) ? `order = ${rank}` : line));
      } else {
        // Insert right after the id line so the rank sits inside the entry, not after its
        // trailing blank line.
        body = [...block];
        body.splice(idLineAt + 1, 0, `order = ${rank}`);
      }
      next.push(...body);
      written += 1;
    } else {
      next.push(...block);
    }
    block = null;
    blockId = null;
    orderLineSeen = false;
    idLineAt = -1;
  };
  for (const line of lines) {
    if (line.trim() === "[[model]]") {
      flush();
      block = [line];
      blockId = null;
    } else if (block !== null) {
      if (blockId === null) {
        const match = /^\s*id\s*=\s*(['"])(.*)\1\s*$/.exec(line);
        if (match !== null) {
          blockId = modelKey(match[2] ?? "");
          idLineAt = block.length; // insert position once the block is flushed
        }
      }
      block.push(line);
      if (/^\s*order\s*=/.test(line)) orderLineSeen = true;
    } else {
      next.push(line);
    }
  }
  flush();
  if (written < targets.size) {
    const present = new Set(lines.map((line) => modelKey(idOfIdLine(line))).filter((key) => key !== ""));
    const missing = [...targets.keys()].filter((key) => !present.has(key));
    throw new ModelNotFoundError(`${path}: not in the catalogue: ${missing.join(", ")}`);
  }
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, next.join("\n"), { mode: 0o600 });
  renameSync(temporary, path);
}

function idOfIdLine(line: string): string {
  const match = /^\s*id\s*=\s*(['"])(.*)\1\s*$/.exec(line);
  return match === null ? "" : (match[2] ?? "");
}

function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** One block, in the field order the example file documents; empty fields are left out. */
function serializeModel(model: LlmModel, path: string): string {
  const lines = ["[[model]]", `id = ${quote(model.id)}`, `name = ${quote(model.name)}`];
  if (model.provider.trim() === "") throw new ModelConfigError(`${path}: provider is required`);
  lines.push(`provider = ${quote(model.provider)}`);
  if (model.sourceUrl !== undefined) lines.push(`source_url = ${quote(model.sourceUrl)}`);
  if (model.contextLength !== undefined) lines.push(`context_length = ${model.contextLength}`);
  if (model.promptUsdPerMTok !== undefined) lines.push(`prompt_usd_per_mtok = ${model.promptUsdPerMTok}`);
  if (model.completionUsdPerMTok !== undefined) lines.push(`completion_usd_per_mtok = ${model.completionUsdPerMTok}`);
  if (model.order !== undefined) lines.push(`order = ${model.order}`);
  return lines.join("\n");
}

/** JSON string quoting is valid TOML basic-string quoting. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Model → provider lookup. Provider APIs report versioned ids (`claude-sonnet-5-5-20260101`),
 * so an exact match wins and otherwise the longest configured prefix does.
 */
export class ModelCatalog {
  private readonly models: LlmModel[];
  private readonly exact: Map<string, LlmModel>;
  /** Longest ids first, so the first prefix hit is the most specific one. */
  private readonly byLength: LlmModel[];

  constructor(models: LlmModel[]) {
    this.models = models;
    this.exact = new Map(models.map((m) => [modelKey(m.id), m]));
    this.byLength = [...models].sort((a, b) => b.id.length - a.id.length);
  }

  /** The entry for a reported model string, or null when the catalogue does not know it. */
  resolve(reported: string): LlmModel | null {
    const key = modelKey(reported);
    if (key === "") return null;
    const direct = this.exact.get(key);
    if (direct !== undefined) return direct;
    const prefixed = this.byLength.find((m) => key.startsWith(modelKey(m.id)));
    return prefixed ?? null;
  }

  /** Which provider serves a reported model string; null when unknown. */
  providerOf(reported: string): string | null {
    return this.resolve(reported)?.provider ?? null;
  }

  /** Every known model, one provider's or all of them. Ordered by `order`, then name. */
  list(provider?: string): LlmModel[] {
    const rows = provider === undefined ? this.models : this.models.filter((m) => m.provider === provider);
    return rows.sort((a, b) => {
      if (a.order !== undefined || b.order !== undefined) {
        const byOrder = (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);
        if (byOrder !== 0) return byOrder;
      }
      return a.name < b.name ? -1 : 1;
    });
  }
}

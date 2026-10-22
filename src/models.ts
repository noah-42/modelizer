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

  /** Every known model, one provider's or all of them, alphabetically. */
  list(provider?: string): LlmModel[] {
    const rows = provider === undefined ? this.models : this.models.filter((m) => m.provider === provider);
    return [...rows].sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

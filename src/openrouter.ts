import type { LlmModel } from "./models";

/**
 * Add a model by its OpenRouter page, so the catalogue can grow without hand-editing TOML.
 *
 * Only the model id is taken from the pasted link; the metadata always comes from OpenRouter's own
 * catalogue endpoint. Nothing is fetched from the URL the user typed, so a pasted link cannot make
 * the server request an arbitrary host.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** Router-owned attribution: these models are reachable, and billed, through Open Router. */
export const OPENROUTER_PROVIDER = "openrouter";

/** A page on openrouter.ai naming one model, e.g. `https://openrouter.ai/openai/gpt-5`. */
export interface OpenRouterRef {
  /** Catalogue id, e.g. `openai/gpt-5` (a `:free` suffix is part of the id). */
  id: string;
  /** Canonical link, so the file records where the entry came from. */
  url: string;
}

export class OpenRouterUrlError extends Error {}
export class OpenRouterUnknownModelError extends Error {}

const HOSTS = new Set(["openrouter.ai", "www.openrouter.ai"]);
/** Model pages sit at the root; listing pages prefix the path with this segment. */
const LIST_PATH = "models";
const URL_SEGMENTS = 2;

/**
 * Read a model id out of an OpenRouter link. Also accepts a bare `author/slug`, because that is
 * what the site's own API returns and what people paste from logs.
 */
export function parseModelRef(input: string): OpenRouterRef {
  const text = input.trim();
  if (text === "") throw new OpenRouterUrlError("paste an OpenRouter model link");

  const isBare = !text.includes("://") && !text.startsWith("openrouter.ai");
  if (isBare) return { id: requireId(text), url: pageUrl(requireId(text)) };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OpenRouterUrlError(`"${text}" is not a URL`);
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) {
    throw new OpenRouterUrlError(`${url.hostname} is not openrouter.ai — paste the model's page there`);
  }
  const segments = url.pathname.split("/").filter((s) => s !== "");
  if (segments[0]?.toLowerCase() === LIST_PATH) segments.shift();
  if (segments.length !== URL_SEGMENTS) {
    throw new OpenRouterUrlError(`expected a link like ${pageUrl("openai/gpt-5")}`);
  }
  const id = requireId(decodeURIComponent(segments.join("/")));
  return { id, url: pageUrl(id) };
}

function requireId(candidate: string): string {
  const parts = candidate.split("/");
  if (parts.length !== URL_SEGMENTS || parts.some((p) => p.trim() === "")) {
    throw new OpenRouterUrlError(`"${candidate}" is not an OpenRouter model id (author/slug)`);
  }
  return parts.join("/");
}

function pageUrl(id: string): string {
  return `https://openrouter.ai/${id}`;
}

/** One entry of the catalogue endpoint, narrowed to what we store. */
interface CatalogueEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  canonical_slug?: unknown;
}

/**
 * Look a model up in OpenRouter's catalogue and shape it for models.toml. Pricing arrives as USD
 * per token in a string; the catalogue records USD per million, which is how models are compared.
 */
export function modelFromCatalogue(json: unknown, ref: OpenRouterRef): LlmModel {
  const entries = readEntries(json);
  const wanted = ref.id.toLowerCase();
  const entry =
    entries.find((e) => typeof e.id === "string" && e.id.toLowerCase() === wanted) ??
    entries.find((e) => typeof e.canonical_slug === "string" && e.canonical_slug.toLowerCase() === wanted);
  if (entry === undefined) {
    throw new OpenRouterUnknownModelError(`OpenRouter lists no model "${ref.id}"`);
  }
  return {
    id: ref.id,
    name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : ref.id,
    provider: OPENROUTER_PROVIDER,
    sourceUrl: ref.url,
    contextLength: positiveInt(entry.context_length),
    promptUsdPerMTok: perMillion(entry.pricing?.prompt),
    completionUsdPerMTok: perMillion(entry.pricing?.completion),
  };
}

function readEntries(json: unknown): CatalogueEntry[] {
  const data = json !== null && typeof json === "object" ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new OpenRouterUnknownModelError("OpenRouter answered without a model list");
  return data.filter((e): e is CatalogueEntry => e !== null && typeof e === "object");
}

/** Per-token price to per-million; absent or unparseable stays absent rather than becoming 0. */
function perMillion(value: unknown): number | undefined {
  const perToken = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return perToken * 1_000_000;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/** Fetch the catalogue and pull one model out of it. */
export async function fetchOpenRouterModel(
  ref: OpenRouterRef,
  fetchFn: typeof fetch = fetch,
): Promise<LlmModel> {
  const res = await fetchFn(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new OpenRouterUnknownModelError(`OpenRouter catalogue answered HTTP ${res.status}`);
  return modelFromCatalogue(await res.json(), ref);
}

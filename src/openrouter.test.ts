import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModels, ModelExistsError, appendModel, ModelCatalog } from "./models";
import { modelFromCatalogue, normalizeProviderId, parseModelRef } from "./openrouter";

describe("parseModelRef", () => {
  test("reads the id from a model page link", () => {
    expect(parseModelRef("https://openrouter.ai/openai/gpt-5")).toEqual({
      id: "openai/gpt-5",
      url: "https://openrouter.ai/openai/gpt-5",
    });
  });

  test("handles the models listing path, a trailing slash and a query string", () => {
    expect(parseModelRef("https://openrouter.ai/models/openai/gpt-5?utm=x").id).toBe("openai/gpt-5");
    expect(parseModelRef("https://openrouter.ai/openai/gpt-5/").id).toBe("openai/gpt-5");
  });

  test("keeps a :free suffix and a version, because they are part of the id", () => {
    expect(parseModelRef("https://openrouter.ai/recursive/flint-v1.0:free").id).toBe(
      "recursive/flint-v1.0:free",
    );
  });

  test("accepts a bare author/slug", () => {
    expect(parseModelRef("openai/gpt-5").id).toBe("openai/gpt-5");
  });

  test("refuses hosts that are not openrouter, so a pasted link cannot redirect the fetch", () => {
    expect(() => parseModelRef("https://evil.example/openai/gpt-5")).toThrow(/not openrouter\.ai/);
  });

  test("refuses links that do not name exactly one model", () => {
    expect(() => parseModelRef("https://openrouter.ai/models")).toThrow(/exactly one model|like/);
    expect(() => parseModelRef("https://openrouter.ai/a/b/c")).toThrow();
    expect(() => parseModelRef("   ")).toThrow(/paste an OpenRouter model link/);
  });
});

describe("normalizeProviderId", () => {
  test("defaults to Open Router when no provider is given", () => {
    expect(normalizeProviderId(undefined)).toBe("openrouter");
    expect(normalizeProviderId("  ")).toBe("openrouter");
  });

  test("accepts the providers a section can be filed under", () => {
    expect(normalizeProviderId("DeepSeek")).toBe("deepseek");
    expect(normalizeProviderId(" cursor ")).toBe("cursor");
  });

  test("refuses ids that would not survive as a TOML key or heading", () => {
    expect(() => normalizeProviderId("has space")).toThrow(/not a provider id/);
    expect(() => normalizeProviderId("-leading")).toThrow();
  });
});

describe("modelFromCatalogue", () => {
  const catalogue = {
    data: [
      {
        id: "openai/gpt-5",
        canonical_slug: "openai/gpt-5-20260101",
        name: "OpenAI: GPT-5",
        context_length: 400_000,
        pricing: { prompt: "0.00000125", completion: "0.00001" },
      },
      {
        id: "recursive/flint-v1.0:free",
        name: "Recursive: Flint (free)",
        context_length: 262_144,
        pricing: { prompt: "0", completion: "0" },
      },
    ],
  };

  test("shapes one model with per-million prices and the Open Router provider", () => {
    const ref = parseModelRef("https://openrouter.ai/openai/gpt-5");
    expect(modelFromCatalogue(catalogue, ref)).toEqual({
      id: "openai/gpt-5",
      name: "OpenAI: GPT-5",
      provider: "openrouter",
      sourceUrl: "https://openrouter.ai/openai/gpt-5",
      contextLength: 400_000,
      promptUsdPerMTok: 1.25,
      completionUsdPerMTok: 10,
    });
  });

  test("a free model prices at zero, not absent", () => {
    const model = modelFromCatalogue(catalogue, parseModelRef("recursive/flint-v1.0:free"));
    expect(model.promptUsdPerMTok).toBe(0);
    expect(model.completionUsdPerMTok).toBe(0);
  });

  test("an unknown model is an error, not an empty entry", () => {
    expect(() => modelFromCatalogue(catalogue, parseModelRef("openai/gpt-99"))).toThrow(/lists no model/);
    expect(() => modelFromCatalogue({ data: "nope" }, parseModelRef("openai/gpt-5"))).toThrow();
  });
});

describe("appendModel", () => {
  const root = mkdtempSync(join(tmpdir(), "modelizer-append-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function path(name: string): string {
    return join(root, name);
  }

  test("creates a catalogue when there is none, and appends without disturbing existing blocks", () => {
    const file = path("fresh.toml");
    writeFileSync(
      file,
      '[[model]]\nid = "claude-opus-5-5"\nname = "Claude Opus 5.5"\nprovider = "claude"\n',
    );
    appendModel(
      {
        id: "openai/gpt-5",
        name: "OpenAI: GPT-5",
        provider: "openrouter",
        sourceUrl: "https://openrouter.ai/openai/gpt-5",
        contextLength: 400_000,
        promptUsdPerMTok: 1.25,
        completionUsdPerMTok: 10,
      },
      file,
    );
    const text = readFileSync(file, "utf8");
    expect(text).toContain('id = "claude-opus-5-5"');
    expect(text).toContain('id = "openai/gpt-5"');
    expect(text).toContain("prompt_usd_per_mtok = 1.25");
    expect(loadModels(file)).toHaveLength(2);
  });

  test("refuses a duplicate id regardless of case", () => {
    const file = path("dup.toml");
    writeFileSync(file, '[[model]]\nid = "openai/gpt-5"\nprovider = "openrouter"\n');
    expect(() =>
      appendModel({ id: "OpenAI/GPT-5", name: "dup", provider: "openrouter" }, file),
    ).toThrow(ModelExistsError);
  });

  test("an appended entry resolves like a hand-written one", () => {
    const file = path("resolve.toml");
    appendModel(
      { id: "openai/gpt-5", name: "OpenAI: GPT-5", provider: "openrouter" },
      file,
    );
    expect(new ModelCatalog(loadModels(file)).providerOf("openai/gpt-5")).toBe("openrouter");
  });
});

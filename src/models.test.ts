import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModels, ModelCatalog, ModelConfigError, ModelNotFoundError, removeModel, type LlmModel } from "./models";

const root = mkdtempSync(join(tmpdir(), "modelizer-models-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function configFile(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

describe("loadModels", () => {
  test("returns an empty catalogue when the file does not exist", () => {
    expect(loadModels(join(root, "absent.toml"))).toEqual([]);
  });

  test("parses each block, defaulting the display name to the id", () => {
    const path = configFile(
      "ok.toml",
      [
        "[[model]]",
        'id = "claude-opus-5-5"',
        'name = "Claude Opus 5.5"',
        'provider = "claude"',
        "",
        "[[model]]",
        'id = "gpt-6-luna"',
        'provider = "codex"',
        "",
      ].join("\n"),
    );
    expect(loadModels(path)).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "claude" },
      { id: "gpt-6-luna", name: "gpt-6-luna", provider: "codex" },
    ]);
  });

  test("rejects a block without an id or a provider", () => {
    const noId = configFile("no-id.toml", '[[model]]\nprovider = "codex"\n');
    expect(() => loadModels(noId)).toThrow(/model #1: id must be a non-empty string/);
    const noProvider = configFile("no-provider.toml", '[[model]]\nid = "gpt-6"\n');
    expect(() => loadModels(noProvider)).toThrow(/provider must be a non-empty string/);
  });

  test("rejects the same model twice", () => {
    const path = configFile(
      "dupes.toml",
      '[[model]]\nid = "gpt-6"\nprovider = "codex"\n\n[[model]]\nid = "GPT-6"\nprovider = "openrouter"\n',
    );
    expect(() => loadModels(path)).toThrow(/appears more than once/);
  });

  test("rejects a block that is not a table", () => {
    expect(() => loadModels(configFile("array.toml", "model = [1, 2]\n"))).toThrow(/model #1: expected a table/);
    expect(() => loadModels(configFile("text.toml", 'model = "gpt-6"\n'))).toThrow(ModelConfigError);
  });
});

describe("ModelCatalog", () => {
  const models: LlmModel[] = [
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "claude" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "claude" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "codex" },
    { id: "glm-5.3", name: "GLM-5.3", provider: "zai" },
  ];

  test("resolves a model to the provider that serves it", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.providerOf("claude-opus-5-5")).toBe("claude");
    expect(catalog.providerOf("gpt-6.1-sol")).toBe("codex");
  });

  test("matches case-insensitively", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.resolve("Claude-Opus-5-5")?.provider).toBe("claude");
  });

  test("matches a versioned id to its base model", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.providerOf("claude-sonnet-5-5-20260101")).toBe("claude");
    expect(catalog.providerOf("gpt-6.1-sol-2026-03")).toBe("codex");
  });

  test("prefers the longest configured prefix", () => {
    const catalog = new ModelCatalog([
      { id: "gpt-6", name: "GPT-6", provider: "openrouter" },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "codex" },
    ]);
    expect(catalog.providerOf("gpt-6.1-sol")).toBe("codex");
    expect(catalog.providerOf("gpt-6-mini")).toBe("openrouter");
  });

  test("returns null for an unknown or empty model instead of guessing", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.resolve("mystery-1")).toBeNull();
    expect(catalog.providerOf("")).toBeNull();
    expect(catalog.providerOf("<synthetic>")).toBeNull();
  });

  test("lists one provider's models alphabetically", () => {
    const catalog = new ModelCatalog(models);
    expect(catalog.list("claude").map((m) => m.name)).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5"]);
    expect(catalog.list()).toHaveLength(4);
    expect(catalog.list("zai").map((m) => m.id)).toEqual(["glm-5.3"]);
  });
});

describe("removeModel", () => {
  const original = [
    "# curated by hand",
    "[[model]]",
    'id = "claude-opus-5-5"',
    'provider = "claude"',
    "",
    "[[model]]",
    'id = "gpt-6-luna"',
    "context_length = 262144",
    'provider = "codex"',
    "",
  ].join("\n");

  test("cuts out one block and preserves the rest of the file byte for byte", () => {
    const path = configFile("remove.toml", `${original}\n`);
    removeModel("gpt-6-luna", path);
    expect(readFileSync(path, "utf8")).toBe(
      ["# curated by hand", "[[model]]", 'id = "claude-opus-5-5"', 'provider = "claude"', ""].join("\n"),
    );
  });

  test("matches case-insensitively", () => {
    const path = configFile("remove-case.toml", `${original}\n`);
    removeModel("GPT-6-Luna", path);
    expect(loadModels(path).map((m) => m.id)).toEqual(["claude-opus-5-5"]);
  });

  test("leaves single-quoted ids and hand-added fields intact on the survivors", () => {
    const path = configFile(
      "remove-quotes.toml",
      "[[model]]\nid = 'keep-me'\nprovider = \"zai\"\nextra_field = true\n\n[[model]]\nid = \"drop-me\"\nprovider = \"codex\"\n",
    );
    removeModel("drop-me", path);
    expect(readFileSync(path, "utf8")).toBe(
      "[[model]]\nid = 'keep-me'\nprovider = \"zai\"\nextra_field = true\n",
    );
  });

  test("refuses a model that is not in the catalogue, and leaves the file alone", () => {
    const path = configFile("remove-miss.toml", `${original}\n`);
    expect(() => removeModel("mystery-1", path)).toThrow(ModelNotFoundError);
    expect(readFileSync(path, "utf8")).toBe(`${original}\n`);
  });

  test("works from an empty or absent catalogue with a clear error", () => {
    expect(() => removeModel("gpt-6", configFile("remove-empty.toml", ""))).toThrow(/not in the catalogue/);
    expect(() => removeModel("gpt-6", join(root, "remove-absent.toml"))).toThrow(/not in the catalogue/);
  });

  test("the result still parses", () => {
    const path = configFile("remove-parse.toml", `${original}\n`);
    removeModel("gpt-6-luna", path);
    expect(loadModels(path)).toEqual([{ id: "claude-opus-5-5", name: "claude-opus-5-5", provider: "claude" }]);
  });
});

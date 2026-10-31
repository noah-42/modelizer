import { describe, expect, test } from "bun:test";
import { loadConfig, DEFAULT_CONFIG, setProviderEnabled, setProviderOrder } from "./config";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadConfig", () => {
  test("missing file → defaults", () => {
    const cfg = loadConfig(join(tmpdir(), "modelizer-nope", "x.toml"));
    expect(cfg.server.port).toBe(DEFAULT_CONFIG.server.port);
    expect(cfg.server.bind).toBe("127.0.0.1");
    expect(cfg.providers).toEqual({});
    expect(cfg.order).toEqual(["zai", "claude", "cursor", "codex", "openrouter", "freellmapi", "moonshot"]);
  });

  test("enable and disable update only the selected provider setting", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-cfg-"));
    const path = join(dir, "modelizer.toml");
    const original = `[server]\nport = 9001\n\n[providers.openrouter]\nenabled = true\nnote = "keep"\n\n[providers.zai]\nenabled = true\n`;
    writeFileSync(path, original);

    setProviderEnabled("openrouter", false, path);
    expect(readFileSync(path, "utf8")).toBe(original.replace("enabled = true", "enabled = false"));
    expect(loadConfig(path).providers.zai?.enabled).toBe(true);
  });

  test("provider order persists and loads in the saved sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-cfg-"));
    const path = join(dir, "modelizer.toml");
    writeFileSync(path, "# keep this comment\n[server]\nport = 9001\n\n[providers.zai]\nenabled = true\n");

    setProviderOrder(["codex", "zai"], path);
    expect(loadConfig(path).order).toEqual(["codex", "zai"]);
    expect(readFileSync(path, "utf8")).toContain("# keep this comment");
  });

  test("unknown provider ids throw without changing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-cfg-"));
    const path = join(dir, "modelizer.toml");
    const original = "[server]\nport = 9001\n# retain\n";
    writeFileSync(path, original);

    expect(() => setProviderEnabled("unknown", true, path)).toThrow(/unknown provider/);
    expect(() => setProviderOrder(["zai", "unknown"], path)).toThrow(/unknown provider/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("provider writes preserve unrelated sections and comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-cfg-"));
    const path = join(dir, "modelizer.toml");
    const original = `# header comment
[server]
port = 9001 # inline comment

[scheduler]
tick_seconds = 10

# provider comment
[providers.zai]
enabled = true
`;
    writeFileSync(path, original);

    setProviderEnabled("zai", false, path);
    setProviderOrder(["zai"], path);
    const saved = readFileSync(path, "utf8");
    expect(saved).toContain("# header comment");
    expect(saved).toContain("port = 9001 # inline comment");
    expect(saved).toContain("[scheduler]\ntick_seconds = 10");
    expect(saved).toContain("# provider comment");
    expect(saved).toContain("[providers.zai]\nenabled = false");
  });

  test("parses overrides and enabled providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-cfg-"));
    const path = join(dir, "modelizer.toml");
    writeFileSync(
      path,
      `
[server]
port = 9001
bind = "0.0.0.0"

[scheduler]
tick_seconds = 10

[providers.openrouter]
enabled = true

[providers.zai]
enabled = false
`,
    );
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(9001);
    expect(cfg.server.bind).toBe("0.0.0.0");
    expect(cfg.scheduler.tickSeconds).toBe(10);
    expect(cfg.scheduler.maxBackoffSeconds).toBe(DEFAULT_CONFIG.scheduler.maxBackoffSeconds);
    expect(cfg.providers.openrouter?.enabled).toBe(true);
    expect(cfg.providers.zai?.enabled).toBe(false);
  });

  test("invalid TOML is loud", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-cfg-"));
    const path = join(dir, "bad.toml");
    writeFileSync(path, "this is [not toml");
    expect(() => loadConfig(path)).toThrow(/parse|Toml|toml/i);
  });
});

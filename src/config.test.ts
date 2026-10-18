import { describe, expect, test } from "bun:test";
import { loadConfig, DEFAULT_CONFIG } from "./config";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadConfig", () => {
  test("missing file → defaults", () => {
    const cfg = loadConfig(join(tmpdir(), "modelizer-nope", "x.toml"));
    expect(cfg.server.port).toBe(DEFAULT_CONFIG.server.port);
    expect(cfg.server.bind).toBe("127.0.0.1");
    expect(cfg.providers).toEqual({});
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

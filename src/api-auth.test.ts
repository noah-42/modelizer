import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "./api";
import { openDb } from "./db";
import type { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "modelizer-auth-"));
const db = openDb(join(root, "auth.db"));

function appWith(token?: string): Hono {
  return buildApi({ db, adapters: [], env: {}, token });
}

/** Hono passes the built Env to handlers, so tests can play the socket and claim a peer address. */
function request(app: Hono, path: string, address?: string, headers?: Record<string, string>): Promise<Response> {
  const env = address === undefined ? undefined : { ip: { address } };
  return Promise.resolve(app.request(path, { headers }, env, undefined as never));
}

describe("api auth", () => {
  test("with no token configured the API answers everyone", async () => {
    const app = appWith(undefined);
    expect((await request(app, "/api/overview", "203.0.113.7")).status).toBe(200);
    expect((await request(app, "/api/overview", "127.0.0.1")).status).toBe(200);
  });

  test("a local caller stays trusted once a token is set", async () => {
    const app = appWith("s3cret");
    expect((await request(app, "/api/overview", "127.0.0.1")).status).toBe(200);
    expect((await request(app, "/api/overview", "::1")).status).toBe(200);
  });

  test("a remote caller without the token is refused", async () => {
    const app = appWith("s3cret");
    const res = await request(app, "/api/overview", "203.0.113.7");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("unauthorized");
    expect((await request(app, "/api/overview", "203.0.113.7", { authorization: "Bearer wrong" })).status).toBe(401);
  });

  test("a remote caller with the token passes, as a bearer header or query parameter", async () => {
    const app = appWith("s3cret");
    expect((await request(app, "/api/overview", "203.0.113.7", { authorization: "Bearer s3cret" })).status).toBe(200);
    expect((await request(app, "/api/overview?token=s3cret", "203.0.113.7")).status).toBe(200);
  });

  test("an unknown peer address is treated as remote", async () => {
    const app = appWith("s3cret");
    expect((await request(app, "/api/overview")).status).toBe(401);
  });

  test("the token gates writes as well as reads", async () => {
    const app = appWith("s3cret");
    const res = await request(app, "/api/models", "203.0.113.7", {
      "content-type": "application/json",
    });
    expect(res.status).toBe(401);
  });

  test("MODELIZER_TOKEN enables auth without a config file", async () => {
    const app = buildApi({ db, adapters: [], env: { MODELIZER_TOKEN: "envtoken" } });
    expect((await request(app, "/api/overview", "203.0.113.7")).status).toBe(401);
    expect((await request(app, "/api/overview?token=envtoken", "203.0.113.7")).status).toBe(200);
  });
});

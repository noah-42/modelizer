import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Documented `codex app-server` stdio JSON-RPC.
 * Handshake: `initialize`, then the `initialized` notification, then `account/rateLimits/read`.
 * No thread and no turn — this must not spend a model request.
 * The `"jsonrpc"` field is omitted on the wire, matching the app-server docs.
 */

export interface RpcIo {
  send(msg: unknown): void;
  /** Next JSON message, or null on EOF / timeout. */
  next(timeoutMs: number): Promise<unknown | null>;
  close(): void;
}

export interface AppServerOk {
  ok: true;
  result: unknown;
  raw: string;
  missing: false;
}

export interface AppServerErr {
  ok: false;
  error: string;
  raw: string;
  /** Binary not installed — callers fall back to session logs without a degraded badge. */
  missing: boolean;
}

const CLIENT = { name: "modelizer", title: "modelizer", version: "0.1.0" };

export async function exchangeRateLimits(io: RpcIo, timeoutMs: number): Promise<unknown> {
  io.send({
    method: "initialize",
    id: 1,
    params: { clientInfo: CLIENT },
  });
  await expectResult(io, 1, timeoutMs);
  io.send({ method: "initialized" });
  io.send({ method: "account/rateLimits/read", id: 2 });
  return expectResult(io, 2, timeoutMs);
}

async function expectResult(io: RpcIo, id: number, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await io.next(Math.max(1, deadline - Date.now()));
    if (msg === null) throw new Error("app-server closed before a response");
    if (msg === undefined || typeof msg !== "object") continue;
    const rec = msg as Record<string, unknown>;
    if (rec.id === undefined || rec.id === null) continue;
    if (Number(rec.id) !== id) continue;
    if (rec.error !== undefined && rec.error !== null) {
      const err = rec.error as { message?: unknown };
      const message = typeof err.message === "string" ? err.message : "app-server error";
      throw new Error(message);
    }
    return rec.result ?? null;
  }
  throw new Error("app-server timed out");
}

export async function spawnAppServer(command: string, args: string[], timeoutMs: number): Promise<AppServerOk | AppServerErr> {
  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    const message = (err as Error).message;
    return { ok: false, error: message, raw: "", missing: message.includes("ENOENT") };
  }

  const rawLines: string[] = [];
  const pending: unknown[] = [];
  let waiter: ((msg: unknown | null) => void) | null = null;
  let closed = false;

  const deliver = (msg: unknown | null) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(msg);
    } else if (msg !== null) {
      pending.push(msg);
    }
  };

  const rl = child.stdout ? createInterface({ input: child.stdout }) : null;
  rl?.on("line", (line) => {
    if (rawLines.length < 200) rawLines.push(line);
    try {
      deliver(JSON.parse(line) as unknown);
    } catch {
      // non-JSON log line — ignore
    }
  });

  let missing = false;
  child.on("error", (err) => {
    missing = (err as NodeJS.ErrnoException).code === "ENOENT" || err.message.includes("ENOENT");
    closed = true;
    deliver(null);
  });
  child.on("close", () => {
    closed = true;
    deliver(null);
  });

  const io: RpcIo = {
    send(msg) {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        // process already gone
      }
    },
    next(ms) {
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (waiter) waiter = null;
          resolve(null);
        }, ms);
        waiter = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
      });
    },
    close() {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    },
  };

  try {
    const result = await exchangeRateLimits(io, timeoutMs);
    io.close();
    return { ok: true, result, raw: rawLines.join("\n"), missing: false };
  } catch (err) {
    io.close();
    const message = (err as Error).message;
    return { ok: false, error: message, raw: rawLines.join("\n"), missing };
  }
}

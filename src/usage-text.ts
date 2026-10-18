/**
 * Defensive parser for Claude Code `/usage` prose, the CLI's JSON result, and
 * status-line `rate_limits`. Headless `/usage` is not a supported skill on
 * current Claude Code; "Unknown skill" and empty output are unsupported, not a
 * quota report. Status-line fields are optional on older builds.
 */

export type UsageWindowId = "five_hour" | "weekly";

export interface ParsedUsageWindow {
  window: UsageWindowId;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface HookRecord {
  recordedAt: string;
  error: "rate_limit";
  message: string;
  resetsAt: string | null;
  window: UsageWindowId | null;
}

const ZONES: Record<string, string> = {
  utc: "UTC",
  gmt: "UTC",
  z: "UTC",
  berlin: "Europe/Berlin",
  "europe/berlin": "Europe/Berlin",
  cet: "Europe/Berlin",
  cest: "Europe/Berlin",
  pt: "America/Los_Angeles",
  et: "America/New_York",
  "america/los_angeles": "America/Los_Angeles",
  "america/new_york": "America/New_York",
};

const WEEKDAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Why `claude -p /usage` should not be retried every poll. Null means "try to parse". */
export function usageUnsupportedReason(text: string): "unknown-skill" | "empty" | null {
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (/unknown skill/i.test(trimmed)) return "unknown-skill";
  return null;
}

/**
 * `rate_limits` from a Claude Code statusLine payload (v2.1.80+).
 * Missing `rate_limits`, `five_hour`, or `seven_day` yields no window — older builds omit them.
 */
export function windowsFromRateLimits(rateLimits: unknown): ParsedUsageWindow[] {
  if (rateLimits === null || typeof rateLimits !== "object") return [];
  const root = rateLimits as Record<string, unknown>;
  const out: ParsedUsageWindow[] = [];
  const five = readLimitWindow(root.five_hour);
  const week = readLimitWindow(root.seven_day);
  if (five) out.push({ window: "five_hour", usedPercent: five.usedPercent, resetsAt: five.resetsAt });
  if (week) out.push({ window: "weekly", usedPercent: week.usedPercent, resetsAt: week.resetsAt });
  return out;
}

/** Short status-line text. Empty when no percentage is present. */
export function statuslineText(windows: ParsedUsageWindow[]): string {
  const bits: string[] = [];
  for (const w of windows) {
    if (w.usedPercent === null) continue;
    const label = w.window === "five_hour" ? "5h" : "7d";
    bits.push(`${label} ${Math.round(w.usedPercent)}%`);
  }
  return bits.join(" · ");
}

export function parseUsageText(text: string, now: Date): { windows: ParsedUsageWindow[] } {
  const trimmed = text.trim();
  if (trimmed === "") return { windows: [] };
  if (trimmed.startsWith("{")) {
    const fromJson = parseJsonUsage(trimmed);
    return { windows: fromJson ?? [] };
  }
  const sectioned = parseSections(text, now);
  if (sectioned.length > 0) return { windows: sectioned };
  return { windows: parseOneLiners(text, now) };
}

export function parseResetMention(text: string, now: Date): { resetsAt: string | null; window: UsageWindowId | null } {
  return { resetsAt: extractReset(text, now), window: detectWindow(text) };
}

/** StopFailure payload → file record. Null unless `error` is `rate_limit`. */
export function recordFromHookPayload(payload: unknown, now: Date): HookRecord | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.error !== "rate_limit") return null;

  const bits: string[] = [];
  if (typeof p.message === "string") bits.push(p.message);
  if (typeof p.last_assistant_message === "string") bits.push(p.last_assistant_message);
  if (typeof p.error_details === "string") bits.push(p.error_details);
  const message = bits.join("\n").trim();

  let resetsAt: string | null = null;
  let window: UsageWindowId | null = null;
  if (p.error_details !== null && typeof p.error_details === "object") {
    const d = p.error_details as Record<string, unknown>;
    resetsAt = isoFromUnknown(d.resets_at ?? d.resetsAt);
    window = windowFromToken(d.window ?? d.kind);
  }
  const mentioned = parseResetMention(message, now);
  if (resetsAt === null) resetsAt = mentioned.resetsAt;
  if (window === null) window = mentioned.window;

  return { recordedAt: now.toISOString(), error: "rate_limit", message, resetsAt, window };
}

function parseJsonUsage(text: string): ParsedUsageWindow[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const out: ParsedUsageWindow[] = [];
  const five = readBucket(root.five_hour ?? root.fiveHour ?? root.session);
  const week = readBucket(root.seven_day ?? root.sevenDay ?? root.weekly);
  if (five) out.push({ window: "five_hour", usedPercent: five.percent, resetsAt: five.resetsAt });
  if (week) out.push({ window: "weekly", usedPercent: week.percent, resetsAt: week.resetsAt });
  return out.length > 0 ? out : null;
}

function readBucket(v: unknown): { percent: number; resetsAt: string | null } | null {
  if (v === null || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const percent = typeof b.utilization === "number"
    ? b.utilization
    : typeof b.percent === "number"
      ? b.percent
      : typeof b.usedPercent === "number"
        ? b.usedPercent
        : typeof b.used_percent === "number"
          ? b.used_percent
          : null;
  if (percent === null || !Number.isFinite(percent)) return null;
  return { percent, resetsAt: isoFromUnknown(b.resets_at ?? b.resetsAt) };
}

function parseSections(text: string, now: Date): ParsedUsageWindow[] {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ window: UsageWindowId; scoped: boolean; lines: string[] }> = [];
  let current: { window: UsageWindowId; scoped: boolean; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      if (current && current.lines.length > 0) sections.push(current);
      current = { window: heading.window, scoped: heading.scoped, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current && current.lines.length > 0) sections.push(current);
  if (sections.length === 0) return [];

  const found = new Map<UsageWindowId, ParsedUsageWindow>();
  const scopedWeekly: ParsedUsageWindow[] = [];
  for (const section of sections) {
    const body = section.lines.join("\n");
    const pct = firstPercent(body);
    const parsed: ParsedUsageWindow = {
      window: section.window,
      usedPercent: pct,
      resetsAt: extractReset(body, now),
    };
    if (parsed.usedPercent === null && parsed.resetsAt === null) continue;
    if (section.window === "weekly" && section.scoped) {
      scopedWeekly.push(parsed);
      continue;
    }
    if (!found.has(section.window)) found.set(section.window, parsed);
  }
  if (!found.has("weekly") && scopedWeekly[0]) found.set("weekly", scopedWeekly[0]);
  return [...found.values()];
}

function headingOf(line: string): { window: UsageWindowId; scoped: boolean } | null {
  if (line.includes("%")) return null;
  const week = /week|7[-\s]?day/i.test(line);
  const session = /session|5[-\s]?hour|\b5h\b/i.test(line);
  if (!week && !session) return null;
  if (!/current|limit|window|usage|session|week/i.test(line)) return null;
  const scoped = week && /only|sonnet|opus|haiku/i.test(line) && !/all models/i.test(line);
  if (week && !session) return { window: "weekly", scoped };
  if (session && !week) return { window: "five_hour", scoped: false };
  return null;
}

function parseOneLiners(text: string, now: Date): ParsedUsageWindow[] {
  const rules: Array<{ window: UsageWindowId; re: RegExp }> = [
    { window: "five_hour", re: /(?:session|5[-\s]?hour)\b/i },
    { window: "weekly", re: /(?:weekly|7[-\s]?day|\bweek\b)\b/i },
  ];
  const out: ParsedUsageWindow[] = [];
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (m === null || m.index === undefined) continue;
    const line = lineAt(text, m.index);
    const pct = firstPercent(line);
    if (pct === null) continue;
    out.push({ window: rule.window, usedPercent: pct, resetsAt: extractReset(line, now) });
  }
  return out;
}

function firstPercent(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

export function extractReset(text: string, now: Date): string | null {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso !== null) {
    const parsed = Date.parse(iso[0]);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const spaced = text.match(/\b(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(UTC|GMT|Z)?\b/i);
  if (spaced !== null) {
    const y = Number(spaced[1]);
    const mo = Number(spaced[2]);
    const d = Number(spaced[3]);
    const h = Number(spaced[4]);
    const mi = Number(spaced[5]);
    const zone = findZone(spaced[7] ?? "UTC") ?? "UTC";
    return zonedTimeToUtc(y, mo, d, h, mi, zone).toISOString();
  }

  const epoch = text.match(/\b(\d{10,13})\b/);
  if (epoch !== null && epoch[1] !== undefined && /reset/i.test(text)) {
    const n = Number(epoch[1]);
    if (n > 1e9) return new Date(epoch[1].length >= 13 ? n : n * 1000).toISOString();
  }

  const rel = relativeMs(text);
  if (rel !== null) return new Date(now.getTime() + rel).toISOString();

  const zone = findZone(text);
  const month = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (month !== null) {
    const key = (month[1] ?? "").slice(0, 3).toLowerCase();
    const mo = MONTHS[key];
    const hour = to24(Number(month[4]), month[6]);
    if (mo !== undefined && hour !== null) {
      const year = month[3] ? Number(month[3]) : now.getUTCFullYear();
      const minute = Number(month[5] ?? 0);
      const zoneName = zone ?? "UTC";
      let when = zonedTimeToUtc(year, mo, Number(month[2]), hour, minute, zoneName);
      if (!month[3] && when.getTime() <= now.getTime()) {
        when = zonedTimeToUtc(year + 1, mo, Number(month[2]), hour, minute, zoneName);
      }
      return when.toISOString();
    }
  }

  const weekday = text.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (weekday !== null && weekday[1] !== undefined) {
    const dow = WEEKDAY[weekday[1].slice(0, 3).toLowerCase()];
    const hour = to24(Number(weekday[2]), weekday[4]);
    if (dow !== undefined && hour !== null) {
      return nextWeekday(now, dow, hour, Number(weekday[3] ?? 0), zone).toISOString();
    }
  }

  const clock = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    ?? text.match(/\bresets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\b/i);
  if (clock !== null) {
    const hour = to24(Number(clock[1]), clock[3]);
    if (hour !== null) return nextClock(now, hour, Number(clock[2] ?? 0), zone).toISOString();
  }
  return null;
}

function relativeMs(text: string): number | null {
  const day = /resets?\s+in\s+(\d+)\s*d(?:ays?)?(?:\s+(\d+)\s*h(?:ours?|rs?)?)?(?:\s+(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
  if (day !== null) {
    return (Number(day[1]) * 86_400 + Number(day[2] ?? 0) * 3_600 + Number(day[3] ?? 0) * 60) * 1000;
  }
  const hour = /resets?\s+in\s+(\d+)\s*h(?:ours?|rs?)?(?:\s+(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
  if (hour !== null) return (Number(hour[1]) * 3_600 + Number(hour[2] ?? 0) * 60) * 1000;
  const min = /resets?\s+in\s+(\d+)\s*m(?:in(?:ute)?s?)?/i.exec(text);
  if (min !== null && min[1] !== undefined) return Number(min[1]) * 60_000;
  return null;
}

function detectWindow(text: string): UsageWindowId | null {
  const parts = text.split(/[\n.]/);
  for (const part of parts) {
    if (!/reset/i.test(part)) continue;
    const kind = kindFrom(part);
    if (kind) return kind;
  }
  return kindFrom(text);
}

function kindFrom(text: string): UsageWindowId | null {
  const week = /week|7[-\s]?day/i.test(text);
  const session = /session|5[-\s]?hour|\b5h\b/i.test(text);
  if (week && !session) return "weekly";
  if (session && !week) return "five_hour";
  if (week && session) {
    const wi = text.search(/week|7[-\s]?day/i);
    const si = text.search(/session|5[-\s]?hour|\b5h\b/i);
    const ri = text.search(/reset/i);
    if (ri >= 0) return Math.abs(wi - ri) < Math.abs(si - ri) ? "weekly" : "five_hour";
    return "five_hour";
  }
  return null;
}

function windowFromToken(v: unknown): UsageWindowId | null {
  if (typeof v !== "string") return null;
  if (v === "five_hour" || v === "session" || v === "fiveHour") return "five_hour";
  if (v === "weekly" || v === "seven_day" || v === "sevenDay") return "weekly";
  return null;
}

function readLimitWindow(v: unknown): { usedPercent: number | null; resetsAt: string | null } | null {
  if (v === null || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const usedPercent = finiteNum(b.used_percentage ?? b.usedPercent ?? b.utilization);
  const resetsAt = limitResetIso(b.resets_at ?? b.resetsAt);
  if (usedPercent === null && resetsAt === null) return null;
  return { usedPercent, resetsAt };
}

function finiteNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Unix seconds, unix ms, or ISO. Zero and unparsable values are absent, not epoch. */
function limitResetIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 0) return null;
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return limitResetIso(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return new Date(parsed).toISOString();
  }
  return null;
}

function isoFromUnknown(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return null;
}

function findZone(text: string): string | null {
  const m = text.match(/\b(UTC|GMT|Europe\/Berlin|America\/Los_Angeles|America\/New_York|Berlin|CET|CEST|PT|ET)\b/i);
  if (m === null || m[1] === undefined) return null;
  return ZONES[m[1].toLowerCase()] ?? null;
}

function to24(hour: number, ampm: string | undefined): number | null {
  if (!Number.isFinite(hour)) return null;
  if (ampm !== undefined && ampm !== "") {
    const ap = ampm.toLowerCase();
    if (hour < 1 || hour > 12) return null;
    if (ap === "am") return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
  }
  if (hour < 0 || hour > 23) return null;
  return hour;
}

function nextWeekday(now: Date, dow: number, hour: number, minute: number, zone: string | null): Date {
  const base = zone
    ? zonedParts(now, zone)
    : { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(), dow: now.getUTCDay() };
  let add = (dow - base.dow + 7) % 7;
  const n = normalizeYmd(base.year, base.month, base.day + add);
  let when = makeInstant(n.y, n.m, n.d, hour, minute, zone);
  if (when.getTime() <= now.getTime()) {
    const later = normalizeYmd(n.y, n.m, n.d + 7);
    when = makeInstant(later.y, later.m, later.d, hour, minute, zone);
  }
  return when;
}

function nextClock(now: Date, hour: number, minute: number, zone: string | null): Date {
  const base = zone
    ? zonedParts(now, zone)
    : { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(), dow: now.getUTCDay() };
  let when = makeInstant(base.year, base.month, base.day, hour, minute, zone);
  if (when.getTime() <= now.getTime()) {
    const n = normalizeYmd(base.year, base.month, base.day + 1);
    when = makeInstant(n.y, n.m, n.d, hour, minute, zone);
  }
  return when;
}

function makeInstant(y: number, m: number, d: number, hour: number, minute: number, zone: string | null): Date {
  if (zone === null) return new Date(Date.UTC(y, m - 1, d, hour, minute));
  return zonedTimeToUtc(y, m, d, hour, minute, zone);
}

function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dow: dowMap[parts.weekday ?? ""] ?? date.getUTCDay(),
  };
}

function normalizeYmd(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Wall-clock time in an IANA zone → UTC. Two passes cover a DST offset. */
export function zonedTimeToUtc(y: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const n = normalizeYmd(y, month, day);
  const want = Date.UTC(n.y, n.m - 1, n.d, hour, minute);
  let utc = want;
  for (let i = 0; i < 2; i++) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    utc += want - asUtc;
  }
  return new Date(utc);
}

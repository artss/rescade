import { z } from "zod";
import type { BackupSet, Cascade, Repo, Retention } from "./types.js";

/* ---------- durations ---------- */

export const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s", "10m", "2h", "1d", "250ms" -> milliseconds. */
export function parseDuration(text: string): number {
  const match = DURATION_RE.exec(text);
  if (!match) throw new Error(`invalid duration "${text}"`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

/** Milliseconds -> "250ms", "45s", "10m", "1m30s", "2h", "2h15m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
}

export const duration = z
  .string()
  .regex(DURATION_RE, 'expected a duration such as "30s", "10m" or "2h"');

/* ---------- shared pieces ---------- */

/** A reference to another entry by name. */
export const ref = z.string().min(1);

const stringList = z.array(z.string().min(1));

/** Environment values may be written as numbers or booleans in YAML; they are strings in the end. */
const envValue = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v));
export const envMap = z.record(z.string(), envValue);

/* ---------- repos ---------- */

const count = z.number().int().min(0);

export const RetentionSchema = z
  .strictObject({
    last: count.optional(),
    hourly: count.optional(),
    daily: count.optional(),
    weekly: count.optional(),
    monthly: count.optional(),
    yearly: count.optional(),
    within: z
      .string()
      .regex(/^(\d+[ymdh])+$/, 'expected a restic duration such as "2y6m" or "30d"')
      .optional(),
  })
  .refine((r) => Object.values(r).some((v) => v !== undefined), {
    error: "retention must set at least one of: last, hourly, daily, weekly, monthly, yearly, within",
  });

export const RepoSchema = z.strictObject({
  path: z.string().min(1),
  password: z.string().min(1),
  from: ref.optional(),
  retention: RetentionSchema.optional(),
  env: envMap.optional(),
  options: envMap.optional(),
});

export function normalizeRepo(v: z.output<typeof RepoSchema>): Repo {
  return {
    path: v.path,
    password: v.password,
    from: v.from,
    retention: v.retention as Retention | undefined,
    env: v.env ?? {},
    options: v.options ?? {},
  };
}

/* ---------- sets ---------- */

export const SetSchema = z.strictObject({
  include: stringList.min(1, "a set needs at least one path in include"),
  exclude: stringList.optional(),
  tags: stringList.optional(),
  "one-file-system": z.boolean().optional(),
  "exclude-caches": z.boolean().optional(),
});

export function normalizeSet(v: z.output<typeof SetSchema>): BackupSet {
  return {
    include: v.include,
    exclude: v.exclude ?? [],
    tags: v.tags ?? [],
    oneFileSystem: v["one-file-system"] ?? false,
    excludeCaches: v["exclude-caches"] ?? false,
  };
}

/* ---------- cascades (steps are validated separately, see steps.ts) ---------- */

export const CascadeSchema = z.strictObject({
  description: z.string().optional(),
  schedule: z
    .union([z.string().min(1), stringList.min(1)], {
      error: "schedule must be a cron expression or a list of cron expressions",
    })
    .optional(),
  timezone: z.string().min(1).optional(),
  "on-busy": z.enum(["wait", "skip"]).optional(),
  "wait-timeout": duration.optional(),
  steps: z.array(z.unknown()).min(1, "a cascade needs at least one step"),
});

export type CascadeHeader = Omit<Cascade, "steps">;

export function normalizeCascadeHeader(v: z.output<typeof CascadeSchema>): CascadeHeader {
  const schedule = v.schedule === undefined ? [] : Array.isArray(v.schedule) ? v.schedule : [v.schedule];
  return {
    description: v.description,
    schedule,
    timezone: v.timezone,
    onBusy: v["on-busy"] ?? "skip",
    waitTimeoutMs: v["wait-timeout"] === undefined ? undefined : parseDuration(v["wait-timeout"]),
  };
}

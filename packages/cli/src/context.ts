import { Layout, type OguriConfig } from "@oguri/core";
import { errline, red } from "./output.ts";

export interface Ctx {
  layout: Layout;
  config: OguriConfig;
  values: Record<string, unknown>;
  positionals: string[];
}

export function str(ctx: Ctx, key: string): string | undefined {
  const v = ctx.values[key];
  return typeof v === "string" ? v : undefined;
}

export function num(ctx: Ctx, key: string): number | undefined {
  const raw = str(ctx, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) usage(`--${key} must be a number`);
  return parsed;
}

export function bool(ctx: Ctx, key: string): boolean {
  return ctx.values[key] === true;
}

export function list(ctx: Ctx, key: string): string[] {
  const v = ctx.values[key];
  return Array.isArray(v) ? (v as string[]) : [];
}

export class UsageError extends Error {}

export function usage(message: string): never {
  errline(red(`error: ${message}`));
  errline("");
  errline("Run 'oguri --help' for usage.");
  throw new UsageError(message);
}

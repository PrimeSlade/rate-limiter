import type { IncomingMessage } from "node:http";
import { getRedis } from "../store/redis";
import { loadRules, type DomainRule } from "./loader";

interface OverrideCacheEntry {
  rule: Partial<DomainRule>;
  expiresAt: number;
}

const overrideCache = new Map<string, OverrideCacheEntry>();
const OVERRIDE_TTL_MS = 30_000;

async function fetchOverride(
  domain: string,
): Promise<Partial<DomainRule> | null> {
  const now = Date.now();
  const entry = overrideCache.get(domain);
  if (entry && entry.expiresAt > now) return entry.rule;

  const raw = await getRedis().get(`ratelimit:rules:${domain}`);
  if (!raw) {
    overrideCache.delete(domain);
    return null;
  }

  const override = JSON.parse(raw) as Partial<DomainRule>;
  overrideCache.set(domain, {
    rule: override,
    expiresAt: now + OVERRIDE_TTL_MS,
  });
  return override;
}

export async function getRule(domain: string): Promise<DomainRule> {
  const config = loadRules();
  const base = config.domains[domain];
  if (!base) throw new Error(`No rule configured for domain "${domain}"`);

  const override = await fetchOverride(domain);
  if (!override) return base;

  return { ...base, ...override };
}

export function extractIdentifier(
  rule: DomainRule,
  req: IncomingMessage,
): string {
  if (rule.identifier === "ip") {
    return req.socket.remoteAddress ?? "0.0.0.0";
  }
  if (rule.identifier.startsWith("header:")) {
    const headerName = rule.identifier.slice("header:".length).toLowerCase();
    const value = req.headers[headerName];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0] ?? "unknown";
    return "unknown";
  }
  throw new Error(`Unknown identifier strategy: "${rule.identifier}"`);
}

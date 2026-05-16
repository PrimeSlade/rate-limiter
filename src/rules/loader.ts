import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export type Algorithm = "token_bucket";

export interface DomainRule {
  algorithm: Algorithm;
  capacity: number;
  refill_rate: number;
  refill_interval_ms: number;
  identifier: string;
}

export interface RulesConfig {
  domains: Record<string, DomainRule>;
}

type RawRule = {
  algorithm: string;
  capacity: number;
  refill_rate: number;
  refill_interval_ms?: number;
  identifier: string;
};

type RawConfig = {
  domains: Record<string, RawRule>;
};

let cached: RulesConfig | null = null;

export function loadRules(configPath?: string): RulesConfig {
  if (cached) return cached;

  const path = configPath ?? resolve(process.cwd(), "config/rules.yaml");
  const raw = yaml.load(readFileSync(path, "utf8")) as RawConfig;

  if (!raw?.domains || typeof raw.domains !== "object") {
    throw new Error('rules.yaml must have a top-level "domains" object');
  }

  const domains: Record<string, DomainRule> = {};

  for (const [domain, rule] of Object.entries(raw.domains)) {
    if (!rule.algorithm)
      throw new Error(`Domain "${domain}": missing algorithm`);
    if (!["token_bucket"].includes(rule.algorithm)) {
      throw new Error(
        `Domain "${domain}": unknown algorithm "${rule.algorithm}"`,
      );
    }
    if (!Number.isFinite(rule.capacity) || rule.capacity <= 0) {
      throw new Error(`Domain "${domain}": capacity must be a positive number`);
    }
    if (!Number.isFinite(rule.refill_rate) || rule.refill_rate <= 0) {
      throw new Error(
        `Domain "${domain}": refill_rate must be a positive number`,
      );
    }
    if (!rule.identifier)
      throw new Error(`Domain "${domain}": missing identifier`);

    const refill_interval_ms = rule.refill_interval_ms ?? 1000;
    const refill_rate_per_ms = rule.refill_rate / refill_interval_ms;
    if (refill_rate_per_ms <= 0) {
      throw new Error(
        `Domain "${domain}": computed refill_rate_per_ms must be > 0`,
      );
    }

    domains[domain] = {
      algorithm: rule.algorithm as Algorithm,
      capacity: rule.capacity,
      refill_rate: rule.refill_rate,
      refill_interval_ms,
      identifier: rule.identifier,
    };
  }

  cached = { domains };
  return cached;
}

export function clearRulesCache(): void {
  cached = null;
}

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RegistryEntry {
  name: string;
  url: string;
}

export interface PackhubConfig {
  apiVersion?: string;
  registries?: RegistryEntry[];
  defaultRegistry?: string;
}

/**
 * 本机配置：`$PACKHUB_HOME/config.json`（默认 ~/.packhub/config.json）。
 * 只读不写——PackHub 不替用户改全局配置；要配默认 registry 由用户自己写这个文件或设 PACKHUB_INDEX。
 */
export function configPath(): string {
  return join(process.env.PACKHUB_HOME ?? join(homedir(), '.packhub'), 'config.json');
}

export function readConfig(): PackhubConfig {
  const file = configPath();
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as PackhubConfig;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * 默认 registry 索引：PACKHUB_INDEX > config.defaultRegistry > 唯一的那一个 registry。
 * 都没有就返回 undefined，由调用方给出「怎么配」的提示。
 */
/**
 * 解析一个 registry 引用：名字（config.registries[].name）或 URL/路径。
 * 不传就按默认顺序取；这让 `--index prod` 与 `--index https://…` 用同一条路。
 */
export function resolveRegistry(input?: string): string | undefined {
  if (!input) return defaultRegistryIndex();
  const cfg = readConfig();
  const hit = (cfg.registries ?? []).find((r) => r.name === input || r.url === input);
  return hit?.url ?? input;
}

/** 所有可用 registry 的索引（PACKHUB_INDEX 排最前），用于 --all 搜索。 */
export function registryIndexes(): string[] {
  const out = new Set<string>();
  const env = process.env.PACKHUB_INDEX;
  if (env) out.add(env);
  for (const r of readConfig().registries ?? []) out.add(r.url);
  return [...out];
}

export function defaultRegistryIndex(): string | undefined {
  const fromEnv = process.env.PACKHUB_INDEX;
  if (fromEnv) return fromEnv;

  const cfg = readConfig();
  const list = Array.isArray(cfg.registries) ? cfg.registries.filter((r) => r?.url) : [];
  if (cfg.defaultRegistry) {
    return list.find((r) => r.name === cfg.defaultRegistry)?.url;
  }
  if (list.length === 1) return list[0]!.url;
  return undefined;
}

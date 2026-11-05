import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillFrontmatter {
  name: string;
  description: string;
}

/** 只认 SKILL.md 的 YAML frontmatter；Codex 对格式比 DSH 严，先在这里拦住。 */
export function readSkillFrontmatter(skillDir: string): SkillFrontmatter {
  const file = join(skillDir, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`skill 缺少 SKILL.md：${file}`);
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error(`SKILL.md 没有 YAML frontmatter：${file}`);
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (err) {
    throw new Error(`SKILL.md frontmatter 不是合法 YAML：${file}（${(err as Error).message}）`);
  }
  if (!data || typeof data !== 'object') throw new Error(`SKILL.md frontmatter 不是对象：${file}`);
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) throw new Error(`SKILL.md 缺少字符串 name：${file}`);
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`SKILL.md 缺少字符串 description：${file}`);
  }
  return { name: name.trim(), description: description.trim() };
}

function displayName(name: string): string {
  const acronyms = new Set(['mcp', 'api', 'cli', 'ui', 'url', 'pdf', 'pr', 'sql', 'gh']);
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (acronyms.has(word.toLowerCase()) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
}

function shortDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= 64) return flat;
  const cut = flat.slice(0, 64);
  const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('，'), cut.lastIndexOf('。'));
  return (boundary > 20 ? cut.slice(0, boundary) : cut).trim();
}

/**
 * 为 Codex 生成 agents/openai.yaml。只写接口层，不改 SKILL.md。
 * 规则按本机 skill-creator 生成器的收口：display_name 标题化、short_description ≤64 字符。
 */
export function generateOpenaiYaml(front: SkillFrontmatter): string {
  const display = displayName(front.name);
  const short = shortDescription(front.description);
  const prompt = `Use $${front.name} when this project needs ${short.replace(/[."]/g, '').toLowerCase()}.`;
  return [
    'interface:',
    `  display_name: ${JSON.stringify(display)}`,
    `  short_description: ${JSON.stringify(short)}`,
    `  default_prompt: ${JSON.stringify(prompt)}`,
    '',
  ].join('\n');
}

// 能力令牌：`<form>/<name>@<major>`。
//
// 能力名带主版本，是「消费形态 + 名字 + 主版本」三件事；form 是消费形态，不是资源类型
// （mcp / tool2 都提供 tool/*，skill 提供 skill/*，knowledge / prompt 提供 content/*）。

import schemaJson from '../../../schema/packhub.v0.schema.json' with { type: 'json' };

/**
 * 能力的消费形态（闭集）。
 *
 * 权威形状在 `schema/packhub.v0.schema.json` 的 `definitions.capabilities`：这里是它的人工镜像，
 * schema 改了这里也要跟着改（schema-mirror 测试盯着两边）。
 */
export const CAPABILITY_FORMS = ['tool', 'skill', 'content', 'config'] as const;
export type CapabilityForm = (typeof CAPABILITY_FORMS)[number];

/**
 * 令牌正则的唯一来源是 schema，不在 kernel 另写一份字面量（与 PACK_NAME_PATTERN 同一条约定）。
 * schema 里 `provides` / `needs` / `roles.*.needs` 用的是同一条正则。
 */
export const CAPABILITY_TOKEN_PATTERN = new RegExp(
  (schemaJson as {
    definitions: { capabilities: { items: { pattern: string } } };
  }).definitions.capabilities.items.pattern,
);

export interface ParsedCapability {
  form: CapabilityForm;
  /** 不带版本的名字部分，`[a-z][a-z0-9-]*` */
  name: string;
  /** 主版本，从 1 起 */
  major: number;
}

export function isCapabilityToken(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_TOKEN_PATTERN.test(value);
}

/** 拆开一个合法令牌；形状不对返回 undefined（调用方自己决定报什么）。 */
export function parseCapabilityToken(value: unknown): ParsedCapability | undefined {
  if (!isCapabilityToken(value)) return undefined;
  const slash = value.indexOf('/');
  const at = value.lastIndexOf('@');
  return {
    form: value.slice(0, slash) as CapabilityForm,
    name: value.slice(slash + 1, at),
    major: Number(value.slice(at + 1)),
  };
}

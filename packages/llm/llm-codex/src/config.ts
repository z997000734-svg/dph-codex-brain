/** Validated local CLI configuration; authentication remains owned by Codex. */
import z from '@deepseek-ai/schemastery'

/** User-editable settings for the local Codex provider. */
export interface Config {
  enabled: boolean
  command: string
  model: string
  proxyUrl: string
  timeoutSeconds: number
  graceMs: number
  maxOutputBytes: number
  maxQueueSize: number
  retainedTasks: number
}

/** Config defaults match the single-provider local integration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  command: z.string().min(1).default('codex'),
  model: z.string().min(1).default('default'),
  proxyUrl: z.string().default(''),
  timeoutSeconds: z.number().step(1).min(1).max(86400).default(1800),
  graceMs: z.number().step(1).min(100).max(30000).default(3000),
  maxOutputBytes: z.number().step(1).min(1024).max(16777216).default(2097152),
  maxQueueSize: z.number().step(1).min(1).max(1000).default(100),
  retainedTasks: z.number().step(1).min(1).max(1000).default(100),
})

/** Validate untyped settings and materialize every default.
 * @param value - parser or test input before schema validation.
 * @returns fully resolved settings.
 */
export function resolveConfig(value: unknown): Config { return Config(value as Config) }

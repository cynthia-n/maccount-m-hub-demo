// B1 变量解析（纯函数，前后端共用：后端预检/渲染，前端预检弹窗）
export interface SequenceDefStep {
  index: number
  accountRole: 'admin' | 'member'
  text: string
  delaySeconds: number
}
export interface SequenceDef {
  name: string
  steps: SequenceDefStep[]
}

export const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

export interface ResolvedStep {
  resolved: Record<string, string>
  sources: Record<string, string>
}

/**
 * 变量解析：
 * - vars 中 "" = 未提供
 * - stepVars[i][k] = "" 表示该步不改；给值则从该步起覆盖到更晚步再给值
 * - varSources：'default' 或 'step:<index>'（沿用时标最初给出值的那一步）
 */
export function resolveSequence(
  steps: SequenceDefStep[],
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): { ok: true; perStep: ResolvedStep[] } | { ok: false; stepIndex: number; key: string } {
  const effective = new Map<string, { value: string; source: string }>()
  for (const [k, v] of Object.entries(vars)) {
    if (v !== '') effective.set(k, { value: v, source: 'default' })
  }

  const perStep: ResolvedStep[] = []
  for (const step of steps) {
    const sv = stepVars[String(step.index)] ?? {}
    for (const [k, v] of Object.entries(sv)) {
      if (v !== '') effective.set(k, { value: v, source: `step:${step.index}` })
    }
    const resolved: Record<string, string> = {}
    const sources: Record<string, string> = {}
    for (const match of step.text.matchAll(PLACEHOLDER)) {
      const key = match[1]!
      const hit = effective.get(key)
      if (!hit) return { ok: false, stepIndex: step.index, key }
      resolved[key] = hit.value
      sources[key] = hit.source
    }
    perStep.push({ resolved, sources })
  }
  return { ok: true, perStep }
}

export function renderText(text: string, resolved: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_, key: string) => resolved[key] ?? `{${key}}`)
}

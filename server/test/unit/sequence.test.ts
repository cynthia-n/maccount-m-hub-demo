import { describe, expect, it } from 'vitest'
import { resolveSequence, renderText } from '@mhub/shared'

const steps = [
  { index: 1, accountRole: 'admin' as const, text: '{event} 将于 {time} 开始', delaySeconds: 1 },
  { index: 2, accountRole: 'member' as const, text: '资料已上传到 {location}，{event} 不变', delaySeconds: 1 },
  { index: 3, accountRole: 'member' as const, text: '最终确认 {event} / {location} / {extra}', delaySeconds: 1 },
]

describe('B1 变量解析', () => {
  it('vars 基础解析 + varSources=default', () => {
    const r = resolveSequence(steps, { event: '发布会', time: '三点', location: 'A房间', extra: 'x' }, {})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.perStep[0]!.resolved).toEqual({ event: '发布会', time: '三点' })
      expect(r.perStep[0]!.sources).toEqual({ event: 'default', time: 'default' })
    }
  })

  it('stepVars 覆盖从该步起生效，varSources 标最初给值的那一步', () => {
    const r = resolveSequence(steps, { event: '发布会', time: '三点', location: 'A房间', extra: 'x' }, { '2': { location: '共享盘/第二季度' } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.perStep[1]!.resolved.location).toBe('共享盘/第二季度')
      expect(r.perStep[1]!.sources.location).toBe('step:2')
      // 第 3 步沿用第 2 步的值，source 仍是 step:2
      expect(r.perStep[2]!.resolved.location).toBe('共享盘/第二季度')
      expect(r.perStep[2]!.sources.location).toBe('step:2')
      expect(r.perStep[2]!.sources.event).toBe('default')
    }
  })

  it('更晚的步骤再次给值则覆盖', () => {
    const r = resolveSequence(
      steps,
      { event: '发布会', time: '三点', location: 'A房间', extra: 'x' },
      { '2': { location: 'B' }, '3': { location: 'C' } },
    )
    if (r.ok) {
      expect(r.perStep[2]!.resolved.location).toBe('C')
      expect(r.perStep[2]!.sources.location).toBe('step:3')
    }
  })

  it('stepVars 的 "" = 该步不改；vars 的 "" = 未提供', () => {
    const r1 = resolveSequence(steps, { event: '发布会', time: '三点', location: 'A房间', extra: 'x' }, { '2': { location: '' } })
    if (r1.ok) {
      expect(r1.perStep[1]!.resolved.location).toBe('A房间')
      expect(r1.perStep[1]!.sources.location).toBe('default')
    }
    const r2 = resolveSequence(steps, { event: '', time: '三点', location: 'A', extra: 'x' }, {})
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.stepIndex).toBe(1)
      expect(r2.key).toBe('event')
    }
  })

  it('S8：解析不到 → 返回 stepIndex 与 key（从 1 数的步骤序号）', () => {
    const r = resolveSequence(steps, { event: '发布会', time: '三点', location: 'A房间' }, {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.stepIndex).toBe(3)
      expect(r.key).toBe('extra')
    }
  })

  it('renderText 替换占位符', () => {
    expect(renderText('{event} 于 {time}', { event: 'A', time: 'B' })).toBe('A 于 B')
  })
})

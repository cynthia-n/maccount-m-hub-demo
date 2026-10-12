import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { resolveSequence, type SequenceDef } from '@mhub/shared'
import { http, useAuth } from '../api/client'

interface GroupRow {
  id: string
  status: string
  gatewayGroupId: string | null
  members: unknown[]
}
interface RunSteps {
  status: string
  currentStepIndex: number | null
  steps: Array<{
    index: number
    status: string
    scheduledAt: string | null
    sentAt: string | null
    clientMsgId: string | null
    resolvedVars: Record<string, string>
    varSources: Record<string, string>
  }>
}

const STEP_COLOR: Record<string, string> = {
  pending: 'default',
  accepted: 'blue',
  sent: 'green',
  skipped: 'orange',
  failed: 'red',
}

const SAMPLE: SequenceDef = {
  name: '示例序列',
  steps: [
    { index: 1, accountRole: 'admin', text: '{event} 将于 {time} 开始，请提前准备', delaySeconds: 5 },
    { index: 2, accountRole: 'member', text: '提醒：{event} 的资料已上传到 {location}', delaySeconds: 5 },
  ],
}

export default function Sequences(): JSX.Element {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [form] = Form.useForm()
  const [defText, setDefText] = useState(JSON.stringify(SAMPLE, null, 2))
  const [groupId, setGroupId] = useState<string>()
  const [varsText, setVarsText] = useState('{}')
  const [stepVarsText, setStepVarsText] = useState('{}')
  const [precheck, setPrecheck] = useState<null | { ok: boolean; message: string; data?: Array<{ index: number; key: string; value: string; source: string }>; stepIndex?: number }>(null)
  const [runningRunId, setRunningRunId] = useState<string | null>(null)

  const groups = useQuery({ queryKey: ['groups'], queryFn: () => http.get<GroupRow[]>('/api/groups'), refetchInterval: 5000 })
  const run = useQuery({
    queryKey: ['sequence-run', runningRunId],
    queryFn: () => http.get<RunSteps>(`/api/sequence-runs/${runningRunId}`),
    enabled: !!runningRunId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  })

  const saveDef = useMutation({
    mutationFn: () => {
      const def = JSON.parse(defText) as SequenceDef
      return http.post<{ id: string }>('/api/sequences', def)
    },
    onSuccess: () => void message.success('序列已保存'),
    onError: (e: Error) => void message.error(`定义不合法：${e.message}`),
  })

  const doPrecheck = () => {
    try {
      const def = JSON.parse(defText) as SequenceDef
      const vars = JSON.parse(varsText) as Record<string, string>
      const stepVars = JSON.parse(stepVarsText) as Record<string, Record<string, string>>
      const r = resolveSequence(def.steps, vars, stepVars)
      if (!r.ok) {
        setPrecheck({ ok: false, message: `占位符无法解析`, stepIndex: r.stepIndex })
        return
      }
      const rows = r.perStep.flatMap((p, i) =>
        Object.entries(p.resolved).map(([key, value]) => ({
          index: def.steps[i]!.index,
          key,
          value,
          source: p.sources[key] ?? 'default',
        })),
      )
      setPrecheck({ ok: true, message: '预检通过', data: rows })
    } catch (e) {
      void message.error(`JSON 解析失败：${(e as Error).message}`)
    }
  }

  const start = useMutation({
    mutationFn: async () => {
      const def = JSON.parse(defText) as SequenceDef
      const saved = await http.post<{ id: string }>('/api/sequences', def)
      return http.post<{ runId: string }>(`/api/groups/${groupId}/sequence-runs`, {
        sequenceId: saved.id,
        vars: JSON.parse(varsText),
        stepVars: JSON.parse(stepVarsText),
      })
    },
    onSuccess: (v) => {
      setPrecheck(null)
      setRunningRunId(v.runId)
      void message.success('已启动')
    },
    onError: (e: Error & { code?: string; extra?: Record<string, unknown> }) => {
      if (e.code === 'UNRESOLVED_PLACEHOLDER') {
        setPrecheck({ ok: false, message: e.message, stepIndex: Number(e.extra?.stepIndex) })
      } else {
        void message.error(e.message)
      }
    },
  })

  const activeGroups = (groups.data ?? []).filter((g) => g.status === 'active')

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card title="序列运行">
        <Form form={form} layout="vertical">
          <Space wrap>
            <Form.Item label="目标群">
              <Select style={{ width: 240 }} value={groupId} onChange={setGroupId} options={activeGroups.map((g) => ({ value: g.id, label: g.gatewayGroupId ?? g.id }))} />
            </Form.Item>
            <Form.Item label="vars (JSON)">
              <Input style={{ width: 260 }} value={varsText} onChange={(e) => setVarsText(e.target.value)} />
            </Form.Item>
            <Form.Item label="stepVars (JSON，按步覆盖)">
              <Input style={{ width: 320 }} value={stepVarsText} onChange={(e) => setStepVarsText(e.target.value)} />
            </Form.Item>
            {isAdmin && (
              <>
                <Button onClick={doPrecheck}>预检</Button>
                <Button type="primary" disabled={!groupId || precheck?.ok !== true} onClick={() => start.mutate()} loading={start.isPending}>
                  启动
                </Button>
              </>
            )}
          </Space>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          序列定义（保存后可复用）：
        </Typography.Text>
        <Input.TextArea rows={8} value={defText} onChange={(e) => setDefText(e.target.value)} style={{ fontFamily: 'monospace', marginTop: 8 }} />
        <Button size="small" style={{ marginTop: 8 }} onClick={() => saveDef.mutate()} loading={saveDef.isPending} disabled={!isAdmin}>
          保存序列定义
        </Button>
      </Card>

      {runningRunId && run.data && (
        <Card title={<>运行进度 <code>{runningRunId.slice(0, 8)}</code> <Tag color={run.data.status === 'running' ? 'processing' : 'green'}>{run.data.status}</Tag></>}>
          <Table
            rowKey="index"
            dataSource={run.data.steps}
            pagination={false}
            columns={[
              { title: '#', dataIndex: 'index', width: 48 },
              { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={STEP_COLOR[s]}>{s}</Tag> },
              { title: 'scheduledAt', dataIndex: 'scheduledAt', render: (v: string | null) => (v ? new Date(v).toLocaleTimeString() : '—') },
              { title: 'sentAt', dataIndex: 'sentAt', render: (v: string | null) => (v ? new Date(v).toLocaleTimeString() : '—') },
              {
                title: 'resolvedVars / varSources',
                render: (_, s) => (
                  <Typography.Text style={{ fontSize: 12 }} code>
                    {JSON.stringify(s.resolvedVars)} / {JSON.stringify(s.varSources)}
                  </Typography.Text>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal
        open={precheck !== null}
        title="预检结果"
        onCancel={() => setPrecheck(null)}
        footer={
          precheck?.ok
            ? [
                <Button key="cancel" onClick={() => setPrecheck(null)}>
                  取消
                </Button>,
                <Button key="start" type="primary" onClick={() => start.mutate()} loading={start.isPending}>
                  确认启动
                </Button>,
              ]
            : [<Button key="ok" type="primary" onClick={() => setPrecheck(null)}>知道了</Button>]
        }
      >
        {precheck && !precheck.ok && (
          <Alert
            type="error"
            message="预检未通过"
            description={
              <>
                <div>{precheck.message}</div>
                {precheck.stepIndex !== undefined && (
                  <div>
                    stepIndex = {precheck.stepIndex}
                  </div>
                )}
              </>
            }
          />
        )}
        {precheck?.ok && precheck.data && (
          <Table
            rowKey={(r) => `${r.index}-${r.key}`}
            size="small"
            pagination={false}
            dataSource={precheck.data}
            columns={[
              { title: '步骤', dataIndex: 'index', width: 64 },
              { title: 'key', dataIndex: 'key' },
              { title: '最终取值', dataIndex: 'value' },
              { title: '来源', dataIndex: 'source', render: (v: string) => <Tag>{v}</Tag> },
            ]}
          />
        )}
      </Modal>
    </Space>
  )
}

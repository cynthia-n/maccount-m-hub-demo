import { Button, Card, Collapse, Space, Table, Tag, Typography } from 'antd'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { http } from '../api/client'
import { useEffect } from 'react'

type Step = {
    kind: string
    toolUseId: string | null
    name: string | null
    input: unknown
    resultSummary: string | null
    isError: boolean
    errorCode: string | null
    auditVerdict: string | null
    rawResponse: string | null
  }

interface AgentRunDetail {
  id: string
  groupId: string
  status: string
  endReason: string | null
  summary: string | null
  steps: Step[]
}

const KIND_COLOR: Record<string, string> = { tool_use: 'blue', final: 'green', protocol_error: 'red' }

export default function AgentRun(): JSX.Element {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const run = useQuery({
    queryKey: ['agent-run', id],
    queryFn: () => http.get<AgentRunDetail>(`/api/agent-runs/${id}`),
    refetchInterval: 2000,
  })

  // running 时由 WS/轮询刷新；终态后停止轮询
  useEffect(() => {
    if (run.data && run.data.status !== 'running') {
      void qc.invalidateQueries({ queryKey: ['agent-runs'] })
    }
  }, [run.data?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!run.data) return <Card loading />
  const r = run.data

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card
        title={<>Agent 运行 <code>{r.id.slice(0, 8)}</code></>}
        extra={
          <Space>
            <Tag color={r.status === 'running' ? 'processing' : r.status === 'blocked' ? 'red' : r.status === 'finished' ? 'green' : 'orange'}>
              {r.status}
            </Tag>
            {r.endReason && <Tag>{r.endReason}</Tag>}
          </Space>
        }
      >
        {r.summary && <Typography.Paragraph>总结：{r.summary}</Typography.Paragraph>}
      </Card>

      <Card title="步骤">
        <Table<Step>
          rowKey={(s) => `${s.kind}-${s.toolUseId ?? 'x'}`}
          dataSource={r.steps}
          pagination={false}
          columns={[
            { title: '#', render: (_, __, i) => i + 1, width: 48 },
            {
              title: 'kind',
              dataIndex: 'kind',
              render: (k: string) => <Tag color={KIND_COLOR[k]}>{k}</Tag>,
            },
            { title: '工具', dataIndex: 'name', render: (v: string | null) => v ?? '—' },
            {
              title: '入参',
              dataIndex: 'input',
              render: (v: unknown) =>
                v ? (
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {JSON.stringify(v)}
                  </Typography.Text>
                ) : (
                  '—'
                ),
            },
            {
              title: '结果摘要',
              dataIndex: 'resultSummary',
              render: (v: string | null) => (v ? <Typography.Text style={{ fontSize: 12 }}>{v}</Typography.Text> : '—'),
            },
            {
              title: '审计',
              dataIndex: 'auditVerdict',
              render: (v: string | null) => (v ? <Tag color={v === 'pass' ? 'green' : 'red'}>{v}</Tag> : '—'),
            },
            {
              title: '错误',
              dataIndex: 'errorCode',
              render: (v: string | null, s) => (v ? <Tag color="red">{v}{s.isError ? '' : ''}</Tag> : '—'),
            },
          ]}
        />
        <Collapse
          style={{ marginTop: 16 }}
          items={(r.steps as Step[])
            .map((s: Step, i: number) => ({ s, i }))
            .filter(({ s }: { s: Step }) => s.kind === 'protocol_error' && s.rawResponse)
            .map(({ s, i }: { s: Step; i: number }) => ({
              key: i,
              label: (
                <Space>
                  <Tag color="red">协议错误 #{i + 1}</Tag>
                  <Typography.Text type="secondary">原始响应体（截断至 2KB）</Typography.Text>
                </Space>
              ),
              children: (
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#fafafa', padding: 12 }}>
                  {s.rawResponse}
                </pre>
              ),
            }))}
        />
      </Card>
    </Space>
  )
}

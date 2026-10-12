import { Alert, Button, Card, Checkbox, Input, List, Select, Space, Switch, Tag, Typography, message } from 'antd'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageDto } from '@mhub/shared'
import { http, useAuth } from '../api/client'

interface GroupDetail {
  id: string
  gatewayGroupId: string | null
  status: string
  creatorAccountId: string
  agentEnabled: boolean
  autoKickEnabled: boolean
  members: Array<{ accountId: string; platformUserId: string | null; role: string }>
  activeAgentRunId: string | null
}
interface MessagePage {
  items: MessageDto[]
  nextCursor: string | null
}
interface AgentRunRow {
  id: string
  status: string
  endReason: string | null
}

const DELIVERY_COLOR: Record<string, string> = {
  queued: 'default',
  accepted: 'blue',
  sent: 'green',
  failed: 'red',
  unknown: 'orange',
  cancelled: 'red',
}

export default function GroupDetail(): JSX.Element {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const qc = useQueryClient()
  const [sendAccount, setSendAccount] = useState<string>()
  const [sendText, setSendText] = useState('')
  const [varsText, setVarsText] = useState('{}')

  const group = useQuery({ queryKey: ['groups', id], queryFn: () => http.get<GroupDetail>(`/api/groups/${id}`), refetchInterval: 4000 })
  const timeline = useInfiniteQuery({
    queryKey: ['messages', id],
    queryFn: ({ pageParam }) => http.get<MessagePage>(`/api/groups/${id}/messages?limit=30${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 4000,
  })

  const send = useMutation({
    mutationFn: () => http.post<{ clientMsgId: string }>(`/api/groups/${id}/send`, { accountId: sendAccount, text: sendText }),
    onSuccess: () => {
      void message.success('已受理')
      setSendText('')
      void qc.invalidateQueries({ queryKey: ['messages', id] })
    },
    onError: (e: Error) => void message.error(e.message),
  })
  const patch = useMutation({
    mutationFn: (v: { agentEnabled?: boolean; autoKickEnabled?: boolean }) => http.patch(`/api/groups/${id}`, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['groups', id] }),
    onError: (e: Error) => void message.error(e.message),
  })
  const leaveAll = useMutation({
    mutationFn: () => http.post<{ jobId: string }>(`/api/groups/${id}/leave-all`),
    onSuccess: () => {
      void message.success('退群任务已受理')
      void qc.invalidateQueries({ queryKey: ['groups', id] })
    },
    onError: (e: Error) => void message.error(e.message),
  })

  if (!group.data) return <Card loading />

  const g = group.data
  const allItems = (timeline.data?.pages ?? []).flatMap((p) => p.items)

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {g.status === 'unreachable' && <Alert type="error" showIcon message="群当前不可写（unreachable）" />}
      <Card
        title={<>群 {g.gatewayGroupId ?? '(建群中)'} <Tag color={g.status === 'active' ? 'green' : 'red'}>{g.status}</Tag></>}
        extra={
          isAdmin && (
            <Space>
              <Checkbox
                checked={g.agentEnabled}
                onChange={(e) => patch.mutate({ agentEnabled: e.target.checked })}
              >
                agent
              </Checkbox>
              <Checkbox
                checked={g.autoKickEnabled}
                onChange={(e) => patch.mutate({ autoKickEnabled: e.target.checked })}
              >
                autoKick
              </Checkbox>
              <Button danger onClick={() => leaveAll.mutate()} loading={leaveAll.isPending}>
                全员退群
              </Button>
            </Space>
          )
        }
      >
        <List
          size="small"
          header={<Typography.Text strong>成员（含角色）</Typography.Text>}
          dataSource={g.members}
          renderItem={(m) => (
            <List.Item>
              <Space>
                <span>{m.accountId}</span>
                <span style={{ color: '#999' }}>{m.platformUserId}</span>
                <Tag color={m.role === 'creator' ? 'gold' : m.role === 'admin' ? 'blue' : 'default'}>{m.role}</Tag>
              </Space>
            </List.Item>
          )}
        />
      </Card>

      <Card
        title="消息时间线"
        extra={
          isAdmin && (
            <Space>
              <Select
                style={{ width: 160 }}
                placeholder="以账号身份"
                value={sendAccount}
                onChange={setSendAccount}
                options={g.members.map((m) => ({ value: m.accountId, label: m.accountId }))}
              />
              <Input
                style={{ width: 260 }}
                placeholder="消息内容"
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                onPressEnter={() => sendAccount && sendText && send.mutate()}
              />
              <Button type="primary" disabled={!sendAccount || !sendText} onClick={() => send.mutate()} loading={send.isPending}>
                发送
              </Button>
            </Space>
          )
        }
      >
        {timeline.hasNextPage && (
          <Button block style={{ marginBottom: 12 }} onClick={() => void timeline.fetchNextPage()} loading={timeline.isFetchingNextPage}>
            加载更早
          </Button>
        )}
        <List
          dataSource={allItems}
          renderItem={(m) => (
            <List.Item>
              <Space wrap>
                {m.isOwn ? <Tag color="cyan">自己</Tag> : <Tag>{m.senderPlatformUserId}</Tag>}
                <span>{m.text}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(m.sentAt).toLocaleString()}
                </Typography.Text>
                {m.isOwn && m.deliveryStatus && (
                  <Tag color={DELIVERY_COLOR[m.deliveryStatus]}>
                    {m.deliveryStatus}
                    {m.failCode ? ` · ${m.failCode}` : ''}
                  </Tag>
                )}
              </Space>
            </List.Item>
          )}
        />
      </Card>

      <Card title="最近的 Agent 运行">
        <AgentRunsList groupId={id} onOpen={(runId) => nav(`/agent-runs/${runId}`)} />
      </Card>
    </Space>
  )
}

export function AgentRunsList({ groupId, onOpen }: { groupId: string; onOpen: (runId: string) => void }): JSX.Element {
  const runs = useQuery({
    queryKey: ['agent-runs', groupId],
    queryFn: () => http.get<AgentRunRow[]>(`/api/groups/${groupId}/agent-runs`),
    refetchInterval: 3000,
  })
  const list = runs.data ?? []
  if (list.length === 0) return <Typography.Text type="secondary">暂无</Typography.Text>
  return (
    <List
      size="small"
      dataSource={list}
      renderItem={(r) => (
        <List.Item
          actions={[
            <Button key="open" type="link" size="small" onClick={() => onOpen(r.id)}>
              查看步骤
            </Button>,
          ]}
        >
          <Space>
            <code style={{ fontSize: 12 }}>{r.id.slice(0, 8)}</code>
            <Tag color={r.status === 'running' ? 'processing' : r.status === 'blocked' ? 'red' : r.status === 'finished' ? 'green' : 'orange'}>
              {r.status}
              {r.endReason ? ` · ${r.endReason}` : ''}
            </Tag>
            {r.status === 'blocked' && <Tag color="red">需要操作员介入（审计无法通过）</Tag>}
          </Space>
        </List.Item>
      )}
    />
  )
}

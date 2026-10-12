import { Button, Card, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { canTransition, type AccountStatus } from '@mhub/shared'
import { http, useAuth } from '../api/client'

interface AccountRow {
  id: string
  status: AccountStatus
  platformUserId: string | null
  rateLimitedUntil: string | null
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'default',
  online: 'green',
  rate_limited: 'orange',
  disconnected: 'blue',
  suspended: 'red',
  session_expired: 'red',
}

export default function Accounts(): JSX.Element {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => http.get<AccountRow[]>('/api/accounts'),
    refetchInterval: 5000,
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['accounts'] })

  const connect = useMutation({
    mutationFn: (id: string) => http.post(`/api/accounts/${id}/connect`),
    onSuccess: () => {
      void message.success('已重连')
      invalidate()
    },
    onError: (e: Error) => void message.error(e.message),
  })
  const transition = useMutation({
    mutationFn: (v: { id: string; to: string; expectedFrom: string }) =>
      http.post(`/api/accounts/${v.id}/transition`, { to: v.to, expectedFrom: v.expectedFrom }),
    onSuccess: () => {
      void message.success('状态已更新')
      invalidate()
    },
    onError: (e: Error & { status?: number; code?: string }) => {
      if (e.code === 'CAS_CONFLICT') void message.warning('状态已被其他人修改，已刷新')
      else void message.error(e.message)
      invalidate()
    },
  })

  const columns: ColumnsType<AccountRow> = [
    { title: 'ID', dataIndex: 'id' },
    {
      title: '状态',
      dataIndex: 'status',
      render: (s: string, row) => (
        <>
          <Tag color={STATUS_COLOR[s]}>{s}</Tag>
          {row.rateLimitedUntil && <Tag color="orange">限流至 {new Date(row.rateLimitedUntil).toLocaleTimeString()}</Tag>}
        </>
      ),
    },
    { title: 'platformUserId', dataIndex: 'platformUserId', render: (v: string | null) => v ?? '—' },
    {
      title: '操作',
      render: (_, row) =>
        !isAdmin ? null : (
          <>
            {canTransition(row.status, 'disconnected') && (
              <Button size="small" style={{ marginRight: 8 }} onClick={() => transition.mutate({ id: row.id, to: 'disconnected', expectedFrom: row.status })}>
                标记离线
              </Button>
            )}
            {['idle', 'disconnected', 'rate_limited'].includes(row.status) && (
              <Button size="small" style={{ marginRight: 8 }} onClick={() => connect.mutate(row.id)}>
                重连
              </Button>
            )}
            {canTransition(row.status, 'idle') && (
              <Button size="small" onClick={() => transition.mutate({ id: row.id, to: 'idle', expectedFrom: row.status })}>
                释放账号
              </Button>
            )}
          </>
        ),
    },
  ]

  return (
    <Card title="服务账号">
      <Table<AccountRow> rowKey="id" loading={isLoading} dataSource={data ?? []} columns={columns} pagination={false} />
    </Card>
  )
}

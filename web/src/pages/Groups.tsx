import { Button, Card, Form, Input, List, Modal, Select, Space, Tag, message } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { http, useAuth } from '../api/client'

interface GroupRow {
  id: string
  gatewayGroupId: string | null
  status: string
  creatorAccountId: string
  agentEnabled: boolean
  autoKickEnabled: boolean
  members: Array<{ accountId: string; platformUserId: string | null; role: string }>
  activeSequenceRunId: string | null
  activeAgentRunId: string | null
}
interface AccountRow {
  id: string
  status: string
}

const STATUS_COLOR: Record<string, string> = { active: 'green', unreachable: 'red', left: 'default' }

export default function Groups(): JSX.Element {
  const nav = useNavigate()
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [form] = Form.useForm()

  const groups = useQuery({ queryKey: ['groups'], queryFn: () => http.get<GroupRow[]>('/api/groups'), refetchInterval: 5000 })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => http.get<AccountRow[]>('/api/accounts') })

  const create = useMutation({
    mutationFn: (v: { creatorAccountId: string; memberAccountIds: string[] }) => http.post<{ jobId: string }>('/api/groups', v),
    onSuccess: () => {
      void message.success('建群任务已受理')
      setCreateOpen(false)
      form.resetFields()
      void qc.invalidateQueries({ queryKey: ['groups'] })
    },
    onError: (e: Error) => void message.error(e.message),
  })

  const onlineAccounts = (accounts.data ?? []).filter((a) => a.status === 'online')

  return (
    <Card
      title="群"
      extra={
        isAdmin && (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            新建群
          </Button>
        )
      }
    >
      <List
        loading={groups.isLoading}
        dataSource={groups.data ?? []}
        renderItem={(g) => (
          <List.Item
            actions={[
              <Button key="open" type="link" onClick={() => nav(`/groups/${g.id}`)}>
                详情
              </Button>,
            ]}
          >
            <Space size="middle">
              <Tag color={STATUS_COLOR[g.status]}>{g.status}</Tag>
              <span>{g.gatewayGroupId ?? '(建群中)'}</span>
              <span>{g.members.length} 成员</span>
              {g.agentEnabled && <Tag color="purple">agent</Tag>}
              {g.autoKickEnabled && <Tag color="orange">autoKick</Tag>}
              {g.activeAgentRunId && <Tag color="processing">agent 运行中</Tag>}
              {g.activeSequenceRunId && <Tag color="processing">序列运行中</Tag>}
            </Space>
          </List.Item>
        )}
      />
      <Modal
        title="新建群"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate({ creatorAccountId: v.creatorAccountId, memberAccountIds: v.memberAccountIds })}
        >
          <Form.Item name="creatorAccountId" label="群主（在线账号）" rules={[{ required: true }]}>
            <Select options={onlineAccounts.map((a) => ({ value: a.id, label: `${a.id} (${a.status})` }))} />
          </Form.Item>
          <Form.Item name="memberAccountIds" label="成员（首个将提升为管理员，不含群主）" rules={[{ required: true }]}>
            <Select mode="multiple" options={onlineAccounts.map((a) => ({ value: a.id, label: `${a.id} (${a.status})` }))} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

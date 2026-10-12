import { Button, Layout as AntLayout, Menu, Typography, message } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { http, auth, useAuth } from '../api/client'
import { useRealtime } from '../api/ws'

export function AppLayout(): JSX.Element {
  const nav = useNavigate()
  const loc = useLocation()
  const { role } = useAuth()
  useRealtime(!!role)

  const items = [
    { key: '/accounts', label: '账号' },
    { key: '/groups', label: '群' },
    { key: '/sequences', label: '序列' },
  ]

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <AntLayout.Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Typography.Text style={{ color: '#fff', fontSize: 16 }}>多账号群组消息平台</Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[loc.pathname]}
          items={items}
          onClick={(e) => nav(e.key)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Typography.Text style={{ color: '#fff' }}>{role === 'admin' ? '管理员' : '观察者'}</Typography.Text>
        <Button
          size="small"
          onClick={async () => {
            try {
              await http.post('/api/auth/logout')
            } catch {
              /* 忽略 */
            }
            auth.signOut()
            nav('/login')
          }}
        >
          退出
        </Button>
      </AntLayout.Header>
      <AntLayout.Content style={{ padding: 24 }}>
        <Outlet />
      </AntLayout.Content>
    </AntLayout>
  )
}

export function requireAdminHandler(fn: () => Promise<unknown>, notify = message.error) {
  return async () => {
    try {
      await fn()
    } catch (e) {
      const err = e as { code?: string; message?: string }
      notify(err.message ?? '操作失败')
      throw e
    }
  }
}

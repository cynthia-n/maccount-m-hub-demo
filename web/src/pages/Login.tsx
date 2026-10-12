import { Button, Card, Form, Input, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { auth, http } from '../api/client'

export default function Login(): JSX.Element {
  const nav = useNavigate()
  const [form] = Form.useForm()

  const onFinish = async (v: { username: string; password: string }) => {
    try {
      const res = await http.post<{ accessToken: string; role: 'admin' | 'viewer' }>('/api/auth/login', v)
      auth.signIn(res.accessToken, res.role)
      nav('/accounts')
    } catch (e) {
      form.setFields([{ name: 'password', errors: [(e as Error).message] }])
    }
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={4}>控制台登录</Typography.Title>
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ username: '', password: '' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            登录
          </Button>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          预置账号：admin/admin（全部权限）、viewer/viewer（只读）
        </Typography.Text>
      </Card>
    </div>
  )
}

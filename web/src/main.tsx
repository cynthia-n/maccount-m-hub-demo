import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, Card, Typography } from 'antd'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const qc = new QueryClient()

function Placeholder() {
  return (
    <Card style={{ margin: 48 }}>
      <Typography.Title level={3}>控制台骨架（M0）</Typography.Title>
      <Typography.Text type="secondary">五个页面在 M8 实现：登录 / 账号 / 群详情 / Agent 详情 / 序列</Typography.Text>
    </Card>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider>
      <QueryClientProvider client={qc}>
        <Placeholder />
      </QueryClientProvider>
    </ConfigProvider>
  </StrictMode>,
)

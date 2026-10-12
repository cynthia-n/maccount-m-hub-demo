import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider } from 'antd'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import { AppLayout } from './components/Layout'
import Login from './pages/Login'
import Accounts from './pages/Accounts'
import Groups from './pages/Groups'
import GroupDetail from './pages/GroupDetail'
import AgentRun from './pages/AgentRun'
import Sequences from './pages/Sequences'
import { auth, useAuth } from './api/client'

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { role } = useAuth()
  if (!role) return <Navigate to="/login" replace />
  return children
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/accounts" replace /> },
      { path: 'accounts', element: <Accounts /> },
      { path: 'groups', element: <Groups /> },
      { path: 'groups/:id', element: <GroupDetail /> },
      { path: 'agent-runs/:id', element: <AgentRun /> },
      { path: 'sequences', element: <Sequences /> },
    ],
  },
])

// 未登录时也不再启动 WS（useRealtime 以 role 为开关）
void auth

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ConfigProvider>
  </StrictMode>,
)

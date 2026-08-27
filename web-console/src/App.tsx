// ============================================================
// App Root — React Router configuration + Route guard
// Validates: Requirements 9.2
// ============================================================

import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { isAuthenticated } from '@/lib/auth';
import { RoleProvider } from '@/lib/role';
import ErrorBoundary from '@/components/ErrorBoundary';
import Layout from '@/components/Layout';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import UserList from '@/pages/UserList';
import UserDetail from '@/pages/UserDetail';
import Providers from '@/pages/Providers';
import AuditLogs from '@/pages/AuditLogs';
import Settings from '@/pages/Settings';

/** Route guard — redirects to /login when not authenticated. */
function ProtectedRoute() {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return (
    <RoleProvider>
      <Outlet />
    </RoleProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter basename="/console">
        <Routes>
          {/* Public route */}
          <Route path="/login" element={<Login />} />

          {/* Protected routes wrapped in Layout */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/users" element={<UserList />} />
              <Route path="/users/:userId" element={<UserDetail />} />
              <Route path="/providers" element={<Providers />} />
              <Route path="/audit-logs" element={<AuditLogs />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Route>

          {/* Default redirect */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

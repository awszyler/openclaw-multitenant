// ============================================================
// Dashboard Page — Stats cards + Quick actions + User overview
// Validates: Requirements 15.1, 15.2, 15.3
// ============================================================

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  UserCheck,
  Container,
  Boxes,
  Plus,
  AlertTriangle,
} from 'lucide-react';
import StatCard from '@/components/StatCard';
import DataTable, { type Column } from '@/components/DataTable';
import { getDashboard, listUsers, type User, type DashboardData } from '@/lib/api';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  suspended: 'bg-red-100 text-red-700',
  deleted: 'bg-gray-100 text-gray-500',
};

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardData | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [dashData, userData] = await Promise.all([getDashboard(), listUsers()]);
        if (!cancelled) {
          setStats(dashData);
          setUsers(userData ?? []);
        }
      } catch (err) {
        console.error('Dashboard load error:', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const columns: Column<User>[] = [
    { key: 'user_id', header: t('users.userId'), render: (r) => (
      <button onClick={() => navigate(`/users/${r.user_id}`)} className="text-blue-600 hover:underline font-medium">
        {r.user_id}
      </button>
    ), sortable: true },
    { key: 'status', header: t('users.status'), render: (r) => (
      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[r.status] ?? ''}`}>
        {r.status ? t(`users.status${r.status.charAt(0).toUpperCase() + r.status.slice(1)}` as never) : '—'}
      </span>
    ), sortable: true },
    { key: 'model', header: t('users.model'), render: (r) => r.model || '—', sortable: true },
    { key: 'task_status', header: t('users.containerStatus'), render: (r) => r.task_status || '—' },
    { key: 'last_active_at', header: t('users.lastActive'), render: (r) => r.last_active_at ? new Date(r.last_active_at).toLocaleString() : '—', sortable: true },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('dashboard.title')}</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title={t('dashboard.totalUsers')} value={loading ? '—' : stats?.total_users ?? 0} icon={<Users size={24} />} color="blue" />
        <StatCard title={t('dashboard.activeUsers')} value={loading ? '—' : stats?.active_users ?? 0} icon={<UserCheck size={24} />} color="green" />
        <StatCard title={t('dashboard.runningContainers')} value={loading ? '—' : stats?.running_containers ?? 0} icon={<Container size={24} />} color="purple" />
        <StatCard title={t('dashboard.availableModels')} value={loading ? '—' : stats?.available_models ?? 0} icon={<Boxes size={24} />} color="blue" />
      </div>

      {/* Quick actions */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">{t('dashboard.quickActions')}</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => navigate('/users?action=create')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus size={16} />
            {t('dashboard.createUser')}
          </button>
          <button
            onClick={() => navigate('/users?filter=abnormal')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <AlertTriangle size={16} />
            {t('dashboard.viewAbnormalContainers')}
          </button>
        </div>
      </div>

      {/* User overview table */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">{t('dashboard.userOverview')}</h2>
        <DataTable
          columns={columns}
          data={users}
          rowKey={(r) => r.user_id}
          searchable
          searchFilter={(row, q) =>
            row.user_id.toLowerCase().includes(q) ||
            row.display_name.toLowerCase().includes(q)
          }
          loading={loading}
          defaultPageSize={10}
        />
      </div>
    </div>
  );
}

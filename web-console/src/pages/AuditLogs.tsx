// ============================================================
// Audit Logs Page — Filters + Table + Pagination
// Validates: Requirements 19.1, 19.2
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import DataTable, { type Column } from '@/components/DataTable';
import { getAuditLogs, type AuditLog } from '@/lib/api';

const ACTION_TYPES = [
  'user.create', 'user.update', 'user.delete',
  'user.update_model', 'user.update_status',
  'user.restart', 'user.stop', 'user.start',
  'provider.create', 'provider.update', 'provider.delete',
  'system.health_check',
];

export default function AuditLogs() {
  const { t } = useTranslation();

  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAuditLogs({
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        action: actionFilter || undefined,
        actor: actorFilter || undefined,
      });
      setLogs(data);
    } catch {
      // handled by api.ts
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, actionFilter, actorFilter]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const columns: Column<AuditLog>[] = [
    {
      key: 'created_at', header: t('auditLogs.time'), sortable: true,
      render: (r) => r.created_at ? new Date(r.created_at).toLocaleString() : '—',
      sortFn: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    },
    { key: 'actor', header: t('auditLogs.actor'), render: (r) => r.actor, sortable: true },
    {
      key: 'action', header: t('auditLogs.action'), sortable: true,
      render: (r) => (
        <span className="inline-block px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">
          {r.action}
        </span>
      ),
    },
    {
      key: 'target', header: t('auditLogs.target'),
      render: (r) => (
        <span className="text-sm">
          <span className="text-gray-500">{r.target_type}:</span> {r.target_id}
        </span>
      ),
    },
    {
      key: 'detail', header: t('auditLogs.detail'),
      render: (r) => {
        if (!r.detail || Object.keys(r.detail).length === 0) return '—';
        const summary = JSON.stringify(r.detail);
        return (
          <span className="text-xs text-gray-500 truncate block max-w-[200px]" title={summary}>
            {summary}
          </span>
        );
      },
    },
  ];

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5">
        <label className="text-xs text-gray-500">{t('auditLogs.startDate')}</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <label className="text-xs text-gray-500">{t('auditLogs.endDate')}</label>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <select
        value={actionFilter}
        onChange={(e) => setActionFilter(e.target.value)}
        className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{t('auditLogs.filterByAction')}</option>
        {ACTION_TYPES.map((a) => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          placeholder={t('auditLogs.filterByActor')}
          className="pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-40"
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('auditLogs.title')}</h1>

      <DataTable
        columns={columns}
        data={logs}
        rowKey={(r) => r['timestamp#log_id']}
        loading={loading}
        toolbar={toolbar}
        defaultPageSize={20}
      />
    </div>
  );
}

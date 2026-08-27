// ============================================================
// User List Page — Table + Create modal + Batch ops + Filters
// Validates: Requirements 16.1, 16.2, 16.3, 16.4
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, Pause, Play, X } from 'lucide-react';
import DataTable, { type Column } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useRole } from '@/lib/role';
import {
  listUsers,
  listProviders,
  createUser,
  updateUserStatus,
  deleteUser,
  type User,
  type UserStatus,
  type ProviderWithCount,
} from '@/lib/api';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  suspended: 'bg-red-100 text-red-700',
  deleted: 'bg-gray-100 text-gray-500',
};

type ChannelType = 'wecom' | 'teams' | 'none';

interface CreateFormData {
  user_id: string;
  display_name: string;
  email: string;
  skill_group: string;
  model: string;
  channel_type: ChannelType;
  wecom_bot_id: string;
  wecom_secret: string;
  teams_app_id: string;
  teams_app_password: string;
  teams_tenant_id: string;
}

const EMPTY_FORM: CreateFormData = {
  user_id: '',
  display_name: '',
  email: '',
  skill_group: 'general',
  model: '',
  channel_type: 'none',
  wecom_bot_id: '',
  wecom_secret: '',
  teams_app_id: '',
  teams_app_password: '',
  teams_tenant_id: '',
};

export default function UserList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAdmin } = useRole();

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<UserStatus | ''>('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateFormData>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Providers for model dropdown
  const [providers, setProviders] = useState<ProviderWithCount[]>([]);

  // Batch confirm
  const [batchAction, setBatchAction] = useState<'suspend' | 'activate' | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const [userData, providerData] = await Promise.all([listUsers(), listProviders()]);
      setUsers(userData);
      setProviders(providerData.filter((p) => p.status === 'active'));
    } catch {
      // handled by api.ts
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  // Filtered data
  const filteredUsers = statusFilter
    ? users.filter((u) => u.status === statusFilter)
    : users;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      const channel = form.channel_type === 'none' ? undefined : {
        channel_type: form.channel_type,
        ...(form.channel_type === 'wecom' && {
          wecom_bot_id: form.wecom_bot_id,
          wecom_secret: form.wecom_secret,
        }),
        ...(form.channel_type === 'teams' && {
          teams_app_id: form.teams_app_id,
          teams_app_password: form.teams_app_password,
          teams_tenant_id: form.teams_tenant_id,
        }),
      };
      await createUser({
        user_id: form.user_id,
        display_name: form.display_name,
        email: form.email || undefined,
        skill_group: form.skill_group,
        model: form.model,
        plan: 'free',
        channel: channel as Parameters<typeof createUser>[0]['channel'],
      });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      await loadUsers();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleBatchAction = async () => {
    if (!batchAction) return;
    setBatchLoading(true);
    try {
      const status = batchAction === 'suspend' ? 'suspended' : 'active';
      await Promise.all(selectedKeys.map((id) => updateUserStatus(id, status)));
      setSelectedKeys([]);
      setBatchAction(null);
      await loadUsers();
    } catch {
      // handled by api.ts
    } finally {
      setBatchLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteUser(deleteTarget.user_id);
      setDeleteTarget(null);
      await loadUsers();
    } catch {
      // handled by api.ts
    } finally {
      setDeleteLoading(false);
    }
  };

  const columns: Column<User>[] = [
    {
      key: 'user_id', header: t('users.userId'), sortable: true,
      render: (r) => (
        <button onClick={() => navigate(`/users/${r.user_id}`)} className="text-blue-600 hover:underline font-medium">
          {r.user_id}
        </button>
      ),
    },
    { key: 'display_name', header: t('users.displayName'), render: (r) => r.display_name, sortable: true },
    {
      key: 'status', header: t('users.status'), sortable: true,
      render: (r) => (
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[r.status] ?? ''}`}>
          {r.status ? t(`users.status${r.status.charAt(0).toUpperCase() + r.status.slice(1)}` as never) : '—'}
        </span>
      ),
    },
    { key: 'model', header: t('users.model'), render: (r) => r.model || '—', sortable: true },
    { key: 'skill_group', header: t('users.skillGroup'), render: (r) => r.skill_group || '—' },
    { key: 'task_status', header: t('users.containerStatus'), render: (r) => r.task_status || '—' },
    {
      key: 'last_active_at', header: t('users.lastActive'), sortable: true,
      render: (r) => r.last_active_at ? new Date(r.last_active_at).toLocaleString() : '—',
    },
    {
      key: '_actions', header: t('common.actions'),
      render: (r) => isAdmin ? (
        <button
          onClick={(e) => { e.stopPropagation(); setDeleteTarget(r); }}
          className="text-red-600 hover:text-red-800 text-xs font-medium"
        >
          {t('common.delete')}
        </button>
      ) : <span className="text-gray-400 text-xs">—</span>,
    },
  ];

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      {/* Status filter */}
      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as UserStatus | '')}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{t('common.all')}</option>
        <option value="active">{t('users.statusActive')}</option>
        <option value="suspended">{t('users.statusSuspended')}</option>
        <option value="deleted">{t('users.statusDeleted')}</option>
      </select>

      {/* Batch actions */}
      {isAdmin && selectedKeys.length > 0 && (
        <>
          <button
            onClick={() => setBatchAction('suspend')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
          >
            <Pause size={14} />
            {t('users.batchSuspend')} ({selectedKeys.length})
          </button>
          <button
            onClick={() => setBatchAction('activate')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
          >
            <Play size={14} />
            {t('users.batchActivate')} ({selectedKeys.length})
          </button>
        </>
      )}

      {/* Create button */}
      {isAdmin && (
        <button
        onClick={() => setShowCreate(true)}
        className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
      >
        <Plus size={16} />
        {t('users.createUser')}
      </button>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('users.title')}</h1>

      <DataTable
        columns={columns}
        data={filteredUsers}
        rowKey={(r) => r.user_id}
        searchable
        searchFilter={(row, q) =>
          row.user_id.toLowerCase().includes(q) ||
          row.display_name.toLowerCase().includes(q)
        }
        selectable
        onSelectionChange={setSelectedKeys}
        loading={loading}
        toolbar={toolbar}
      />

      {/* Create user modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">{t('users.createUser')}</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">

              {/* Section: Basic Info */}
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{t('users.sectionBasic')}</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.userId')} *</label>
                  <input type="text" value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })} required placeholder="zhangsan" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <p className="mt-0.5 text-xs text-gray-400">{t('users.userIdHint')}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.displayName')} *</label>
                  <input type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required placeholder={t('users.displayNamePlaceholder')} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.email')}</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user@example.com" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>

              {/* Section: Model & Config */}
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider pt-2">{t('users.sectionConfig')}</div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.model')} *</label>
                <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">{t('users.selectModel')}</option>
                  {providers.map((p) => (
                    <option key={p.provider_id} value={p.litellm_model_name}>
                      {p.litellm_model_name} ({p.provider_type === 'bedrock' ? 'Bedrock' : 'LiteLLM'})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.skillGroup')}</label>
                  <select value={form.skill_group} onChange={(e) => setForm({ ...form, skill_group: e.target.value })} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="general">general</option>
                    <option value="sales">sales</option>
                    <option value="dev">dev</option>
                  </select>
                </div>

              {/* Section: Channel */}
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider pt-2">{t('users.sectionChannel')}</div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.channelType')}</label>
                <select value={form.channel_type} onChange={(e) => setForm({ ...form, channel_type: e.target.value as ChannelType })} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="none">{t('users.channelNone')}</option>
                  <option value="wecom">{t('users.channelWecom')}</option>
                  <option value="teams">{t('users.channelTeams')}</option>
                </select>
              </div>

              {/* WeCom fields */}
              {form.channel_type === 'wecom' && (
                <div className="space-y-3 pl-3 border-l-2 border-orange-200">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.wecomBotId')} *</label>
                    <input type="text" value={form.wecom_bot_id} onChange={(e) => setForm({ ...form, wecom_bot_id: e.target.value })} required placeholder="aibXXX" className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.wecomSecret')} *</label>
                    <input type="password" value={form.wecom_secret} onChange={(e) => setForm({ ...form, wecom_secret: e.target.value })} required className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              )}

              {/* Teams fields */}
              {form.channel_type === 'teams' && (
                <div className="space-y-3 pl-3 border-l-2 border-blue-200">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.teamsAppId')} *</label>
                    <input type="text" value={form.teams_app_id} onChange={(e) => setForm({ ...form, teams_app_id: e.target.value })} required className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.teamsAppPassword')} *</label>
                    <input type="password" value={form.teams_app_password} onChange={(e) => setForm({ ...form, teams_app_password: e.target.value })} required className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('users.teamsTenantId')}</label>
                    <input type="text" value={form.teams_tenant_id} onChange={(e) => setForm({ ...form, teams_tenant_id: e.target.value })} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              )}

              {createError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">{createError}</div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">{t('common.cancel')}</button>
                <button type="submit" disabled={creating} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {creating ? t('common.loading') : t('common.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Batch confirm dialog */}
      <ConfirmDialog
        open={batchAction !== null}
        title={batchAction === 'suspend' ? t('users.batchSuspend') : t('users.batchActivate')}
        message={
          batchAction === 'suspend'
            ? t('users.confirmSuspend', { count: selectedKeys.length })
            : t('users.confirmActivate', { count: selectedKeys.length })
        }
        variant={batchAction === 'suspend' ? 'danger' : 'default'}
        onConfirm={handleBatchAction}
        onCancel={() => setBatchAction(null)}
        loading={batchLoading}
      />

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('users.deleteUser')}
        message={deleteTarget ? t('users.confirmDelete', { userId: deleteTarget.user_id }) : ''}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        loading={deleteLoading}
      />
    </div>
  );
}

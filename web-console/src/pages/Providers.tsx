// ============================================================
// Providers (Model Management) Page
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Zap, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import DataTable, { type Column } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useRole } from '@/lib/role';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  testProviderInline,
  testProviderById,
  type ProviderWithCount,
  type ProviderType,
  type ProviderStatus,
  type ProviderTestResult,
} from '@/lib/api';

interface ProviderFormData {
  provider_name: string;
  provider_type: ProviderType;
  // Bedrock fields
  bedrock_model_id: string;
  aws_region: string;
  // LiteLLM fields
  litellm_model_id: string;
  base_url: string;
  api_key: string;
  // Common
  display_name: string;
  is_default: boolean;
  status: ProviderStatus;
}

const EMPTY_FORM: ProviderFormData = {
  provider_name: '',
  provider_type: 'bedrock',
  bedrock_model_id: '',
  aws_region: 'us-east-1',
  litellm_model_id: '',
  base_url: '',
  api_key: '',
  display_name: '',
  is_default: false,
  status: 'active',
};

/** Convert form data to API payload */
function formToPayload(form: ProviderFormData) {
  const isBedrock = form.provider_type === 'bedrock';
  return {
    provider_name: form.provider_name,
    provider_type: form.provider_type,
    litellm_model_id: isBedrock ? `bedrock/${form.bedrock_model_id}` : form.litellm_model_id,
    litellm_model_name: form.display_name,
    aws_region: isBedrock ? form.aws_region : undefined,
    base_url: isBedrock ? undefined : (form.base_url || undefined),
    api_key: isBedrock ? undefined : (form.api_key || undefined),
    is_default: form.is_default,
    status: form.status,
  };
}

/** Convert API provider to form data */
function providerToForm(p: ProviderWithCount): ProviderFormData {
  const isBedrock = p.provider_type === 'bedrock';
  return {
    provider_name: p.provider_name,
    provider_type: p.provider_type,
    bedrock_model_id: isBedrock ? p.litellm_model_id.replace(/^bedrock\//, '') : '',
    aws_region: p.aws_region ?? 'us-east-1',
    litellm_model_id: isBedrock ? '' : p.litellm_model_id,
    base_url: p.base_url ?? '',
    api_key: '',
    display_name: p.litellm_model_name,
    is_default: p.is_default,
    status: p.status,
  };
}

export default function Providers() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();

  const [providers, setProviders] = useState<ProviderWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderWithCount | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [rowTesting, setRowTesting] = useState<string | null>(null);
  const [rowTestResult, setRowTestResult] = useState<{ id: string; result: ProviderTestResult } | null>(null);

  const loadProviders = useCallback(async () => {
    try { setProviders(await listProviders()); } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setTestResult(null);
    setShowModal(true);
  };

  const openEdit = (p: ProviderWithCount) => {
    setEditingId(p.provider_id);
    setForm(providerToForm(p));
    setFormError('');
    setTestResult(null);
    setShowModal(true);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const payload = formToPayload(form);
    try {
      const result = await testProviderInline({
        provider_type: payload.provider_type,
        litellm_model_id: payload.litellm_model_id,
        litellm_model_name: payload.litellm_model_name,
        base_url: payload.base_url,
        api_key: payload.api_key,
        aws_region: payload.aws_region,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, latency_ms: 0, model: payload.litellm_model_name, error: err instanceof Error ? err.message : 'Test failed' });
    } finally { setTesting(false); }
  };

  const handleRowTest = async (providerId: string) => {
    setRowTesting(providerId);
    setRowTestResult(null);
    try {
      const result = await testProviderById(providerId);
      setRowTestResult({ id: providerId, result });
    } catch (err) {
      setRowTestResult({ id: providerId, result: { success: false, latency_ms: 0, model: '', error: err instanceof Error ? err.message : 'Test failed' } });
    } finally { setRowTesting(null); }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      const payload = formToPayload(form);
      if (editingId) {
        await updateProvider(editingId, payload);
      } else {
        await createProvider(payload as Parameters<typeof createProvider>[0]);
      }
      setShowModal(false);
      await loadProviders();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try { await deleteProvider(deleteTarget.provider_id); setDeleteTarget(null); await loadProviders(); } catch { /* */ } finally { setDeleteLoading(false); }
  };

  const isBedrock = form.provider_type === 'bedrock';

  const columns: Column<ProviderWithCount>[] = [
    { key: 'provider_name', header: t('providers.providerName'), render: (r) => r.provider_name, sortable: true },
    { key: 'provider_type', header: t('providers.providerType'), render: (r) => (
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${r.provider_type === 'bedrock' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>
        {r.provider_type === 'bedrock' ? 'Bedrock' : 'LiteLLM'}
      </span>
    ), sortable: true },
    { key: 'litellm_model_name', header: t('providers.displayName'), render: (r) => <span className="font-mono text-xs">{r.litellm_model_name}</span> },
    { key: 'litellm_model_id', header: t('providers.modelId'), render: (r) => <span className="font-mono text-xs text-gray-500">{r.litellm_model_id}</span> },
    { key: 'aws_region', header: t('providers.region'), render: (r) => r.provider_type === 'bedrock' ? (r.aws_region || '—') : '—' },
    {
      key: 'status', header: t('providers.status'), sortable: true,
      render: (r) => (
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${r.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
          {r.status ? t(`providers.status${r.status.charAt(0).toUpperCase() + r.status.slice(1)}` as never) : '—'}
        </span>
      ),
    },
    { key: 'is_default', header: t('providers.isDefault'), render: (r) => r.is_default ? <span className="text-blue-600 font-medium">✓</span> : '—' },
    { key: 'user_count', header: t('providers.userCount'), render: (r) => r.user_count, sortable: true },
    {
      key: '_actions', header: t('common.actions'),
      render: (r) => (
        <div className="flex gap-2 items-center">
          <button onClick={() => handleRowTest(r.provider_id)} disabled={rowTesting === r.provider_id} className="text-emerald-600 hover:text-emerald-800 disabled:opacity-50" title={t('providers.testConnection')}>
            {rowTesting === r.provider_id ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
          </button>
          {rowTestResult?.id === r.provider_id && (
            rowTestResult.result.success
              ? <CheckCircle size={14} className="text-green-500" />
              : <span title={rowTestResult.result.error}><XCircle size={14} className="text-red-500" /></span>
          )}
          {isAdmin && <button onClick={() => openEdit(r)} className="text-blue-600 hover:text-blue-800 text-xs font-medium">{t('common.edit')}</button>}
          {isAdmin && <button onClick={() => setDeleteTarget(r)} className="text-red-600 hover:text-red-800 text-xs font-medium">{t('common.delete')}</button>}
        </div>
      ),
    },
  ];

  const toolbar = (
    <div className="flex items-center gap-2 ml-auto">
      {isAdmin && (
        <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
          <Plus size={16} />
          {t('providers.addProvider')}
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('providers.title')}</h1>

      <DataTable columns={columns} data={providers} rowKey={(r) => r.provider_id} searchable searchFilter={(row, q) => row.provider_name.toLowerCase().includes(q) || row.litellm_model_name.toLowerCase().includes(q)} loading={loading} toolbar={toolbar} />

      {/* Add/Edit modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">{editingId ? t('providers.editProvider') : t('providers.addProvider')}</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">

              {/* Provider Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.providerName')}</label>
                <input type="text" value={form.provider_name} onChange={(e) => setForm({ ...form, provider_name: e.target.value })} required placeholder={t('providers.providerNamePlaceholder')} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>

              {/* Provider Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.providerType')}</label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => { setForm({ ...form, provider_type: 'bedrock' }); setTestResult(null); }}
                    className={`px-4 py-3 rounded-lg border-2 text-sm font-medium transition-colors ${form.provider_type === 'bedrock' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
                    <div className="font-semibold">Bedrock</div>
                    <div className="text-xs mt-0.5 opacity-75">{t('providers.bedrockTypeHint')}</div>
                  </button>
                  <button type="button" onClick={() => { setForm({ ...form, provider_type: 'litellm' }); setTestResult(null); }}
                    className={`px-4 py-3 rounded-lg border-2 text-sm font-medium transition-colors ${form.provider_type === 'litellm' ? 'border-purple-500 bg-purple-50 text-purple-700' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
                    <div className="font-semibold">LiteLLM / OpenAI</div>
                    <div className="text-xs mt-0.5 opacity-75">{t('providers.litellmTypeHint')}</div>
                  </button>
                </div>
              </div>

              {/* ── Bedrock-specific fields ── */}
              {isBedrock && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.bedrockModelId')} *</label>
                    <input type="text" value={form.bedrock_model_id} onChange={(e) => setForm({ ...form, bedrock_model_id: e.target.value })} required
                      placeholder="deepseek.v3.2"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="mt-1 text-xs text-gray-500">{t('providers.bedrockModelIdHint')}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.region')} *</label>
                    <select value={form.aws_region} onChange={(e) => setForm({ ...form, aws_region: e.target.value })} required className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="us-east-1">us-east-1 (N. Virginia)</option>
                      <option value="us-west-2">us-west-2 (Oregon)</option>
                      <option value="eu-west-1">eu-west-1 (Ireland)</option>
                      <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                      <option value="ap-northeast-1">ap-northeast-1 (Tokyo)</option>
                      <option value="ap-northeast-2">ap-northeast-2 (Seoul)</option>
                      <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                      <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                    </select>
                    <p className="mt-1 text-xs text-gray-500">{t('providers.bedrockRegionHint')}</p>
                  </div>
                </>
              )}

              {/* ── LiteLLM-specific fields ── */}
              {!isBedrock && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.baseUrl')} *</label>
                    <input type="url" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} required
                      placeholder="https://api.openai.com"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="mt-1 text-xs text-gray-500">{t('providers.baseUrlHint')}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.apiKey')}</label>
                    <input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                      placeholder={editingId ? t('providers.apiKeyPlaceholderEdit') : 'sk-...'}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="mt-1 text-xs text-gray-500">{t('providers.apiKeyHint')}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.litellmModelIdLabel')} *</label>
                    <input type="text" value={form.litellm_model_id} onChange={(e) => setForm({ ...form, litellm_model_id: e.target.value })} required
                      placeholder="gpt-4o"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="mt-1 text-xs text-gray-500">{t('providers.litellmModelIdHint')}</p>
                  </div>
                </>
              )}

              {/* Display Name (common) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('providers.displayName')} *</label>
                <input type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required
                  placeholder={isBedrock ? 'claude-opus-4.6' : 'gpt-4o'}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="mt-1 text-xs text-gray-500">{t('providers.displayNameHint')}</p>
              </div>

              {/* Default + Status */}
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="rounded border-gray-300" />
                  {t('providers.isDefault')}
                </label>
                {editingId && (
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ProviderStatus })} className="border border-gray-300 rounded px-2 py-1 text-sm">
                    <option value="active">{t('providers.statusActive')}</option>
                    <option value="disabled">{t('providers.statusDisabled')}</option>
                  </select>
                )}
              </div>

              {/* Test Connection */}
              <div className="border-t border-gray-200 pt-4">
                <button type="button" onClick={handleTest} disabled={testing || !form.display_name || (isBedrock ? !form.bedrock_model_id : (!form.base_url || !form.litellm_model_id))}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50 transition-colors">
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  {t('providers.testConnection')}
                </button>
                {testResult && (
                  <div className={`mt-2 flex items-start gap-2 text-sm rounded-lg px-3 py-2 ${testResult.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                    {testResult.success ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
                    <div>{testResult.success ? t('providers.testSuccess', { latency: testResult.latency_ms }) : t('providers.testFailed', { error: testResult.error })}</div>
                  </div>
                )}
              </div>

              {formError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">{formError}</div>}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">{t('common.cancel')}</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {saving ? t('common.loading') : t('common.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog open={deleteTarget !== null} title={t('providers.deleteProvider')}
        message={deleteTarget ? (deleteTarget.user_count > 0 ? t('providers.deleteWarning', { count: deleteTarget.user_count }) : t('providers.confirmDelete', { name: deleteTarget.provider_name })) : ''}
        variant="danger" onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} loading={deleteLoading} />
    </div>
  );
}

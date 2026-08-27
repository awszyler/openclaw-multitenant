// ============================================================
// User Detail Page — 6 Tabs: Overview, Model, Channel, Skill, Usage, Logs
// Validates: Requirements 9.2, 17.1-17.6
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Play,
  Square,
  RotateCcw,
  Save,
  Info,
  Cpu,
  Radio,
  Wrench,
  BarChart3,
  FileText,
} from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import {
  getUser,
  updateUserModel,
  startContainer,
  stopContainer,
  restartContainer,
  listProviders,
  getAuditLogs,
  type User,
  type ProviderWithCount,
  type AuditLog,
} from '@/lib/api';

type TabKey = 'overview' | 'model' | 'channel' | 'skill' | 'usage' | 'logs';

const TAB_ICONS: Record<TabKey, React.ReactNode> = {
  overview: <Info size={16} />,
  model: <Cpu size={16} />,
  channel: <Radio size={16} />,
  skill: <Wrench size={16} />,
  usage: <BarChart3 size={16} />,
  logs: <FileText size={16} />,
};

export default function UserDetail() {
  const { t } = useTranslation();
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // Container action confirm
  const [containerAction, setContainerAction] = useState<'stop' | 'restart' | null>(null);
  const [containerLoading, setContainerLoading] = useState(false);

  // Model tab state
  const [providers, setProviders] = useState<ProviderWithCount[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelSaving, setModelSaving] = useState(false);
  const [modelMsg, setModelMsg] = useState('');

  // Logs tab state
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const loadUser = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await getUser(userId);
      setUser(data);
      setSelectedModel(data.model);
    } catch {
      // handled by api.ts
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadUser(); }, [loadUser]);

  // Auto-poll user data while container is in a transitional state or not yet healthy
  useEffect(() => {
    if (!user) return;
    const transitional = ['PROVISIONING', 'PENDING', 'DEPROVISIONING', 'ACTIVATING'];
    const needsPoll = containerLoading
      || transitional.includes(user.task_status ?? '')
      || (user.task_status === 'RUNNING' && user.task_health !== 'HEALTHY');
    if (needsPoll) {
      const interval = setInterval(() => { loadUser(); }, 5000);
      return () => clearInterval(interval);
    }
  }, [user, containerLoading, loadUser]);

  // Load providers when model tab is active
  useEffect(() => {
    if (activeTab === 'model') {
      listProviders().then(setProviders).catch(() => {});
    }
  }, [activeTab]);

  // Load audit logs when logs tab is active
  useEffect(() => {
    if (activeTab === 'logs' && userId) {
      setLogsLoading(true);
      getAuditLogs({ target_id: userId })
        .then(setAuditLogs)
        .catch(() => {})
        .finally(() => setLogsLoading(false));
    }
  }, [activeTab, userId]);

  const handleContainerAction = async () => {
    if (!userId || !containerAction) return;
    setContainerLoading(true);
    try {
      if (containerAction === 'stop') {
        await stopContainer(userId);
      } else {
        await restartContainer(userId);
      }
      setContainerAction(null);
      await loadUser();
    } catch {
      // handled by api.ts
    } finally {
      setContainerLoading(false);
    }
  };

  const handleStartContainer = async () => {
    if (!userId) return;
    setContainerLoading(true);
    try {
      await startContainer(userId);
      await loadUser();
    } catch {
      // handled by api.ts
    } finally {
      setContainerLoading(false);
    }
  };

  const handleSaveModel = async () => {
    if (!userId || !user) return;

    // Detect switches that require a container restart:
    //   - cross-type (litellm ↔ bedrock): config shape changes
    //   - bedrock → bedrock: model ID + region baked into openclaw.json
    // litellm → litellm is picked up live by the Lambda proxy, no restart.
    const oldProvider = providers.find((p) => p.litellm_model_name === user.model);
    const newProvider = providers.find((p) => p.litellm_model_name === selectedModel);
    const oldType = oldProvider?.provider_type ?? 'litellm';
    const newType = newProvider?.provider_type ?? 'litellm';
    const needsRestart = oldType !== newType || newType === 'bedrock';

    if (needsRestart) {
      const confirmed = window.confirm(t('userDetail.crossTypeSwitchWarning'));
      if (!confirmed) return;
    }

    setModelSaving(true);
    setModelMsg('');
    try {
      const updated = await updateUserModel(userId, selectedModel);
      setUser(updated);
      setModelMsg(needsRestart ? t('userDetail.modelSaveHintRestart') : t('userDetail.modelSaveHint'));
    } catch (err) {
      setModelMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setModelSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">{t('common.loading')}</div>;
  }

  if (!user) {
    return <div className="flex items-center justify-center h-64 text-gray-500">User not found</div>;
  }

  const tabs: TabKey[] = ['overview', 'model', 'channel', 'skill', 'usage', 'logs'];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/users')} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{user.display_name}</h1>
          <p className="text-sm text-gray-500">{user.user_id}</p>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {TAB_ICONS[tab]}
              {t(`userDetail.tabs.${tab}`)}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'overview' && <OverviewTab user={user} t={t} containerLoading={containerLoading} onStart={handleStartContainer} onStop={() => setContainerAction('stop')} onRestart={() => setContainerAction('restart')} />}
        {activeTab === 'model' && <ModelTab user={user} t={t} providers={providers} selectedModel={selectedModel} onModelChange={setSelectedModel} onSave={handleSaveModel} saving={modelSaving} message={modelMsg} />}
        {activeTab === 'channel' && <ChannelTab user={user} t={t} />}
        {activeTab === 'skill' && <SkillTab user={user} t={t} />}
        {activeTab === 'usage' && <UsageTab user={user} t={t} />}
        {activeTab === 'logs' && <LogsTab logs={auditLogs} loading={logsLoading} t={t} />}
      </div>

      {/* Container action confirm */}
      <ConfirmDialog
        open={containerAction !== null}
        title={containerAction === 'stop' ? t('userDetail.stopContainer') : t('userDetail.restartContainer')}
        message={containerAction === 'stop' ? t('userDetail.confirmStop') : t('userDetail.confirmRestart')}
        variant="danger"
        onConfirm={handleContainerAction}
        onCancel={() => setContainerAction(null)}
        loading={containerLoading}
      />
    </div>
  );
}

// ---- Tab Components ----

interface TabProps {
  user: User;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function OverviewTab({ user, t, containerLoading, onStart, onStop, onRestart }: TabProps & {
  containerLoading: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  // Container is "transitioning" when an action is in progress or ECS status is transitional
  const transitionalStatuses = ['PROVISIONING', 'PENDING', 'DEPROVISIONING', 'ACTIVATING'];
  const isTransitioning = containerLoading || transitionalStatuses.includes(user.task_status ?? '');
  const isRunning = user.task_status === 'RUNNING';
  const isHealthy = isRunning && user.task_health === 'HEALTHY';
  const isRunningNotHealthy = isRunning && !isHealthy;
  const showProgress = containerLoading || isTransitioning || isRunningNotHealthy;
  const isStopped = !user.task_status || user.task_status === 'STOPPED' || user.task_status === 'FAILED';

  // Determine progress text
  let progressText = '';
  if (containerLoading) {
    progressText = t('userDetail.containerActionInProgress');
  } else if (isRunningNotHealthy) {
    progressText = t('userDetail.containerAlmostReady');
  } else if (isTransitioning) {
    progressText = t('userDetail.containerTransitioning');
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Basic info */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">{t('userDetail.basicInfo')}</h3>
        <dl className="space-y-3 text-sm">
          {([
            [t('users.userId'), user.user_id],
            [t('users.displayName'), user.display_name],
            [t('users.email'), user.email || '—'],
            [t('users.skillGroup'), user.skill_group || '—'],
            [t('users.createdAt'), user.created_at ? new Date(user.created_at).toLocaleString() : '—'],
            [t('users.lastActive'), user.last_active_at ? new Date(user.last_active_at).toLocaleString() : '—'],
          ] as const).map(([label, value]) => (
            <div key={label} className="flex justify-between">
              <dt className="text-gray-500">{label}</dt>
              <dd className="text-gray-900 font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Container status */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">{t('userDetail.containerInfo')}</h3>
        <dl className="space-y-3 text-sm mb-4">
          <div className="flex justify-between">
            <dt className="text-gray-500">{t('users.containerStatus')}</dt>
            <dd className="text-gray-900 font-medium">{user.task_status || '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">{t('userDetail.taskArn')}</dt>
            <dd className="text-gray-900 font-mono text-xs truncate max-w-[250px]" title={user.task_arn}>{user.task_arn || '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">{t('userDetail.taskIp')}</dt>
            <dd className="text-gray-900 font-medium">{user.task_ip || '—'}</dd>
          </div>
        </dl>

        {/* Progress bar during transitional states */}
        {showProgress && (
          <div className="mb-4">
            <div className="flex items-center gap-2 text-sm mb-2">
              <RotateCcw size={14} className={`animate-spin ${isRunningNotHealthy ? 'text-green-500' : 'text-blue-600'}`} />
              <span className={isRunningNotHealthy ? 'text-green-600' : 'text-blue-600'}>{progressText}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full ${isRunningNotHealthy ? 'bg-green-500' : 'bg-blue-500'}`}
                style={{
                  width: isRunningNotHealthy ? '80%' : '30%',
                  animation: isRunningNotHealthy ? undefined : 'progress-slide 1.5s ease-in-out infinite',
                  transition: 'width 0.5s ease',
                }}
              />
            </div>
            <style>{`
              @keyframes progress-slide {
                0% { margin-left: 0%; }
                50% { margin-left: 70%; }
                100% { margin-left: 0%; }
              }
            `}</style>
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={onStart} disabled={showProgress || isRunning}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              showProgress || isRunning
                ? 'text-gray-400 bg-gray-100 border-gray-200 cursor-not-allowed'
                : 'text-green-700 bg-green-50 border-green-200 hover:bg-green-100'
            }`}>
            <Play size={14} /> {t('userDetail.startContainer')}
          </button>
          <button onClick={onRestart} disabled={showProgress || isStopped}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              showProgress || isStopped
                ? 'text-gray-400 bg-gray-100 border-gray-200 cursor-not-allowed'
                : 'text-yellow-700 bg-yellow-50 border-yellow-200 hover:bg-yellow-100'
            }`}>
            <RotateCcw size={14} /> {t('userDetail.restartContainer')}
          </button>
          <button onClick={onStop} disabled={showProgress || isStopped}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              showProgress || isStopped
                ? 'text-gray-400 bg-gray-100 border-gray-200 cursor-not-allowed'
                : 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'
            }`}>
            <Square size={14} /> {t('userDetail.stopContainer')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelTab({ user, t, providers, selectedModel, onModelChange, onSave, saving, message }: TabProps & {
  providers: ProviderWithCount[];
  selectedModel: string;
  onModelChange: (m: string) => void;
  onSave: () => void;
  saving: boolean;
  message: string;
}) {
  const activeProviders = providers.filter((p) => p.status === 'active');

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 max-w-xl">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{t('userDetail.currentModel')}</h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('userDetail.selectModel')}</label>
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">—</option>
            {activeProviders.map((p) => (
              <option key={p.provider_id} value={p.litellm_model_name}>
                {p.litellm_model_name} ({p.provider_type === 'bedrock' ? 'Bedrock' : 'LiteLLM'})
              </option>
            ))}
          </select>
        </div>

        <div className="text-sm text-gray-500 space-y-1">
          <p>{t('userDetail.configVersion')}: <span className="font-medium text-gray-900">{user.config_version}</span></p>
          <p>{t('userDetail.lastModified')}: <span className="font-medium text-gray-900">{user.updated_at ? new Date(user.updated_at).toLocaleString() : '—'}</span></p>
        </div>

        {user.allowed_models && user.allowed_models.length > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700 mb-1">{t('users.allowedModels')}</p>
            <div className="flex flex-wrap gap-1.5">
              {user.allowed_models.map((m) => (
                <span key={m} className="inline-block px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs">{m}</span>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={onSave}
            disabled={saving || selectedModel === user.model}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Save size={16} />
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>

        {message && (
          <p className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{message}</p>
        )}
      </div>
    </div>
  );
}

function ChannelTab({ user, t }: TabProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 max-w-xl">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{t('userDetail.tabs.channel')}</h3>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-500">{t('users.wecomBotId')}</dt>
          <dd className="text-gray-900 font-medium">{user.wecom_bot_id || '—'}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">{t('userDetail.wecomStatus')}</dt>
          <dd className="text-gray-900 font-medium">{user.task_status === 'RUNNING' ? '✅ Connected' : '—'}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-gray-400">{t('userDetail.credentialHint')}</p>
    </div>
  );
}

function SkillTab({ user, t }: TabProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 max-w-xl">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{t('userDetail.tabs.skill')}</h3>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-500">{t('userDetail.currentSkillGroup')}</dt>
          <dd className="text-gray-900 font-medium">{user.skill_group || '—'}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-gray-400">{t('userDetail.skillGroupHint')}</p>
    </div>
  );
}

function UsageTab({ user, t }: TabProps) {
  const quotaLimit = user.quota?.max_monthly_tokens ?? 0;
  const usagePercent = quotaLimit > 0 ? Math.min(100, Math.round((user.usage_tokens / quotaLimit) * 100)) : 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 max-w-xl">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">{t('userDetail.monthlyUsage')}</h3>

      <div className="space-y-4">
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-500">{t('userDetail.usageTokens')}</dt>
            <dd className="text-gray-900 font-semibold">{user.usage_tokens.toLocaleString()}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">{t('userDetail.quotaLimit')}</dt>
            <dd className="text-gray-900 font-semibold">{quotaLimit > 0 ? quotaLimit.toLocaleString() : '∞'}</dd>
          </div>
        </dl>

        {/* Progress bar */}
        {quotaLimit > 0 && (
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{t('userDetail.quotaUsage')}</span>
              <span>{usagePercent}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className={`h-2.5 rounded-full transition-all ${usagePercent >= 90 ? 'bg-red-500' : usagePercent >= 70 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
          </div>
        )}

        <p className="text-xs text-gray-400">
          {user.usage_month ? `Usage month: ${user.usage_month}` : ''}
        </p>
      </div>
    </div>
  );
}

function LogsTab({ logs, loading, t }: { logs: AuditLog[]; loading: boolean; t: (key: string) => string }) {
  if (loading) {
    return <div className="text-center text-gray-500 py-12">{t('common.loading')}</div>;
  }

  if (logs.length === 0) {
    return <div className="text-center text-gray-500 py-12">{t('common.noData')}</div>;
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
      {logs.map((log) => (
        <div key={log['timestamp#log_id']} className="px-5 py-3 flex items-start gap-4">
          <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-blue-400" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-gray-900">{log.action}</span>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500">{log.actor}</span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {log.created_at ? new Date(log.created_at).toLocaleString() : ''}
            </p>
            {log.detail && Object.keys(log.detail).length > 0 && (
              <pre className="mt-1 text-xs text-gray-500 bg-gray-50 rounded px-2 py-1 overflow-x-auto">
                {JSON.stringify(log.detail, null, 2)}
              </pre>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

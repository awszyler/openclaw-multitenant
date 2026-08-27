// ============================================================
// Settings Page — System health check
// ============================================================

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle, XCircle } from 'lucide-react';
import { getHealthStatus, type HealthStatus } from '@/lib/api';

export default function Settings() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHealthStatus()
      .then(setHealth)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const services = health
    ? [
        { key: 'dynamodb', label: t('settings.dynamodb'), status: health.dynamodb },
        { key: 'ecs', label: t('settings.ecs'), status: health.ecs },
        { key: 's3', label: t('settings.s3'), status: health.s3 },
      ]
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('settings.title')}</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={18} className="text-gray-600" />
          <h2 className="text-sm font-semibold text-gray-700">{t('settings.healthCheck')}</h2>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">{t('common.loading')}</p>
        ) : (
          <div className="space-y-3">
            {services.map((svc) => (
              <div key={svc.key} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <span className="text-sm text-gray-700">{svc.label}</span>
                <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${svc.status === 'healthy' ? 'text-green-600' : 'text-red-600'}`}>
                  {svc.status === 'healthy' ? <CheckCircle size={16} /> : <XCircle size={16} />}
                  {svc.status === 'healthy' ? t('settings.healthy') : t('settings.unhealthy')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

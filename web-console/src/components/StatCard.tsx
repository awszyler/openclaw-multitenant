// ============================================================
// StatCard Component — Dashboard statistics card
// Validates: Requirements 9.2
// ============================================================

import type { ReactNode } from 'react';

export interface StatCardProps {
  title: string;
  value: string | number;
  icon: ReactNode;
  /** Optional color accent: blue (default), green, yellow, purple, red */
  color?: 'blue' | 'green' | 'yellow' | 'purple' | 'red';
}

const COLOR_MAP = {
  blue: {
    bg: 'bg-blue-50',
    text: 'text-blue-600',
  },
  green: {
    bg: 'bg-green-50',
    text: 'text-green-600',
  },
  yellow: {
    bg: 'bg-yellow-50',
    text: 'text-yellow-600',
  },
  purple: {
    bg: 'bg-purple-50',
    text: 'text-purple-600',
  },
  red: {
    bg: 'bg-red-50',
    text: 'text-red-600',
  },
} as const;

export default function StatCard({ title, value, icon, color = 'blue' }: StatCardProps) {
  const colors = COLOR_MAP[color];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-4">
      <div className={`flex-shrink-0 w-12 h-12 rounded-lg ${colors.bg} ${colors.text} flex items-center justify-center`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-gray-500 truncate">{title}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
      </div>
    </div>
  );
}

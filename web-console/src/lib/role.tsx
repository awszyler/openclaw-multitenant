// ============================================================
// Role Context — provides current user role to all components
// ============================================================

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { getCurrentUser, type UserRole } from './api';

interface RoleContextValue {
  role: UserRole;
  isAdmin: boolean;
  loading: boolean;
}

const RoleContext = createContext<RoleContextValue>({
  role: 'viewer',
  isAdmin: false,
  loading: true,
});

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<UserRole>('viewer');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentUser()
      .then((user) => setRole(user.role))
      .catch(() => setRole('viewer'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <RoleContext.Provider value={{ role, isAdmin: role === 'admin', loading }}>
      {children}
    </RoleContext.Provider>
  );
}

export function useRole(): RoleContextValue {
  return useContext(RoleContext);
}

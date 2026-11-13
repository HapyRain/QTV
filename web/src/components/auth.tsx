'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, STATUS_QUERY_KEY } from '@/lib/client-api';

/**
 * 移动端本地宿主状态上下文（已剥离 PC/服务端密码弹窗与环境变量提示）：
 * - Android LocalApi 恒返回 verified=true、passwordRequired=false；
 * - 保持 useAuth() 接口签名 100% 兼容，默认 verified=true，首屏零阻塞直达内容。
 */

interface AuthContextValue {
  checked: boolean;
  verified: boolean;
  setupRequired: boolean;
  version: string | null;
  openLogin: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  checked: true,
  verified: true,
  setupRequired: false,
  version: '1.0',
  openLogin: () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState<string | null>('1.0');
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    queryClient
      .fetchQuery({ queryKey: STATUS_QUERY_KEY, queryFn: () => api.status() })
      .then((s) => {
        if (cancelled) return;
        if (s?.version) setVersion(s.version.replace(/-app$/, ''));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  return (
    <AuthContext.Provider
      value={{
        checked: true,
        verified: true,
        setupRequired: false,
        version,
        openLogin: () => {},
        logout: async () => {},
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

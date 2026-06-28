import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Auth context — wraps the app and exposes login/logout + auth state.
 *
 * Bevarar INGET state i localStorage. Sanningskällan är cookien som backend
 * sätter via /api/auth/login. På mount + efter login/logout pollar vi
 * /api/auth/me för att synka kontext.
 */
interface AuthUser {
  username: string;
  /** True för root-admin (APP_USERNAME / file-auth-username). Vanliga
   *  customer-users skapade via /admin/users har isAdmin=false eller saknat. */
  isAdmin?: boolean;
  /** Per-användare-behörighet: åtkomst till valuebets-sektionen.
   *  Sätts av admin i /admin/users. Admin har alltid true. */
  valuebets?: boolean;
  /** Per-användare-behörighet: Bonus Finder (admin alltid true). */
  bonusFinder?: boolean;
  /** Per-användare-behörighet: Bonus Optimizer (admin alltid true). */
  bonusOptimizer?: boolean;
  /** Per-användare-behörighet: Athena AI-assistent (admin alltid true). */
  athena?: boolean;
}

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  /** True om användaren får se valuebets-sektionen (admin ELLER valuebets-flagga). */
  canValuebets: boolean;
  /** Per-funktion-åtkomst (admin ELLER respektive flagga). */
  canBonusFinder: boolean;
  canBonusOptimizer: boolean;
  canAthena: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) {
        setUser(null);
      } else if (res.ok) {
        const json = (await res.json()) as { authenticated?: boolean; user?: AuthUser };
        if (json.authenticated && json.user) setUser(json.user);
        else setUser(null);
      } else {
        // 5xx — behåll user-state oförändrat (transient fel) men gör inte krav på 401.
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (res.ok) {
          const json = (await res.json()) as { user?: AuthUser };
          if (json.user) setUser(json.user);
          else await refresh();
          return { ok: true as const };
        }
        if (res.status === 429) {
          return { ok: false as const, error: "Too many attempts. Try again later." };
        }
        let error = "Invalid credentials";
        try {
          const json = (await res.json()) as { error?: string };
          if (json.error) error = json.error;
        } catch {
          /* ignore parse */
        }
        return { ok: false as const, error };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : "Network error" };
      }
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      /* fall through — clear local state anyway */
    }
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isAdmin: user?.isAdmin === true,
      canValuebets: user?.isAdmin === true || user?.valuebets === true,
      canBonusFinder: user?.isAdmin === true || user?.bonusFinder === true,
      canBonusOptimizer: user?.isAdmin === true || user?.bonusOptimizer === true,
      canAthena: user?.isAdmin === true || user?.athena === true,
      isLoading,
      login,
      logout,
      refresh,
    }),
    [user, isLoading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

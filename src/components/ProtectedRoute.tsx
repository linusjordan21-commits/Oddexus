import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Wrapper som redirectar till /login om användaren inte är inloggad.
 *
 * Frontend-skyddet är ENBART en UX-bekvämlighet — alla känsliga
 * /api/*-endpoints måste själva returnera 401 om sessionscookien
 * saknas. Det görs via authGateMiddleware i vite.config.ts.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        …
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

/**
 * Wrapper som redirectar VANLIGA KUNDER (icke-admin) till /under-construction.
 * Root-admin släpps igenom till barnet. Utloggad användare skickas till /login
 * (samma som ProtectedRoute).
 *
 * Användning: skydda alla routes som inte är öppna för customers ännu — t.ex.
 * /, /valuebets, /bonus-optimizer, /odds-drops, /stake-betonline, /welcome-bonus,
 * /settings, /admin/*. Endast /autoclicker + /under-construction + /login är
 * tillgängliga för icke-admin.
 *
 * OBS: backend-skydd för /api/* går via authGateMiddleware + per-endpoint
 * isAdminUsername-checks. Det här är frontend-UX för att inte visa funktioner
 * som inte är klara ännu.
 */
export function AdminOnlyRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isAdmin, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        …
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (!isAdmin) {
    return <Navigate to="/under-construction" replace />;
  }

  return <>{children}</>;
}

/**
 * Wrapper för valuebets-sektionen: admin ELLER kund med per-användare-
 * behörigheten `valuebets` (sätts i /admin/users) släpps igenom. Övriga
 * kunder redirectas till /under-construction, utloggade till /login.
 *
 * OBS: backend-skyddet är valuebetsAccessMiddleware i vite.config.ts —
 * det här är frontend-UX ovanpå.
 */
export function ValuebetsRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, canValuebets, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        …
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (!canValuebets) {
    return <Navigate to="/under-construction" replace />;
  }

  return <>{children}</>;
}

/**
 * Generisk per-funktion-route: admin ELLER kund med rätt behörighet (sätts i
 * /admin/users). Övriga kunder → /under-construction, utloggade → /login.
 * Backend-skyddet är featureAccessMiddleware i vite.config.ts; detta är UX.
 */
export function FeatureRoute({
  feature,
  children,
}: {
  feature: "bonusFinder" | "bonusOptimizer" | "athena";
  children: ReactNode;
}) {
  const auth = useAuth();
  const location = useLocation();
  const allowed =
    feature === "bonusFinder"
      ? auth.canBonusFinder
      : feature === "bonusOptimizer"
        ? auth.canBonusOptimizer
        : auth.canAthena;

  if (auth.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        …
      </div>
    );
  }
  if (!auth.isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (!allowed) {
    return <Navigate to="/under-construction" replace />;
  }
  return <>{children}</>;
}

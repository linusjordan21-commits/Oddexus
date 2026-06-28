import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CreditCard, LogOut, Settings, Shield, User } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserSettings } from "@/hooks/useUserSettings";

/**
 * Floating user menu (top-right). Visas bara när användaren är inloggad.
 * Visar username + logout-knapp. Implementeras som fixed-position så den
 * inte stör befintliga sid-layouter.
 */
export function UserMenu() {
  const { user, isAuthenticated, isAdmin, logout } = useAuth();
  const { t } = useUserSettings();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  if (!isAuthenticated || !user) return null;

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setLoggingOut(false);
      setOpen(false);
    }
  };

  return (
    <div className="fixed right-3 top-3 z-50">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 items-center gap-2 rounded-full border bg-background/90 px-3 text-xs font-medium shadow-sm backdrop-blur transition hover:bg-muted/40"
          aria-label={user.username}
          aria-expanded={open}
        >
          <User className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{user.username}</span>
        </button>
        {open && (
          <>
            {/* click-outside catcher */}
            <button
              type="button"
              tabIndex={-1}
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setOpen(false)}
              aria-hidden
            />
            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border bg-background p-1 shadow-md">
              <button
                type="button"
                onClick={() => { setOpen(false); navigate("/billing"); }}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-foreground transition hover:bg-muted/40"
              >
                <CreditCard className="h-3.5 w-3.5" />
                {t("nav.billing")}
              </button>
              <button
                type="button"
                onClick={() => { setOpen(false); navigate("/settings"); }}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-foreground transition hover:bg-muted/40"
              >
                <Settings className="h-3.5 w-3.5" />
                {t("nav.settings")}
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => { setOpen(false); navigate("/admin"); }}
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-foreground transition hover:bg-muted/40"
                >
                  <Shield className="h-3.5 w-3.5" />
                  {t("admin.navLink")}
                </button>
              )}
              <button
                type="button"
                onClick={handleLogout}
                disabled={loggingOut}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-foreground transition hover:bg-muted/40 disabled:opacity-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                {t("auth.logout")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

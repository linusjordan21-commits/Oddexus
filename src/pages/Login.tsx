import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandHeader } from "@/components/BrandHeader";
import { useAuth } from "@/contexts/AuthContext";
import { useUserSettings } from "@/hooks/useUserSettings";

interface LocationState {
  from?: string;
}

export default function Login() {
  const { t } = useUserSettings();
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = location.state as LocationState | undefined;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Om redan inloggad: skicka direkt till destination.
  if (isAuthenticated) {
    const target = fromState?.from ?? "/";
    queueMicrotask(() => navigate(target, { replace: true }));
    return null;
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(username, password);
      if (result.ok) {
        navigate(fromState?.from ?? "/", { replace: true });
      } else {
        setError(result.error || t("auth.invalidCredentials"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
        <div className="mb-6 flex justify-center">
          <BrandHeader size="lg" />
        </div>
        <Card>
          <CardContent className="p-6">
            <h1 className="text-xl font-semibold">{t("auth.title")}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{t("auth.subtitle")}</p>
            <form onSubmit={handleSubmit} className="mt-6 space-y-4" autoComplete="off">
              <div className="space-y-1.5">
                <Label htmlFor="username">{t("auth.usernameLabel")}</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  required
                  placeholder={t("auth.usernamePlaceholder")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">{t("auth.passwordLabel")}</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder={t("auth.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              </div>
              {error && (
                <div className="rounded-md border border-red-300/40 bg-red-50/40 px-3 py-2 text-xs text-red-600 dark:bg-red-950/30">
                  {error}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={submitting || !username || !password}>
                {submitting ? t("auth.loggingIn") : t("auth.loginButton")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

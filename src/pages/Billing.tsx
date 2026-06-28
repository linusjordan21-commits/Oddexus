import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check } from "lucide-react";
import { BrandHeader } from "@/components/BrandHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useUserSettings } from "@/hooks/useUserSettings";

type PlanId = "free" | "basic" | "pro";

type Plan = {
  id: PlanId;
  name: string;
  valuebets: boolean;
  autoclicker: boolean;
  price: { currency: string; value: string; label: string };
};

type Me = {
  configured: boolean;
  plans: Plan[];
  subscription: {
    plan: PlanId;
    status: string;
    currentPeriodEnd: string | null;
    autoRenew: boolean;
    viaMollie: boolean;
  } | null;
};

function formatPrice(p: Plan["price"]): string {
  // "199.00" → "199" om hela tal, annars behåll decimaler.
  const n = Number(p.value);
  const num = Number.isInteger(n) ? String(n) : p.value;
  return `${num} ${p.currency}`;
}

export default function Billing() {
  const { t } = useUserSettings();
  const [params] = useSearchParams();
  const justReturned = params.get("status") === "klar";
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<PlanId | null>(null);

  const fetchMe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/me", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as Me;
      setMe(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  const checkout = async (plan: PlanId) => {
    setBusyPlan(plan);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; checkoutUrl?: string };
      if (!res.ok || !json.ok || !json.checkoutUrl) {
        setError(json.error ?? `HTTP ${res.status}`);
        setBusyPlan(null);
        return;
      }
      window.location.href = json.checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyPlan(null);
    }
  };

  const currentPlan = me?.subscription?.plan ?? "free";
  const activeUntil = me?.subscription?.currentPeriodEnd;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10 px-4 py-10">
      <div className="mx-auto max-w-4xl">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("billing.backHome")}
        </Link>
        <BrandHeader size="md" className="mb-4" />
        <h1 className="text-2xl font-bold">{t("billing.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("billing.subtitle")}</p>

        {justReturned && (
          <p className="mt-4 rounded-md border border-emerald-300/40 bg-emerald-50/40 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            {t("billing.returnNote")}
          </p>
        )}
        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
        {me && !me.configured && (
          <p className="mt-4 rounded-md border border-amber-400/40 bg-amber-50/40 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
            {t("billing.notConfigured")}
          </p>
        )}

        {me?.subscription && me.subscription.status !== "none" && (
          <Card className="mt-6">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div>
                <span className="text-muted-foreground">{t("billing.currentPlan")}: </span>
                <span className="font-semibold">
                  {me.plans.find((p) => p.id === currentPlan)?.name ?? currentPlan}
                </span>
              </div>
              {activeUntil && (
                <div className="text-muted-foreground">
                  {t("billing.activeUntil")} {activeUntil.slice(0, 10)}
                </div>
              )}
              {me.subscription.autoRenew && (
                <div className="text-xs text-emerald-700 dark:text-emerald-400">
                  {t("billing.autoRenewOn")}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {loading ? (
          <p className="mt-6 text-sm text-muted-foreground">…</p>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {(me?.plans ?? []).map((plan) => {
              const isCurrent = plan.id === currentPlan && me?.subscription?.status === "active";
              const isFree = plan.id === "free";
              return (
                <Card
                  key={plan.id}
                  className={isCurrent ? "border-emerald-400/60 shadow-md" : undefined}
                >
                  <CardContent className="flex h-full flex-col gap-4 p-5">
                    <div>
                      <h2 className="text-lg font-bold">{plan.name}</h2>
                      <p className="mt-1 text-2xl font-extrabold">
                        {isFree ? "0" : formatPrice(plan.price)}
                        {!isFree && (
                          <span className="text-sm font-normal text-muted-foreground">
                            {t("billing.perMonth")}
                          </span>
                        )}
                      </p>
                    </div>
                    <ul className="flex-1 space-y-1.5 text-sm">
                      {plan.valuebets && (
                        <li className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-emerald-600" />
                          {t("billing.includesValuebets")}
                        </li>
                      )}
                      {plan.autoclicker && (
                        <li className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-emerald-600" />
                          {t("billing.includesAutoclicker")}
                        </li>
                      )}
                      {!plan.valuebets && !plan.autoclicker && (
                        <li className="text-muted-foreground">{t("billing.includesNothing")}</li>
                      )}
                    </ul>
                    {isCurrent ? (
                      <Button type="button" variant="outline" disabled>
                        {t("billing.yourPlan")}
                      </Button>
                    ) : isFree ? (
                      <span />
                    ) : (
                      <Button
                        type="button"
                        disabled={busyPlan !== null || me?.configured === false}
                        onClick={() => void checkout(plan.id)}
                      >
                        {busyPlan === plan.id ? t("billing.processing") : t("billing.upgrade")}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

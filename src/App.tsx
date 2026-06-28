import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsProvider } from "@/lib/settings/SettingsContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute, AdminOnlyRoute, ValuebetsRoute, FeatureRoute } from "@/components/ProtectedRoute";
import { UserMenu } from "@/components/UserMenu";
import { SiteBackground } from "@/components/SiteBackground";

const Home = lazy(() => import("./pages/Home.tsx"));
const Index = lazy(() => import("./pages/Index.tsx"));
const BonusOptimizer = lazy(() => import("./pages/BonusOptimizer.tsx"));
const SmarketsExtraction = lazy(() => import("./pages/SmarketsExtraction.tsx"));
const StakeBetOnline = lazy(() => import("./pages/StakeBetOnline.tsx"));
const ValueBets = lazy(() => import("./pages/ValueBets.tsx"));
const OddsDrops = lazy(() => import("./pages/OddsDrops.tsx"));
const Settings = lazy(() => import("./pages/Settings.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
const Login = lazy(() => import("./pages/Login.tsx"));
const Admin = lazy(() => import("./pages/Admin.tsx"));
const Autoclicker = lazy(() => import("./pages/Autoclicker.tsx"));
const Athena = lazy(() => import("./pages/Athena.tsx"));
const Billing = lazy(() => import("./pages/Billing.tsx"));
const AdminAthena = lazy(() => import("./pages/AdminAthena.tsx"));
const AdminAutoclickerLicenses = lazy(() => import("./pages/AdminAutoclickerLicenses.tsx"));
const AdminUsers = lazy(() => import("./pages/AdminUsers.tsx"));
const UnderConstruction = lazy(() => import("./pages/UnderConstruction.tsx"));
const BonusFinder = lazy(() => import("./pages/BonusFinder.tsx"));

const queryClient = new QueryClient();

const routeFallback = (
  <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">Laddar…</div>
);

/** Inloggning krävs men ingen roll-check. Bra för Autoclicker + Under Construction. */
const protect = (element: JSX.Element) => <ProtectedRoute>{element}</ProtectedRoute>;

/**
 * Endast root-admin har åtkomst. Vanliga kunder skickas till /under-construction.
 * Används för alla sidor som inte är öppna för kunder ännu (matched betting,
 * valuebets, odds drops, bonus optimizer, stake-betonline, settings, admin).
 */
const adminOnly = (element: JSX.Element) => <AdminOnlyRoute>{element}</AdminOnlyRoute>;

/** Valuebets-sektionen: admin ELLER kund med valuebets-behörighet (/admin/users). */
const valuebetsAccess = (element: JSX.Element) => <ValuebetsRoute>{element}</ValuebetsRoute>;

/** Per-funktion-åtkomst: admin ELLER kund med respektive behörighet (/admin/users). */
const feature = (f: "bonusFinder" | "bonusOptimizer" | "athena", element: JSX.Element) => (
  <FeatureRoute feature={f}>{element}</FeatureRoute>
);

const App = () => (
  <SettingsProvider>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SiteBackground />
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
            <UserMenu />
            <Suspense fallback={routeFallback}>
              <Routes>
                {/* Publika / open routes */}
                <Route path="/login" element={<Login />} />

                {/* ÖPPNA FÖR KUNDER (kräver inloggning men ingen roll) */}
                <Route path="/autoclicker" element={protect(<Autoclicker />)} />
                <Route path="/athena" element={feature("athena", <Athena />)} />
                <Route path="/billing" element={protect(<Billing />)} />
                <Route path="/under-construction" element={protect(<UnderConstruction />)} />

                {/* / Home visas för ALLA inloggade — kunder ser hela menyn så plattformen
                  * känns större, men icke-autoclicker-länkarna har "Kommer snart"-badge
                  * och redirectas till /under-construction vid klick. */}
                <Route path="/" element={protect(<Home />)} />

                {/* ADMIN-ONLY — vanliga kunder redirectas till /under-construction */}
                <Route path="/welcome-bonus" element={adminOnly(<Index />)} />
                <Route path="/bonus-optimizer" element={feature("bonusOptimizer", <BonusOptimizer />)} />
                <Route path="/smarkets-extraction" element={adminOnly(<SmarketsExtraction />)} />
                <Route path="/stake-betonline" element={adminOnly(<StakeBetOnline />)} />
                <Route path="/valuebets" element={valuebetsAccess(<ValueBets />)} />
                <Route path="/odds-drops" element={adminOnly(<OddsDrops />)} />
                <Route path="/settings" element={adminOnly(<Settings />)} />
                <Route path="/admin" element={adminOnly(<Admin />)} />
                <Route path="/admin/users" element={adminOnly(<AdminUsers />)} />
                <Route path="/admin/autoclicker-licenses" element={adminOnly(<AdminAutoclickerLicenses />)} />
                <Route path="/admin/athena" element={adminOnly(<AdminAthena />)} />
                {/* Bonus Finder — admin-only. Canonical URL är /bonus-finder?bookmaker=<slug>.
                  * /bonus/:bookmaker behålls som backward compat (samma komponent läser useParams). */}
                <Route path="/bonus-finder" element={feature("bonusFinder", <BonusFinder />)} />
                <Route path="/bonus/:bookmaker" element={feature("bonusFinder", <BonusFinder />)} />

                {/* Catch-all: även här admin-only så vanliga customers inte ser 404 för sidor som inte finns. */}
                <Route path="*" element={adminOnly(<NotFound />)} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </SettingsProvider>
);

export default App;

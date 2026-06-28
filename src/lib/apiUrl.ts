/**
 * Bygg URL till Vites inbyggda `/api/*`-middleware så det fungerar med valfri Vite `base`
 * (t.ex. GitHub Pages under `/linusgan/`). Med `BASE_PATH=/` (Render) blir resultatet `/api/...`.
 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const raw = import.meta.env.BASE_URL ?? "/";
  const base = raw === "/" || raw === "" ? "" : raw.replace(/\/$/, "");
  return base ? `${base}${normalized}` : normalized;
}

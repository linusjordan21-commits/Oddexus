/**
 * Konstant, fast webbplats-bakgrund.
 *
 * Renderas EN gång högst upp i appen (utanför routern) så den aldrig laddas om
 * när man byter sida eller skrollar. Ligger fast bakom allt innehåll
 * (position: fixed) → bakgrunden står still medan innehållet skrollar.
 *
 * Responsiv via CSS (se .site-bg i index.css):
 *   • dator / liggande      → bred bild   (bg-wide.jpg)
 *   • surfplatta / halv skärm → fyrkantig  (bg-square.jpg)
 *   • mobil / stående        → avlång     (bg-tall.jpg)
 *
 * Bildfilerna läggs i public/branding/ (se README/instruktion).
 */
export function SiteBackground() {
  return <div className="site-bg" aria-hidden="true" />;
}

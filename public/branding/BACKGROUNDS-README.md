# Webbplats-bakgrund (fasta, responsiva bilder) — INSTALLERADE

| Fil | Används på | Form |
|-----|------------|------|
| `bg-wide.webp`   | Dator (liggande)                 | bred / landskap |
| `bg-square.webp` | Surfplatta / halv skärm på dator | fyrkantig / lätt stående |
| `bg-tall.webp`   | Mobil (stående)                  | avlång / hög |

Bilden ligger fast bakom allt och skrollar inte; den byts automatiskt efter
skärmens proportioner (media queries i `src/index.css`). Vill du byta bild:
ersätt filen med samma namn. Läsbarhets-slöjan justeras i `.site-bg::after`
(`rgba(0,0,0,0.40)`) i `src/index.css`.

/**
 * Vasket butikknavn til visning for en eier som kommer fra e-post (utsending v4).
 * Kutter ved første « — » eller første «, », og fjerner deretter en avsluttende
 * selskapsform (« AS», « SA», « DA», « ANS», « ENK»). Ren funksjon, ingen import.
 *
 * Samme regler ligger som en inline kopi i src/public/selger.html (nettleseren
 * kan ikke importere denne filen); testen rfb-selger-en-butikk.test.ts holder
 * de to like.
 */
export function washStoreName(raw: unknown): string {
  let name = String(raw ?? "").trim();
  const cuts = [name.indexOf(" — "), name.indexOf(", ")].filter((i) => i >= 0);
  if (cuts.length) name = name.slice(0, Math.min(...cuts));
  name = name.replace(/\s+(AS|SA|DA|ANS|ENK)$/i, "");
  return name.trim();
}

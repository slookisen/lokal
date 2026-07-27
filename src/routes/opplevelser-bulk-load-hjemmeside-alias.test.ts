/**
 * opplevelser-bulk-load-hjemmeside-alias.test.ts
 *
 * Regression proof for dev-request 2026-07-27-harvest-hjemmeside-feltnavn-tapes.
 *
 * The harvest SKILL (scheduled-agents/experiences-harvest.md) instructs its
 * agent to send a row field named `hjemmeside` — under the heading "Build rows
 * matching BulkRowSchema EXACTLY" — while BulkRowSchema only ever accepted
 * `website`. `z.object()` strips unknown keys silently, so every harvested
 * homepage was discarded at the door: HTTP 200, provider created, homepage
 * column NULL, no error anywhere.
 *
 * The consequence is not cosmetic, but it is NOT the one first claimed here.
 * An earlier version of this header said such a provider "could never be
 * content-enriched" — independent review showed that is not what the code does,
 * and the source comment in opplevelser.ts was corrected. Keeping the retracted
 * version alive in the regression-proof file would be worse than useless, so:
 *
 * selectProvidersForContentRefresh() (services/experience-store.ts) COALESCEs
 * the homepage with the provider's first non-empty experience `evidence_url`,
 * and its WHERE explicitly admits `hjemmeside IS NULL` rows that have one. So
 * affected providers WERE still picked up — and enrichment then fetched and
 * extracted from the EVIDENCE url, i.e. the DMO/listing page the provider was
 * discovered on, rather than the provider's own site. That is the same
 * aggregator-as-homepage failure dev-request 2026-07-19-agg-website-leak was
 * filed for, and it is why enrichment runs kept reporting `fetch_failed`
 * against visitnorway.com / visithelgeland.com URLs.
 *
 * These tests pin BOTH names as accepted, so the two sides cannot silently
 * drift apart again.
 */

import { BulkRowSchema, firstNonAggregatorWebsite, isAggregatorWebsite, type BulkRow } from "./opplevelser";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runBulkLoadHjemmesideAliasTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const base = { title: "Guidet fjelltur", provider_name: "TrollAktiv", evidence_url: "https://kilde.example/x" };

  // ── The exact row shape the harvest SKILL tells its agent to build ──────
  {
    const row = BulkRowSchema.parse({ ...base, hjemmeside: "https://trollaktiv.no" });
    assertEq(row.hjemmeside, "https://trollaktiv.no", "alias-1: a row sent with `hjemmeside` keeps it (was silently stripped)");
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-2: `hjemmeside` reaches the provider-CREATE homepage write",
    );
  }

  // ── The name the schema always accepted still works ────────────────────
  {
    const row = BulkRowSchema.parse({ ...base, website: "https://trollaktiv.no" });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), "https://trollaktiv.no", "alias-3: `website` still works (no regression)");
  }

  // ── Neither given → null, as before ────────────────────────────────────
  {
    const row = BulkRowSchema.parse({ ...base });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), null, "alias-4: a row with no homepage at all yields null, not a crash");
  }

  // ── `hjemmeside` wins when a row carries both ──────────────────────────
  // Round-6 review, BLOCKING: this used to assert `website` wins, while the
  // source comment simultaneously claimed `website` = the scraped listing and
  // `hjemmeside` = the producer's own site is the EXPECTED shape. Both cannot
  // be right. Under `website`-first, 7 of 12 real Norwegian regional tourism
  // hosts beat the real homepage in that shape, because they are not on any
  // aggregator list — and no such list can be complete.
  //
  // `hjemmeside` needs no list: the harvest SKILL defines it as the provider's
  // OWN official homepage, never a DMO page, and "if you cannot verify it with
  // certainty, LEAVE IT OPEN — NEVER guess". `website` carries no such
  // contract, and 2026-07-19-agg-website-leak documents aggregator URLs
  // genuinely arriving in it. Still deterministic — just the other way.
  {
    const row = BulkRowSchema.parse({ ...base, website: "https://kanonisk.no", hjemmeside: "https://annen.no" });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), "https://annen.no", "alias-5: `hjemmeside` wins when both are present — it is the field with the strict own-homepage contract");
  }
  // …and the unlisted-DMO case that motivated the swap.
  {
    for (const dmo of [
      "https://visitlofoten.com/no/aktiviteter/x",
      "https://hardangerfjord.com/no/x",
      "https://visitrogaland.com/x",
      "https://visitnordfjord.no/x",
      "https://visitvesteralen.com/x",
      "https://nasjonaleturistveger.no/x",
    ]) {
      const row = BulkRowSchema.parse({ ...base, website: dmo, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-5b/${dmo.slice(8, 30)}: an UNLISTED regional tourism listing in \`website\` never beats a real \`hjemmeside\``,
      );
      // The twin. These six hosts are deliberately NOT on any screen list —
      // that is the point of this block: precedence, not a list, is what
      // protects the mixed row, because no list can be complete. So alone they
      // ARE stored, exactly as origin/main stored them. Asserting that keeps the
      // block honest about what it is claiming, and would fail if someone
      // "fixed" it by quietly adding these to a screen.
      const dmoAlias = BulkRowSchema.parse({ ...base, hjemmeside: dmo });
      assertEq(
        firstNonAggregatorWebsite([dmoAlias as BulkRow]),
        dmo,
        `alias-5c/${dmo.slice(8, 30)}: …while ALONE it is still stored — precedence, not an ever-incomplete list, is what carries the mixed case`,
      );
    }
  }

  // ── Empty / whitespace `website` must NOT shadow a real `hjemmeside` ────
  // Independent review found both of these as blocking: `??` only falls
  // through on null/undefined, so `website: ""` yielded null, and a
  // whitespace-only `website` was written verbatim — worse than null, since
  // selectProvidersForContentRefresh() requires TRIM(hjemmeside) != '' for its
  // primary branch and hjemmeside IS NULL for its evidence_url fallback, so a
  // whitespace value satisfies neither and drops the provider entirely.
  {
    const row = BulkRowSchema.parse({ ...base, website: "", hjemmeside: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-8: an EMPTY-string `website` does not shadow a real `hjemmeside` (the `??`-vs-`||` bug)",
    );
  }
  {
    const row = BulkRowSchema.parse({ ...base, website: "   ", hjemmeside: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-9: a WHITESPACE-only `website` does not shadow a real `hjemmeside`, and is never written verbatim",
    );
  }
  {
    const row = BulkRowSchema.parse({ ...base, website: "  https://trollaktiv.no  " });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-10: a padded URL is trimmed before it reaches the stored homepage",
    );
  }
  {
    const row = BulkRowSchema.parse({ ...base, website: "", hjemmeside: "" });
    assertEq(firstNonAggregatorWebsite([row as BulkRow]), null, "alias-11: both blank yields null, never an empty string");
  }

  // ── An aggregator in ONE field must not discard a real value in the other ─
  // Round-2 review, blocking: the candidate used to be resolved before the
  // aggregator screen, so an aggregator `website` beat a real `hjemmeside` and
  // the row yielded null.
  {
    const row = BulkRowSchema.parse({
      ...base,
      website: "https://www.visitnorway.com/listings/the-well-spa/12614/",
      hjemmeside: "https://trollaktiv.no",
    });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-12: an aggregator `website` does not discard a real `hjemmeside` in the same row",
    );
  }
  {
    const row = BulkRowSchema.parse({
      ...base,
      website: "https://trollaktiv.no",
      hjemmeside: "https://www.visitnorway.com/listings/x/1/",
    });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      "https://trollaktiv.no",
      "alias-13: and the mirror case — a real `website` is not lost to an aggregator alias",
    );
  }

  // ── Placeholder junk must never be stored, nor shadow the other field ────
  // Round-2 review (non-blocking #5): "-" / "n/a" / "TBD" are truthy and
  // survive isAggregatorWebsite()'s permissive unparseable-URL path, so they
  // were written verbatim into the provider's homepage — worse than null.
  //
  // Round-3 review (BLOCKING): the first screen here was `v.includes(".")`,
  // and this list was the ONLY thing it was calibrated against — every junk
  // value that happens to contain a dot still got stored AND still shadowed a
  // real `hjemmeside`. The dotted cases below are the reviewer's own
  // reproduction set, verbatim; they are the reason the screen now looks at the
  // parsed HOST (≥2 non-empty labels, alphabetic/punycode TLD ≥2 chars) rather
  // than at the raw string. Do not thin this list — its whole point is that the
  // check must hold for junk nobody wrote a fixture for.
  {
    const junkValues = [
      // dot-less (what the round-2 screen already caught)
      "-", "n/a", "TBD", "null", "   -   ", "ukjent", "localhost",
      // dotted — every one of these passed the round-2 screen and was stored
      "n.a", "n.a.", "N/A.", "tbd.", "..", ".", "-.-", "www.",
      // bare IP literals: a real host, never a producer's homepage
      "1.2.3.4", "0.0.0.0", "192.168.1.1",
      // single-char TLD / label — syntactically dotted, not a real domain
      "a.b",
      // an email address is not a homepage, even though its host parses fine
      "post@gard.no",
      // prose: whitespace-bearing, and the last one even contains a real host
      "Se nettsiden deres.", "ingen hjemmeside, kun facebook.com",
      // a dot-less HOST whose PATH carries the dot — the raw-string check's
      // blind spot in the other direction
      "http://gardsbutikken/index.html",
    ];
    for (const junk of junkValues) {
      const row = BulkRowSchema.parse({ ...base, website: junk, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-14/${junk.trim()}: placeholder \`${junk}\` neither stored nor allowed to shadow a real homepage`,
      );
      const alone = BulkRowSchema.parse({ ...base, website: junk });
      assertEq(
        firstNonAggregatorWebsite([alone as BulkRow]),
        null,
        `alias-15/${junk.trim()}: placeholder \`${junk}\` alone yields null, never a stored junk homepage`,
      );
    }
  }

  // ── Round-4 review: the FOURTH instance, from two separate causes ────────
  // (a) Placeholder-sentinel DOMAINS. These parse perfectly — two labels, real
  // TLD — so the round-3 host-shape check waved them through, and they still
  // discarded the row's real hjemmeside. example.com is the one that matters:
  // RFC-2606 reserved, and the single most likely thing an LLM harvester emits
  // for a URL field it does not know. The repo already exported the list
  // (PLACEHOLDER_EMAIL_DOMAINS); the round-3 check simply did not consult it.
  {
    const sentinels = [
      "https://example.com", "example.org", "example.net", "domain.com",
      "yourdomain.com", "yourcompany.com", "website.com", "test.com",
      "company.com", "email.com", "www.example.com", "https://example.com/om-oss",
    ];
    for (const v of sentinels) {
      const row = BulkRowSchema.parse({ ...base, website: v, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-17/${v}: placeholder domain \`${v}\` never shadows a real homepage`,
      );
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: v });
      assertEq(
        firstNonAggregatorWebsite([solo as BulkRow]),
        null,
        `alias-17b/${v}: …and is rejected on its own merits, not merely out-ranked`,
      );
    }
  }

  // (b) Parser disagreement. isAggregatorWebsite() used `new URL()` while the
  // shape screen used hostFromUrlLike(). `new URL("http://visitnorway.com:99999")`
  // THROWS (port > 65535) and the catch returned "not an aggregator", while
  // hostFromUrlLike happily returned `visitnorway.com` and passed the shape
  // screen — so a KNOWN aggregator was stored AND the real hjemmeside dropped.
  // Both functions now use the one parser. Pinned for both aggregator hosts and
  // several malformed-authority shapes, because the class is the point, not the
  // individual strings.
  {
    const smuggled = [
      "http://visitnorway.com:99999/",
      "https://visitnorway.com:80443/x",
      "visitnorway.com:abc",
      "visitnorway.com:-1",
      "http://visitnorway.com:1234567",
      "http://visithelgeland.com:99999/en/product/abc",
    ];
    for (const v of smuggled) {
      const row = BulkRowSchema.parse({ ...base, website: v, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-18/${v}: a malformed authority must not smuggle a known aggregator past the screen`,
      );
      const alone = BulkRowSchema.parse({ ...base, website: v });
      assertEq(
        firstNonAggregatorWebsite([alone as BulkRow]),
        null,
        `alias-18b/${v}: …nor be stored when it is the only candidate`,
      );
    }
  }

  // (c) Degenerate DNS labels. RFC-invalid leading/trailing hyphens and
  // over-63-char labels are not hostnames; only the TLD label was being checked.
  {
    for (const v of ["-gard.no", "gard-.no", "a".repeat(64) + ".no"]) {
      const row = BulkRowSchema.parse({ ...base, website: v, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-19/${v.slice(0, 12)}: an RFC-invalid label does not shadow a real homepage`,
      );
      const solo19 = BulkRowSchema.parse({ ...base, hjemmeside: v });
      assertEq(
        firstNonAggregatorWebsite([solo19 as BulkRow]),
        null,
        `alias-19b/${v.slice(0, 12)}: …and is rejected on its own merits — this is what pins the per-label DNS shape check`,
      );
    }
  }

  // ── Round-5 review: the tiering was itself a shadowing engine ───────────
  // The round-4 design preferred a candidate whose TLD was on a KNOWN_TLDS
  // allowlist. Its safety claim was "an omission costs a preference, never a
  // homepage" — false: an omission cost a homepage, because TLD RECOGNITION
  // and junk DETECTION are uncorrelated. These are the reviewer's executed
  // counter-examples, and they are the direction the round-4 fixtures never
  // tested: the UNLISTED-TLD candidate is the REAL one and the recognized-TLD
  // candidate is the junk.
  {
    const realVsJunk: Array<[string, string]> = [
      ["storgarden.nu", "ikke-oppgitt.no"],       // .nu is a mainstream Nordic ccTLD
      ["storgarden.tech", "hjemmeside.com"],
      ["storgarden.blog", "nettside.no"],
      ["storgarden.one", "ukjent.no"],
      ["storgarden.coop", "eksempel.no"],
    ];
    for (const [real, junk] of realVsJunk) {
      const row = BulkRowSchema.parse({ ...base, website: real, hjemmeside: junk });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        real,
        `alias-23/${real}: a real producer on an uncommon TLD beats \`${junk}\` — a TLD allowlist ranked these backwards`,
      );
      const rowSwapped = BulkRowSchema.parse({ ...base, website: junk, hjemmeside: real });
      assertEq(
        firstNonAggregatorWebsite([rowSwapped as BulkRow]),
        real,
        `alias-23b/${real}: …and in the other field order too`,
      );
      const junkAlone = BulkRowSchema.parse({ ...base, website: junk });
      assertEq(
        firstNonAggregatorWebsite([junkAlone as BulkRow]),
        null,
        `alias-23c/${junk}: \`${junk}\` is junk on its own merits, whatever its TLD`,
      );
      const realAlone = BulkRowSchema.parse({ ...base, website: real });
      assertEq(
        firstNonAggregatorWebsite([realAlone as BulkRow]),
        real,
        `alias-23d/${real}: …and an uncommon TLD is never a reason to reject`,
      );
    }
    // Row order must be preserved — the tiering inverted it.
    const r1 = BulkRowSchema.parse({ ...base, website: "storgarden.tech" });
    const r2 = BulkRowSchema.parse({ ...base, title: "Rafting", website: "nettside.no" });
    assertEq(
      firstNonAggregatorWebsite([r1 as BulkRow, r2 as BulkRow]),
      "storgarden.tech",
      "alias-24: the first row's candidate still wins — the tier logic let a later row beat an earlier one",
    );
  }

  // ── Round-5 review: the six DMO hosts the harvest SKILL names as SOURCES ─
  // `website` = the listing page the agent scraped, `hjemmeside` = the
  // producer's own site is the EXPECTED row shape here, not a crafted one.
  // Before this PR the alias was stripped so a DMO `website` had nothing to
  // shadow; accepting the alias turned a documented gap into active loss.
  // Screened LOCALLY rather than via KNOWN_DIRECTORY_HOSTS, which also gates
  // the verifier's domain-coherence bypass — a blast radius with no evidence.
  {
    const dmoSources = [
      "https://www.visitbergen.com/things-to-do/x-p123",
      "https://nordnorge.com/aktivitet/x",
      "https://visittromso.no/x",
      "https://visitoslo.com/x",
      "https://visittrondheim.no/x",
      "https://fjordtours.com/x",
    ];
    for (const src of dmoSources) {
      const row = BulkRowSchema.parse({ ...base, website: src, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-25/${src.slice(8, 30)}: a harvest SOURCE listing never becomes the provider's homepage`,
      );
      // The twin that actually pins isHarvestSourceHost — without it the whole
      // round-5 blocking fix could be deleted with the full suite green.
      const soloSrc = BulkRowSchema.parse({ ...base, hjemmeside: src });
      assertEq(
        firstNonAggregatorWebsite([soloSrc as BulkRow]),
        null,
        `alias-25b/${src.slice(8, 30)}: …and is rejected alone, which is what pins the harvest-source screen at all`,
      );
    }
  }

  // ── Harvest-source SUBDOMAINS — round-7 review, M1 ──────────────────────
  // isHarvestSourceHost compares the REGISTRABLE domain, but every fixture used
  // apex or `www.` hosts, which reduce identically — so the reduction itself was
  // unfalsifiable.
  {
    for (const sub of [
      "https://booking.fjordtours.com/tour/1",
      "https://en.visitbergen.com/x",
      "https://www2.visittromso.no/x",
    ]) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: sub });
      assertEq(
        firstNonAggregatorWebsite([solo as BulkRow]),
        null,
        `alias-27/${sub.slice(8, 34)}: a SUBDOMAIN of a harvest source is screened too — this is what pins the registrable-domain reduction`,
      );
    }
  }

  // ── Hyphenated placeholder compounds — round-7 review, BLOCKING ─────────
  // The separator collapse only caught `ikke-oppgitt` because "ikkeoppgitt" was
  // hard-coded, and that is the one compound with a test. The other two named
  // in the source comment sailed through and, after the precedence flip, beat a
  // real `website` — a regression vs origin/main in this PR's own defect class.
  //
  // NOTE (finding 4, dev-request 2026-07-27-384-placeholder-regel-etterslep):
  // this block is HYPHEN compounds — the round-7 word-split fix. The two
  // UNDERSCORE values below were moved out into their own block beneath it:
  // they do not actually pin the same code path (see that block's comment).
  {
    for (const junk of [
      "ingen-hjemmeside.no", "kommer-snart.no", "under-arbeid.no", "ikke-oppgitt.no",
    ]) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: junk });
      assertEq(firstNonAggregatorWebsite([solo as BulkRow]), null,
        `alias-28/${junk}: a hyphenated placeholder compound is rejected however it is spelled`);
      const mixed = BulkRowSchema.parse({ ...base, hjemmeside: junk, website: "https://trollaktiv.no" });
      assertEq(firstNonAggregatorWebsite([mixed as BulkRow]), "https://trollaktiv.no",
        `alias-28b/${junk}: …and never beats a real \`website\``);
    }
    // The other half: hyphenated REAL domains must survive the word split.
    for (const good of ["lia-gard.no", "mat-og-drikke.no", "snartemo.no", "arbeidsgarden.no"]) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: good });
      assertEq(firstNonAggregatorWebsite([solo as BulkRow]), good,
        `alias-29/${good}: a hyphenated REAL domain is untouched — the word rule must not become a new false rejection`);
    }
  }

  // ── Underscore compounds — comment corrected (finding 4) ────────────────
  // These two used to sit in the round-7 hyphen block above and were described
  // as pinning the SAME word-split fix. They do not: isPlaceholderHomepageHost
  // is called BEFORE looksLikeHomepageValue's own per-label DNS-shape regex
  // (`/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/`), which has no `_` in its
  // character class and independently rejects ANY label containing one. Proven
  // by mutation: removing `_` support from isPlaceholderLabel's collapse AND
  // split (leaving only `-`) does not turn these red — the DNS-shape regex
  // catches them regardless. Only removing `_` from BOTH isPlaceholderLabel
  // AND the DNS-shape regex turns them red, which is what actually pins them:
  // the DNS-shape regex, not this word-split. Kept here as a (redundant but
  // harmless) belt-and-suspenders check on the observable behavior — the
  // accurate claim is in the source comment on isPlaceholderLabel.
  {
    for (const junk of ["ikke_oppgitt.no", "ingen_nettside.no"]) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: junk });
      assertEq(firstNonAggregatorWebsite([solo as BulkRow]), null,
        `alias-28c/${junk}: rejected — by the DNS-shape regex's blanket underscore ban, not by the word-split`);
      const mixed = BulkRowSchema.parse({ ...base, hjemmeside: junk, website: "https://trollaktiv.no" });
      assertEq(firstNonAggregatorWebsite([mixed as BulkRow]), "https://trollaktiv.no",
        `alias-28d/${junk}: …and never beats a real \`website\``);
    }
  }

  // ── Finding 2 (dev-request 2026-07-27-384-placeholder-regel-etterslep) ──
  // Mutation sweep (delete one word from PLACEHOLDER_DOMAIN_LABELS at a time,
  // run this file, restore) showed 20 of the 28 words individually deletable
  // with the suite green: they were only ever reached through OTHER,
  // independent screens — PLACEHOLDER_EMAIL_DOMAINS (a separate list, checked
  // first, for the `.com` sentinels), the dot-less/no-TLD junk screen (for the
  // bare English words used as raw junk strings, e.g. "null", "TBD"), or as the
  // non-last word of a hyphenated compound whose LAST word already carries the
  // assertion. None of that means the word is wrong to list — round 5's
  // rationale for each still holds — it means no fixture ever exercised THIS
  // list for that specific word. One minimal standalone domain per word closes
  // that gap. (The other 8 — ukjent, snart, hjemmeside, nettside, eksempel,
  // arbeid, yourdomain, yourcompany — already had a discriminating fixture
  // elsewhere in this file before this finding was filed.)
  {
    const soloWords = [
      "ikke", "ikkeoppgitt", "oppgitt", "ingen", "mangler", "kommer",
      "nettsted", "tilgjengelig", "finnesikke",
      "example", "unknown", "none", "null", "undefined", "placeholder", "tbd",
      "insert", "dummy", "todo", "notfound",
    ];
    for (const w of soloWords) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: `${w}.no` });
      assertEq(firstNonAggregatorWebsite([solo as BulkRow]), null,
        `alias-33/${w}: PLACEHOLDER_DOMAIN_LABELS entry "${w}" is individually falsifiable — deleting it from the set flips this red`);
    }
  }

  // ── Finding 1 (dev-request 2026-07-27-384-placeholder-regel-etterslep) ──
  // The round-7 word-split rejected a label if ANY hyphen/underscore-split word
  // matched, at any position — hard-rejecting real-looking registered domains
  // whose FIRST component is a status word used as a modifier. Narrowed to the
  // LAST split word only (see the comment on isPlaceholderLabel for why LAST,
  // not FIRST or "whole label only"). Measured: 0 of 335 real producer hosts
  // affected either way, but a false reject has the same shape as #384's bug.
  {
    for (const good of ["arbeid-helse.no", "hjemmeside-design.no", "null-utslipp.no", "todo-as.no"]) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: good });
      assertEq(firstNonAggregatorWebsite([solo as BulkRow]), good,
        `alias-30/${good}: a real-looking domain whose FIRST hyphen component is a status word (used as a modifier) is now accepted — only the LAST component is checked`);
    }
    // The narrowing must not cost any of the six known compounds: the status
    // word sits LAST in every one of them, which "last word" still catches.
    for (const junk of ["ingen-hjemmeside.no", "kommer-snart.no", "under-arbeid.no", "ikke-oppgitt.no", "ikke_oppgitt.no", "ingen_nettside.no"]) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: junk });
      assertEq(firstNonAggregatorWebsite([solo as BulkRow]), null,
        `alias-30b/${junk}: still rejected under "last word only" — the status word is the LAST component here too`);
    }
  }

  // ── Finding 3 (dev-request 2026-07-27-384-placeholder-regel-etterslep) ──
  // authorityOf()'s `^//` strip was unpinned: the existing alias-26 fixture for
  // the protocol-relative userinfo-swap class uses `visitbergen.com`, which is
  // independently on both KNOWN_DIRECTORY_HOSTS and HARVEST_SOURCE_HOSTS — so
  // the assertion (null) is satisfied by isAggregatorWebsite()/
  // isHarvestSourceHost() whether or not the `^//` strip works at all. Verified
  // by mutation: removing the strip leaves alias-26's `visitbergen.com` case
  // green (still null, via the OTHER screen) but flips THIS fixture red (the
  // candidate gets stored verbatim) because neither host here is on any
  // aggregator/harvest-source/placeholder list — the `^//` strip is the ONLY
  // thing rejecting it.
  {
    const row = BulkRowSchema.parse({ ...base, hjemmeside: "//annenurl.no@gardsbruket.no" });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      null,
      "alias-31: a protocol-relative userinfo swap is rejected by authorityOf's `^//` strip alone — neither host is on any other screen list",
    );
  }

  // ── Finding 5 (dev-request 2026-07-27-384-placeholder-regel-etterslep) ──
  // Two branches inside isPlaceholderHomepageHost/looksLikeHomepageValue had no
  // falsifying fixture: (a) the label-COLLAPSE branch
  // (`label.replace(/[-_]/g, "")` producing a match) and (b) the punycode-TLD
  // acceptance path (`/^xn--[a-z0-9-]{2,}$/.test(tld)`). Both verified by
  // mutation: commenting out either branch flips exactly these assertions red
  // (and nothing else in the suite), then restoring both flips them back green.
  {
    // (a) collapse branch. "domain"/"company" are deliberately NOT in
    // PLACEHOLDER_DOMAIN_LABELS (only the collapsed "yourdomain"/"yourcompany"
    // are) — so the LAST-word split check (which "your-domain"/"your-company"
    // would otherwise hit) cannot reject these; only the collapse check can.
    for (const junk of ["your-domain.no", "your-company.no"]) {
      const solo = BulkRowSchema.parse({ ...base, hjemmeside: junk });
      assertEq(firstNonAggregatorWebsite([solo as BulkRow]), null,
        `alias-32a/${junk}: rejected via the label-COLLAPSE branch only — neither split word is separately listed`);
    }
    // (b) punycode-TLD branch. A synthetic but shape-valid punycode TLD; no
    // other branch admits a non-alphabetic TLD.
    const punycode = BulkRowSchema.parse({ ...base, hjemmeside: "storgarden.xn--abc12" });
    assertEq(firstNonAggregatorWebsite([punycode as BulkRow]), "storgarden.xn--abc12",
      "alias-32b: a punycode TLD (xn--…) is accepted via its own dedicated branch, not the alphabetic-TLD check");
  }

  // ── Round-5 review: the parsers, once more ──────────────────────────────
  // (a) protocol-relative userinfo swap — authorityOf saw no `@` where
  // hostFromUrlLike read the host as the aggregator. The R4 divergence class,
  // one layer down, between the NEW pair of parsers.
  // (b) new URL() percent-decodes the host and treats `\` as a path separator;
  // hostFromUrlLike does neither. Round 4 dropped new URL() entirely and lost
  // both catches, so both parsers are used now, new URL() first.
  {
    const swaps = [
      "//gard.no@visitbergen.com",
      "https://gard.no@visitnorway.com",
      "http://visitnorway%2Ecom/",
      "http://visitnorway.com\\evil",
    ];
    for (const v of swaps) {
      const row = BulkRowSchema.parse({ ...base, website: v, hjemmeside: "https://trollaktiv.no" });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        "https://trollaktiv.no",
        `alias-26/${v}: neither parser may be talked into calling an aggregator a homepage`,
      );
      const solo26 = BulkRowSchema.parse({ ...base, hjemmeside: v });
      assertEq(
        firstNonAggregatorWebsite([solo26 as BulkRow]),
        null,
        `alias-26b/${v}: …and alone, so the assertion measures the screen and not field precedence`,
      );
    }
  }

  // ── An unrecognized TLD is stored, full stop ────────────────────────────
  // No tiering, no fallback slot: first passing candidate wins, exactly as
  // round 3 behaved. That version never lost a homepage.
  {
    for (const v of ["https://gard.travel", "gard.gardsbutikk", "gard.bogus", "gard.qqq"]) {
      const alone = BulkRowSchema.parse({ ...base, website: v });
      assertEq(
        firstNonAggregatorWebsite([alone as BulkRow]),
        v,
        `alias-20/${v}: an unrecognized TLD is stored — it is not evidence of junk`,
      );
    }
    const known = BulkRowSchema.parse({ ...base, website: "https://gard.travel", hjemmeside: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([known as BulkRow]),
      "https://trollaktiv.no",
      "alias-21: precedence is by FIELD, never by TLD — an uncommon TLD neither wins nor loses on that account",
    );
    const oddRow = BulkRowSchema.parse({ ...base, website: "gard.bogus" });
    const realRow = BulkRowSchema.parse({ ...base, title: "Rafting", website: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([oddRow as BulkRow, realRow as BulkRow]),
      "gard.bogus",
      "alias-22: …and by ROW order, so an earlier row is never demoted for its TLD",
    );
  }

  // ── …and the tightening must not cost a single legitimate homepage ──────
  // The other half of the round-3 fix: a shape check that rejects real
  // producer URLs would silently reintroduce the very loss this PR exists to
  // stop, just with a different cause. Every accepted form is pinned, including
  // the ones that motivated parsing the host instead of the string.
  {
    const legit = [
      "trollaktiv.no",
      "https://trollaktiv.no",
      "http://trollaktiv.no",
      "https://www.trollaktiv.no",
      "trollaktiv.no.",                    // trailing FQDN root dot
      "TROLLAKTIV.NO",                     // uppercase
      "gård.no",                           // IDN, unicode form
      "xn--grd-ula.no",                    // …and its ACTUAL punycode form (a comment here once said xn--grd-loa.no; new URL("http://gård.no").hostname disagrees, and the assertion passed anyway because the value is returned verbatim — so the round-trip it claimed to pin was never pinned)
      "trollaktiv.no/gardsbutikk",         // deep link
      "https://trollaktiv.no/a/b?c=d#e",   // path + query + fragment
      "https://trollaktiv.no:8443/",       // explicit port
      "sjokoladefabrikken.co.uk",          // multi-label suffix
      // Round-6 review: ordinary Norwegian hosting subdomains that happen to
      // use a word from the placeholder list. Screening EVERY label rejected
      // all of these; origin/main stored them. The junk always sits at the
      // registrable-domain level, so only those labels are screened now.
      "hjemmeside.storgarden.no",
      "nettside.storgarden.no",
      "nettsted.storgarden.no",
      "kommer.storgarden.no",
      "arbeid.storgarden.no",
      "ingen.storgarden.no",
      "www.hjemmeside.storgarden.no",
      // Round-4 review, blocking: `@` is legal in a path/query/fragment, and a
      // blanket rejection dropped all three of these to null — values
      // origin/main stored. Only the AUTHORITY is screened for `@` now.
      "https://trollaktiv.no/kontakt?epost=post@trollaktiv.no",
      "https://trollaktiv.no/@gardsbutikk",
      "https://trollaktiv.no/side#a@b",
    ];
    for (const v of legit) {
      const row = BulkRowSchema.parse({ ...base, website: v });
      assertEq(
        firstNonAggregatorWebsite([row as BulkRow]),
        v,
        `alias-16/${v}: legitimate homepage \`${v}\` is accepted, and stored VERBATIM (not host-normalized)`,
      );
    }
  }

  // ── The aggregator screen still applies to the alias ────────────────────
  // dev-request 2026-07-19-agg-website-leak: a DMO/aggregator page written
  // into a provider's homepage makes every later content-refresh fail. The
  // alias must not become a bypass around that screen.
  {
    const row = BulkRowSchema.parse({ ...base, hjemmeside: "https://www.visitnorway.com/listings/the-well-spa/12614/" });
    assertEq(
      firstNonAggregatorWebsite([row as BulkRow]),
      null,
      "alias-6: an aggregator URL sent as `hjemmeside` is rejected exactly like one sent as `website`",
    );

    // Round-3 review (finding 4): this file's header and the source comment
    // both cite "visitnorway.com / visithelgeland.com" as the leak being
    // guarded against — but only visitnorway.com was ever in
    // KNOWN_DIRECTORY_HOSTS, so the second host in our own motivating example
    // passed the screen and got stored. It is on the list as of this PR
    // (cross-source-validator.ts), on the strength of the five fetch_failed
    // visithelgeland.com homepages in the 2026-07-25 enrichment run. Pinned in
    // both fields so the claim and the code cannot drift apart again.
    for (const field of ["website", "hjemmeside"] as const) {
      const helgeland = BulkRowSchema.parse({
        ...base,
        [field]: "https://visithelgeland.com/en/product/guided-kayak-tour-in-heroy/",
      });
      assertEq(
        firstNonAggregatorWebsite([helgeland as BulkRow]),
        null,
        `alias-6b/${field}: visithelgeland.com — the OTHER host this PR names — is screened too`,
      );
    }
  }

  // ── Order-independence across rows, via the alias ──────────────────────
  {
    const aggRow = BulkRowSchema.parse({ ...base, hjemmeside: "https://www.visitnorway.com/x" });
    const realRow = BulkRowSchema.parse({ ...base, title: "Rafting", hjemmeside: "https://trollaktiv.no" });
    assertEq(
      firstNonAggregatorWebsite([aggRow as BulkRow, realRow as BulkRow]),
      "https://trollaktiv.no",
      "alias-7: an earlier aggregator row does not shadow a later real homepage",
    );
  }

  // ── isAggregatorWebsite, tested DIRECTLY (round-6 review) ───────────────
  // It is the sole classifier for POST /admin/hjemmeside-cleanup-sweep, which
  // runs `SET listing_url = ?, hjemmeside = NULL` — irreversible. Every previous
  // assertion reached it through firstNonAggregatorWebsite, where
  // looksLikeHomepageValue rejects these inputs first, so the parser preference
  // was unfalsifiable: reverting it left the whole 10706-test suite green.
  {
    // `new URL()` percent-decodes the host and treats `\` as a path separator;
    // hostFromUrlLike does neither. Preferring new URL() and falling back only
    // when it throws is what keeps these recognized.
    for (const v of ["http://visitnorway%2Ecom/", "http://visitnorway.com\\evil", "https://visitnorway.com"]) {
      assertEq(isAggregatorWebsite(v), true, `agg-1/${v}: recognized as an aggregator by the sweep's classifier`);
    }
    // …and hostFromUrlLike is what catches an authority new URL() cannot parse.
    for (const v of ["http://visitnorway.com:99999/", "visitnorway.com:abc"]) {
      assertEq(isAggregatorWebsite(v), true, `agg-2/${v}: an unparseable authority still resolves to the aggregator host`);
    }
    // The false positive the round-4 single-parser version introduced: this
    // host IS gard.no, so the sweep must NOT null its homepage.
    assertEq(isAggregatorWebsite("http://gard.no\\@visitnorway.com"), false, "agg-3: a value whose real host is the producer's own is NOT swept");
    assertEq(isAggregatorWebsite("https://trollaktiv.no"), false, "agg-4: a plain producer homepage is not an aggregator");
    // The six harvest-SOURCE hosts must stay OUT of this classifier: putting
    // them in silently rewired the sweep to null 9 of 10 seeded providers'
    // homepages instead of 1 (round-6 review, BLOCKING).
    for (const v of ["https://fjordtours.com/", "https://nordnorge.com/", "https://www.visitbergen.com/",
                     "https://visittromso.no/", "https://visitoslo.com/", "https://visittrondheim.no/",
                     "https://booking.fjordtours.com/tour/1"]) {
      assertEq(isAggregatorWebsite(v), false, `agg-5/${v}: a harvest SOURCE host is screened at CREATE only — never by the destructive sweep`);
    }
  }

  // ── The guards that nothing could falsify, now pinned ────────────────────
  {
    // isPlausibleUrlish's length bound: the host is fine, the value is not.
    const huge = BulkRowSchema.parse({ ...base, website: "https://gard.no/" + "a".repeat(3000) });
    assertEq(firstNonAggregatorWebsite([huge as BulkRow]), null, "guard-1: a 3000-char value is rejected on length, even with a perfectly good host");
    // PLACEHOLDER_EMAIL_DOMAINS via the registrable domain — `domain` is not in
    // PLACEHOLDER_DOMAIN_LABELS, so only that check can reject these.
    // ALONE, and in `hjemmeside` — not paired with a good sibling. Paired, the
    // assertion is satisfied by field precedence alone and cannot see whether
    // the sentinel was screened at all: my first version of this block put the
    // sentinel in `website` next to a real `hjemmeside`, and since `hjemmeside`
    // is now evaluated first the guard's removal left it green. Caught by
    // re-running the mutation, not by reading the test. Note `domain` and
    // `test` are NOT in PLACEHOLDER_DOMAIN_LABELS, so only the
    // PLACEHOLDER_EMAIL_DOMAINS check can reject these.
    for (const v of ["domain.com", "shop.domain.com", "www.test.com", "email.com", "company.com"]) {
      const alone = BulkRowSchema.parse({ ...base, hjemmeside: v });
      assertEq(firstNonAggregatorWebsite([alone as BulkRow]), null,
        `guard-2/${v}: a sentinel domain is rejected via its REGISTRABLE domain, subdomain or not`);
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/opplevelser-bulk-load-hjemmeside-alias.test.ts`
if (require.main === module) {
  console.log("── bulk-load hjemmeside alias ──");
  const r = runBulkLoadHjemmesideAliasTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Testmiljø: the /testmiljo pages.
 *
 *   GET  /testmiljo                 start page: log in as an owner, links, outbound calls
 *   POST /testmiljo/logg-inn        issue a login link for the chosen owner and follow it
 *   GET  /testmiljo/epost           the outbox: e-mail the app would have sent
 *   GET  /testmiljo/epost/:id       one e-mail
 *   POST /testmiljo/epost/tom       empty the outbox
 *
 * Logging in does not write a session itself. It calls the same exported
 * helpers the app uses to mail a login link (createOwnerLoginLink for Rett fra
 * Bonden, issueSelfRegisteredOwnerLoginLink for gårdssalg on Opplevagent) and
 * redirects to the ordinary verify route, so the session, the cookie and
 * everything after it are the real thing. Only owners that already exist in
 * the database are offered: a verified claim on RFB, a used and unrevoked
 * claim on gårdssalg.
 *
 * The pages live under the app's one content-security policy (security.ts);
 * nothing here overrides it. Two consequences shape the pages:
 *   - form-action 'self': you log in to a site from that site's own local
 *     name, so the form and the redirect after it stay on one origin. The
 *     other site is one link away.
 *   - an e-mail's HTML is shown in a sandboxed srcdoc frame: no script runs
 *     in it, whatever the captured e-mail contains.
 *
 * Independent conditions that must all hold for any of this to answer:
 *   1. mountTestmiljo() only mounts the router when isTestmiljo() is true at boot
 *      (and the process refuses to start with TESTMILJO set in production);
 *   2. every request re-checks isTestmiljo();
 *   3. every request must come from this machine (loopback TCP peer);
 *   4. the Host header must be localhost or one of the three local site names;
 *   5. the request must not carry a proxy's forwarding header (a tunnel that
 *      publishes the port would add one; the list is in middleware/client-ip.ts);
 *   6. a POST must pass the app's own same-origin write guard
 *      (middleware/same-origin-write.ts): not marked cross-site or same-site
 *      by the browser, and a named Origin must be this host.
 */

import express, { type Express, type NextFunction, type Request, type Response, Router } from "express";
import { isLoopbackAddress, isTestmiljo } from "./guard";
import { CLIENT_FORWARDED_HOST_MARK, LOCAL_SITES, isLocalHostName, localOrigin, siteByKey, splitHostPort, type LocalSite } from "./hosts";
import { clearOutbox, getOutboxMail, listOutbox, outboxFile, type OutboxMail } from "./outbox";
import { outboundAttempts } from "./outbound-guard";

export interface TestOwner {
  id: string;
  name: string;
  email: string;
  /** Shown under the name: the slug on gårdssalg. */
  detail?: string;
}

export interface TestmiljoDeps {
  rfbOwners(): TestOwner[];
  gardssalgOwners(): TestOwner[];
  /** Returns the one-time token of a fresh RFB login link. */
  issueRfbLogin(agentId: string, email: string): string;
  /** Returns the one-time token of a fresh gårdssalg login link, or null when it could not be issued. */
  issueGardssalgLogin(providerId: string, email: string): string | null;
}

/**
 * The real thing. App modules are required lazily, here and in the guard
 * below: src/index.ts imports this file near the top, and an eager import
 * would evaluate database and middleware modules ahead of their usual place in
 * production's boot order. (Pinned by testmiljo.test.ts s3.)
 */
export function defaultTestmiljoDeps(): TestmiljoDeps {
  return {
    rfbOwners() {
      const { getDb } = require("../database/init") as typeof import("../database/init");
      return getDb()
        .prepare(
          `SELECT a.id AS id, a.name AS name,
                  (SELECT c2.claimant_email FROM agent_claims c2
                    WHERE c2.agent_id = a.id AND c2.status = 'verified'
                    ORDER BY c2.verified_at DESC, c2.created_at DESC LIMIT 1) AS email
             FROM agents a
            WHERE EXISTS (SELECT 1 FROM agent_claims c WHERE c.agent_id = a.id AND c.status = 'verified')
            ORDER BY a.name COLLATE NOCASE`,
        )
        .all() as TestOwner[];
    },
    gardssalgOwners() {
      const { getDb } = require("../database/db-factory") as typeof import("../database/db-factory");
      const live = `c.provider_id = p.id AND c.used = 1 AND c.revoked_at IS NULL AND COALESCE(c.draft_mode, 0) = 0`;
      return getDb("experiences")
        .prepare(
          `SELECT p.id AS id, p.navn AS name, p.slug AS detail,
                  (SELECT c.email FROM gardssalg_claims c WHERE ${live} ORDER BY c.created_at DESC LIMIT 1) AS email
             FROM experience_providers p
            WHERE EXISTS (SELECT 1 FROM gardssalg_claims c WHERE ${live})
            ORDER BY p.navn COLLATE NOCASE`,
        )
        .all() as TestOwner[];
    },
    issueRfbLogin(agentId, email) {
      const { createOwnerLoginLink } = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
      return createOwnerLoginLink(agentId, email, "request").token;
    },
    issueGardssalgLogin(providerId, email) {
      const { issueSelfRegisteredOwnerLoginLink } = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      return issueSelfRegisteredOwnerLoginLink(providerId, email)?.token ?? null;
    },
  };
}

/** The two sites that have owners, and where their login link is verified. */
const OWNER_SITES: ReadonlyArray<{ key: "rfb" | "opplevagent"; heading: string; verifyPath: string }> = [
  { key: "rfb", heading: "Rett fra Bonden", verifyPath: "/magic-link-verify" },
  { key: "opplevagent", heading: "Opplevagent, gårdssalg", verifyPath: "/kategori/gardssalg/eier/magic-link-verify" },
];

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function osloTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "medium", timeStyle: "medium" });
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f1ea; color: #1c2a22; }
  header { background: #7a2e12; color: #fff; padding: 10px 16px; font-weight: 600; }
  header a { color: #fff; margin-left: 16px; font-weight: 400; }
  main { max-width: 960px; margin: 0 auto; padding: 16px; }
  section { background: #fff; border: 1px solid #ddd6c8; border-radius: 10px; padding: 16px; margin: 0 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 0 0 8px; } h3 { font-size: 16px; margin: 16px 0 6px; }
  p { margin: 0 0 8px; } .muted { color: #5c675f; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 6px 8px; border-top: 1px solid #ece6d9; vertical-align: top; }
  th { font-size: 13px; color: #5c675f; font-weight: 600; border-top: 0; }
  button { font: inherit; min-height: 40px; padding: 6px 14px; border-radius: 8px; border: 1px solid #0f3d33; background: #0f3d33; color: #fff; cursor: pointer; }
  button.plain { background: #fff; color: #0f3d33; }
  a { color: #0f3d33; } code { background: #f1ede3; padding: 1px 5px; border-radius: 4px; font-size: 14px; }
  iframe { width: 100%; height: 640px; border: 1px solid #ddd6c8; border-radius: 8px; background: #fff; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f8f6f0; border: 1px solid #ece6d9; border-radius: 8px; padding: 12px; font-size: 14px; }
  .blocked { color: #8a1c1c; } .ok { color: #1f6b3a; }
  @media (max-width: 640px) { th:nth-child(3), td:nth-child(3) { display: none; } }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Testmiljø</title>
<style>${STYLE}</style>
</head>
<body>
<header>Testmiljø <a href="/testmiljo">Start</a><a href="/testmiljo/epost">E-post</a><a href="/">Forsiden</a></header>
<main>
${body}
</main>
</body>
</html>`;
}

function ownerTable(siteKey: "rfb" | "opplevagent", owners: TestOwner[]): string {
  if (owners.length === 0) return `<p class="muted">Ingen eiere i databasen.</p>`;
  const rows = owners
    .map(
      (owner) => `<tr>
  <td>${esc(owner.name)}${owner.detail ? `<div class="muted">${esc(owner.detail)}</div>` : ""}</td>
  <td>${esc(owner.email)}</td>
  <td class="muted">${esc(owner.id)}</td>
  <td><form method="post" action="/testmiljo/logg-inn"><input type="hidden" name="site" value="${siteKey}"><input type="hidden" name="id" value="${esc(owner.id)}"><button type="submit">Logg inn</button></form></td>
</tr>`,
    )
    .join("\n");
  return `<table><thead><tr><th>Eier av</th><th>E-post</th><th>Id</th><th></th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

function safeOwners(load: () => TestOwner[]): { owners: TestOwner[]; error: string | null } {
  try {
    return { owners: load(), error: null };
  } catch (err) {
    return { owners: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** The local site this request's Host names, or null for plain localhost. */
function requestSite(hostname: string): LocalSite | null {
  return LOCAL_SITES.find((site) => site.localHost === hostname.trim().toLowerCase()) ?? null;
}

function ownerSection(deps: TestmiljoDeps, here: LocalSite | null, port: string): string {
  return OWNER_SITES.map((ownerSite) => {
    const site = siteByKey(ownerSite.key)!;
    if (here?.key !== ownerSite.key) {
      const there = `${localOrigin(site, port)}/testmiljo`;
      return `<h3>${esc(ownerSite.heading)}</h3>
<p>Du logger inn fra plattformens egen adresse: <a href="${esc(there)}">${esc(there)}</a></p>`;
    }
    const { owners, error } = safeOwners(ownerSite.key === "rfb" ? deps.rfbOwners : deps.gardssalgOwners);
    return `<h3>${esc(ownerSite.heading)}</h3>
${error ? `<p class="blocked">Kunne ikke lese eierne: ${esc(error)}</p>` : ownerTable(ownerSite.key, owners)}`;
  }).join("\n");
}

function startPage(deps: TestmiljoDeps, hostname: string, port: string): string {
  const mails = listOutbox();
  const attempts = outboundAttempts();
  const sites = LOCAL_SITES.map((site) => `<li><a href="${esc(localOrigin(site, port))}/">${esc(site.label)}</a> <span class="muted">${esc(localOrigin(site, port))}</span></li>`).join("\n");
  const outbound = attempts.length
    ? `<table><thead><tr><th>Vert</th><th>Port</th><th>Antall</th><th>Utfall</th></tr></thead><tbody>
${attempts.map((a) => `<tr><td>${esc(a.host)}</td><td>${esc(a.port ?? "")}</td><td>${a.count}</td><td class="${a.allowed ? "ok" : "blocked"}">${a.allowed ? "Tillatt" : "Sperret"}</td></tr>`).join("\n")}
</tbody></table>`
    : `<p class="muted">Ingen forsøk siden oppstart.</p>`;
  return page(
    "Start",
    `<section>
<h1>Testmiljø</h1>
<p>Dette er en lokal kopi med oppdiktede data. Ingenting her når prod, og ingen e-post sendes.</p>
<ul>
${sites}
</ul>
</section>
<section>
<h2>Logg inn som eier</h2>
<p class="muted">Du logges inn gjennom den vanlige innloggingen, bare uten e-posten.</p>
${ownerSection(deps, requestSite(hostname), port)}
</section>
<section>
<h2>E-post</h2>
<p><a href="/testmiljo/epost">Se e-postene som ville blitt sendt</a> (${mails.length})</p>
</section>
<section>
<h2>Utgående kall</h2>
<p class="muted">Tjeneren får ikke koble til noe utenfor denne maskinen. Slipp en vert gjennom med <code>TESTMILJO_ALLOW_OUTBOUND</code>.</p>
${outbound}
</section>`,
  );
}

function outboxPage(mails: OutboxMail[]): string {
  const rows = mails
    .map(
      (mail) => `<tr>
  <td class="muted">${esc(osloTime(mail.at))}</td>
  <td>${esc(mail.to)}</td>
  <td class="muted">${esc(mail.from)}</td>
  <td><a href="/testmiljo/epost/${esc(mail.id)}">${esc(mail.subject || "(uten emne)")}</a></td>
</tr>`,
    )
    .join("\n");
  return page(
    "E-post",
    `<section>
<h1>E-post</h1>
<p>E-postene under ble fanget i stedet for å bli sendt. Nyeste først.</p>
${
  mails.length
    ? `<table><thead><tr><th>Tid</th><th>Til</th><th>Fra</th><th>Emne</th></tr></thead><tbody>
${rows}
</tbody></table>
<form method="post" action="/testmiljo/epost/tom" style="margin-top:12px"><button type="submit" class="plain">Tøm listen</button></form>`
    : `<p class="muted">Ingen e-post er fanget ennå.</p>`
}
</section>`,
  );
}

/**
 * The e-mail's HTML as the srcdoc of a sandboxed frame. The sandbox has no
 * allow-scripts, allow-same-origin, allow-forms or allow-popups: nothing in a
 * captured e-mail can run, read this origin or open a window. The one thing it
 * may do is take the whole window to a link you click.
 */
function mailFrame(mail: OutboxMail): string {
  const body = mail.html ?? `<pre style="white-space:pre-wrap;font:15px/1.5 system-ui,sans-serif">${esc(mail.text ?? "")}</pre>`;
  return `<iframe title="E-posten" sandbox="allow-top-navigation-by-user-activation" srcdoc="${esc(`<base target="_top">${body}`)}"></iframe>`;
}

function mailPage(mail: OutboxMail): string {
  const meta: Array<[string, string | undefined]> = [
    ["Tid", osloTime(mail.at)],
    ["Fra", mail.from],
    ["Til", mail.to],
    ["Kopi", mail.cc],
    ["Blindkopi", mail.bcc],
    ["Svar til", mail.replyTo],
    ["Emne", mail.subject],
    ...Object.entries(mail.headers),
    ["Vedlegg", mail.attachments.length ? mail.attachments.map((a) => `${a.filename} (${a.bytes} byte)`).join(", ") : undefined],
  ];
  const rows = meta
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(value)}</td></tr>`)
    .join("\n");
  return page(
    mail.subject || "E-post",
    `<section>
<p><a href="/testmiljo/epost">Tilbake til listen</a></p>
<h1>${esc(mail.subject || "(uten emne)")}</h1>
<table><tbody>
${rows}
</tbody></table>
</section>
<section>
<h2>Slik ser den ut</h2>
<p class="muted">Lenkene peker til testmiljøet. I den ekte e-posten peker de til domenet i prod.</p>
${mailFrame(mail)}
</section>
${mail.text ? `<section><h2>Tekstversjonen</h2><pre>${esc(mail.text)}</pre></section>` : ""}`,
  );
}

export function createTestmiljoRouter(deps: TestmiljoDeps = defaultTestmiljoDeps()): Router {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!isTestmiljo()) return res.status(404).type("text/plain").send("Not found");
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return res.status(403).type("text/plain").send("The test environment only answers this machine.");
    // A page on another site may reach this machine's loopback through the
    // tester's browser. Two cheap answers: the Host must be one of the local
    // names (a rebound DNS name is not), and a write must come from these
    // pages themselves (Sec-Fetch-Site, sent by every current browser).
    if (!isLocalHostName(splitHostPort(req.headers.host).hostname)) return res.status(403).type("text/plain").send("Unknown host name for the test environment.");
    // A tunnel or reverse proxy on this machine makes every visitor look like
    // loopback, and may rewrite Host. It also adds a forwarding header, or
    // arrives with an X-Forwarded-Host of its own (marked by hosts.ts).
    const { carriesProxyHeaders } = require("../middleware/client-ip") as typeof import("../middleware/client-ip");
    const { isCrossSiteWrite } = require("../middleware/same-origin-write") as typeof import("../middleware/same-origin-write");
    if (carriesProxyHeaders(req.headers) || req.headers[CLIENT_FORWARDED_HOST_MARK] !== undefined) {
      return res.status(403).type("text/plain").send("The test environment does not answer through a proxy or tunnel.");
    }
    if (req.method !== "GET" && req.method !== "HEAD" && isCrossSiteWrite(req, "/testmiljo")) {
      return res.status(403).type("text/plain").send("Cross-site request refused.");
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  router.use(express.urlencoded({ extended: false }));

  router.get("/", (req: Request, res: Response) => {
    const { hostname, port } = splitHostPort(req.headers.host);
    res.send(startPage(deps, hostname, port));
  });

  router.post("/logg-inn", (req: Request, res: Response) => {
    const siteKey = String(req.body?.site ?? "");
    const id = String(req.body?.id ?? "");
    const { hostname, port } = splitHostPort(req.headers.host);
    const ownerSite = OWNER_SITES.find((candidate) => candidate.key === siteKey);
    if (!ownerSite) {
      return res.status(400).send(page("Feil", `<section><h1>Ukjent plattform</h1><p><a href="/testmiljo">Tilbake</a></p></section>`));
    }
    // The cookie the verify route sets belongs to that site's own name.
    if (requestSite(hostname)?.key !== ownerSite.key) {
      const there = `${localOrigin(siteByKey(ownerSite.key)!, port)}/testmiljo`;
      return res.status(400).send(page("Feil", `<section><h1>Feil adresse</h1><p>Logg inn på ${esc(ownerSite.heading)} fra <a href="${esc(there)}">${esc(there)}</a>.</p></section>`));
    }
    const owners = ownerSite.key === "rfb" ? deps.rfbOwners() : deps.gardssalgOwners();
    const owner = owners.find((candidate) => candidate.id === id);
    if (!owner) {
      return res.status(404).send(page("Feil", `<section><h1>Fant ikke eieren</h1><p>Bare eiere som finnes i databasen, kan velges.</p><p><a href="/testmiljo">Tilbake</a></p></section>`));
    }
    const token = ownerSite.key === "rfb" ? deps.issueRfbLogin(owner.id, owner.email) : deps.issueGardssalgLogin(owner.id, owner.email);
    if (!token) {
      return res.status(500).send(page("Feil", `<section><h1>Kunne ikke lage innloggingslenke</h1><p><a href="/testmiljo">Tilbake</a></p></section>`));
    }
    console.log(`[testmiljo] login as owner of ${ownerSite.key}:${owner.id}`);
    return res.redirect(303, `${ownerSite.verifyPath}?token=${encodeURIComponent(token)}`);
  });

  router.get("/epost", (_req: Request, res: Response) => {
    res.send(outboxPage(listOutbox()));
  });

  router.post("/epost/tom", (_req: Request, res: Response) => {
    clearOutbox();
    res.redirect(303, "/testmiljo/epost");
  });

  router.get("/epost/:id", (req: Request, res: Response) => {
    const mail = getOutboxMail(String(req.params.id));
    if (!mail) return res.status(404).send(page("E-post", `<section><h1>Fant ikke e-posten</h1><p><a href="/testmiljo/epost">Tilbake til listen</a></p></section>`));
    res.send(mailPage(mail));
  });

  return router;
}

/** Called once from src/index.ts, ahead of the host gates. Mounts nothing outside the test environment. */
export function mountTestmiljo(app: Express): void {
  if (!isTestmiljo()) return;
  app.use("/testmiljo", createTestmiljoRouter());
  console.log(`[testmiljo] /testmiljo mounted (owner login without e-mail, outbox at ${outboxFile()})`);
}

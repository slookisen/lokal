/**
 * handleliste-page.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 3.
 *
 * Web surface for the shopping list: `/handleliste` (NO) and
 * `/en/shopping-list` (EN). The route itself is registered in seo.ts (it needs
 * the shared shell()); this module owns the page content, copy, the client
 * script and the feature flag.
 *
 * Flag: HANDLELISTE_ENABLED ("true" | "1"). Default OFF — with the flag off the
 * routes fall through to the normal 404, nothing links here and the sitemap is
 * untouched. Evaluated per request (so flipping the env var + restart is the
 * whole rollback; tests can flip it in-process).
 *
 * No new endpoint classes: the page is a thin progressive-JS client over the
 * existing, already-gated endpoints from slices 0-2:
 *   GET   /api/marketplace/catalog/offers
 *   POST  /api/marketplace/cart
 *   POST  /api/marketplace/cart/:id/wishes
 *   PATCH /api/marketplace/cart/:id/wishes/:wid
 *   POST  /api/marketplace/cart/:id/submit
 *
 * Safety / privacy:
 *  - The server renders only static copy. Every user-/producer-supplied string
 *    (term, place, producer name, delivery text, phone, e-mail, urls) is added
 *    on the client via textContent / setAttribute — never innerHTML — and
 *    href values are allow-listed (http(s) / same-origin path / tel: / mailto:).
 *  - Buyer contact fields are only ever sent in the submit POST body; they are
 *    not stored in localStorage, not put in URLs and not logged. localStorage
 *    holds only the cart capability token (buyer_ref) and the producer-side
 *    result (public producer contact info).
 *  - The page is `noindex` (query/cart surface, same URL for all steps).
 */

import { localizedPath, type Lang } from "../i18n/t";
import { KJOPSVILKAR_PATH } from "./rfb-kjopsvilkar";

export function isHandelisteEnabled(): boolean {
  const v = (process.env.HANDLELISTE_ENABLED || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Paths (language prefix already stripped by langMiddleware) this page answers to. */
export const HANDELISTE_PATH_NO = "/handleliste";
export const HANDELISTE_PATH_EN = "/shopping-list";

export const HANDELISTE_MAX_ITEMS = 8;
/** Offers shown before "show more" (the offers endpoint itself is capped at 5). */
export const HANDELISTE_OFFERS_INITIAL = 3;

interface Copy {
  title: string;
  description: string;
  h1: string;
  lede: string;
  noscript: string;
  [k: string]: string;
}

const COPY: Record<"no" | "en", Copy> = {
  no: {
    title: "Handleliste — velg produsent per vare | Rett fra Bonden",
    description: "Lag en handleliste, velg produsent per vare og send bestillingen direkte, eller ta kontakt selv.",
    h1: "Handleliste",
    lede: "Skriv inn varene du vil ha og hvor du er. Du får opptil fem produsenter per vare, sortert på avstand, og velger selv hvem du vil kjøpe fra. Ingen betaling skjer her.",
    noscript: "Handlelisten trenger JavaScript for å fungere. Du kan i stedet søke etter produsenter på /sok.",
    step1: "1. Varer og sted",
    item_label: "Vare",
    item_ph: "f.eks. poteter",
    qty_label: "Antall",
    add_item: "Legg til vare",
    remove_item: "Fjern",
    place_label: "Sted",
    place_ph: "By eller sted, f.eks. Oslo",
    find: "Finn produsenter",
    step2: "2. Velg produsent per vare",
    loading: "Henter tilbud …",
    no_offers: "Ingen produsenter funnet for denne varen i nærheten.",
    skip_item: "Hopp over denne varen",
    show_more: "Vis flere",
    badge_verified: "Verifisert av eier",
    can_order: "Kan bestilles her",
    contact_only: "Kontakt selv",
    km: "km",
    producer_says: "Produsenten oppgir:",
    channels: "Salgskanaler:",
    availability: "Tilgjengelighet:",
    back: "Tilbake",
    next_summary: "Videre til oppsummering",
    pick_one: "Velg minst én produsent for å gå videre.",
    step3: "3. Oppsummering og kontakt",
    summary_order: "Bestilles direkte hos produsenten (venter bekreftelse)",
    summary_contact: "Du tar kontakt selv",
    contact_h: "Kontaktinfo",
    name_label: "Navn",
    email_label: "E-post",
    phone_label: "Telefon",
    note_label: "Leveringsønske (valgfritt)",
    note_ph: "f.eks. henting torsdag ettermiddag",
    consent_label: "Jeg samtykker til at navn, e-post og telefon deles med produsentene jeg bestiller direkte hos, slik at de kan svare meg. Opplysningene slettes automatisk 30 dager etter at bestillingen er avsluttet.",
    consent_needed: "Samtykke og e-post eller telefon må oppgis for å sende en bestilling.",
    no_payment: "Ingen betaling skjer via Rett fra Bonden. Du avtaler henting og betaling direkte med produsenten.",
    terms_before: "Når du sender handlelisten, gjelder",
    terms_link: "kjøpsvilkårene",
    terms_after: ", inkludert reglene for avbestilling og refusjon.",
    submit: "Send handlelisten",
    sending: "Sender …",
    error_generic: "Noe gikk galt. Prøv igjen om litt.",
    error_conflict: "To varer kan ikke bruke samme produkt. Velg ulike produsenter eller produkter.",
    error_rate: "For mange forsøk. Vent litt og prøv igjen.",
    step4: "4. Resultat",
    sent_h: "Bestilling sendt, venter bekreftelse",
    sent_p: "Produsenten har fått bestillingen din på e-post og bekrefter direkte. Du får svar på e-posten du oppga.",
    contact_h2: "Kontakt selv",
    contact_p: "Disse produsentene tar ikke imot bestillinger her ennå. Ta kontakt direkte, bruk gjerne meldingen under.",
    msg_label: "Ferdig melding",
    copy_msg: "Kopier melding",
    copied: "Kopiert",
    call: "Ring",
    mail: "Send e-post",
    vcard: "Lagre kontakt (vCard)",
    profile: "Se produsentprofil",
    new_list: "Ny handleliste",
    err_fields: "Fyll inn minst én vare og et sted.",
    err_place: "Vi fant ikke stedet. Prøv et annet stedsnavn.",
  },
  en: {
    title: "Shopping list — choose a producer per item | Rett fra Bonden",
    description: "Build a shopping list, pick a producer for each item and send the order directly, or contact them yourself.",
    h1: "Shopping list",
    lede: "Enter the items you want and where you are. You get up to five producers per item, sorted by distance, and choose who to buy from. No payment happens here.",
    noscript: "The shopping list needs JavaScript. You can search for producers at /en/sok instead.",
    step1: "1. Items and place",
    item_label: "Item",
    item_ph: "e.g. potatoes",
    qty_label: "Quantity",
    add_item: "Add item",
    remove_item: "Remove",
    place_label: "Place",
    place_ph: "City or place, e.g. Oslo",
    find: "Find producers",
    step2: "2. Choose a producer per item",
    loading: "Fetching offers …",
    no_offers: "No producers found nearby for this item.",
    skip_item: "Skip this item",
    show_more: "Show more",
    badge_verified: "Verified by owner",
    can_order: "Can be ordered here",
    contact_only: "Contact directly",
    km: "km",
    producer_says: "The producer states:",
    channels: "Sales channels:",
    availability: "Availability:",
    back: "Back",
    next_summary: "Continue to summary",
    pick_one: "Choose at least one producer to continue.",
    step3: "3. Summary and contact",
    summary_order: "Ordered directly from the producer (awaiting confirmation)",
    summary_contact: "You contact them yourself",
    contact_h: "Contact details",
    name_label: "Name",
    email_label: "E-mail",
    phone_label: "Phone",
    note_label: "Delivery wish (optional)",
    note_ph: "e.g. pickup Thursday afternoon",
    consent_label: "I consent to my name, e-mail and phone being shared with the producers I order directly from, so they can reply to me. The details are deleted automatically 30 days after the order is closed.",
    consent_needed: "Consent and an e-mail or phone number are required to send an order.",
    no_payment: "No payment goes through Rett fra Bonden. You agree pickup and payment directly with the producer.",
    terms_before: "When you send the list, our",
    terms_link: "terms of purchase",
    terms_after: " apply, including the rules for cancellation and refunds.",
    submit: "Send shopping list",
    sending: "Sending …",
    error_generic: "Something went wrong. Please try again shortly.",
    error_conflict: "Two items cannot use the same product. Choose different producers or products.",
    error_rate: "Too many attempts. Please wait a moment and try again.",
    step4: "4. Result",
    sent_h: "Order sent, awaiting confirmation",
    sent_p: "The producer has received your order by e-mail and will confirm directly. You will get a reply at the e-mail you gave.",
    contact_h2: "Contact directly",
    contact_p: "These producers do not take orders here yet. Contact them directly, feel free to use the message below.",
    msg_label: "Ready-made message",
    copy_msg: "Copy message",
    copied: "Copied",
    call: "Call",
    mail: "Send e-mail",
    vcard: "Save contact (vCard)",
    profile: "View producer profile",
    new_list: "New shopping list",
    err_fields: "Enter at least one item and a place.",
    err_place: "We could not find that place. Try another name.",
  },
};

export const HANDELISTE_CSS = `
<style>
  .hl-wrap{max-width:760px;margin:0 auto;padding:24px 16px 64px}
  .hl-wrap h1{font-size:1.8rem;margin:0 0 8px}
  .hl-lede{color:#41504a;margin:0 0 20px}
  .hl-step{background:#fff;border:1px solid #e4e2da;border-radius:12px;padding:18px;margin:0 0 16px}
  .hl-step[hidden],.hl-offer[hidden],.hl-msg[hidden]{display:none}
  .hl-step h2{font-size:1.1rem;margin:0 0 12px}
  .hl-row{display:flex;gap:8px;margin:0 0 8px;align-items:flex-end;flex-wrap:wrap}
  .hl-row label{display:flex;flex-direction:column;font-size:.85rem;gap:4px;flex:1 1 140px}
  .hl-row label.hl-qty{flex:0 0 90px}
  .hl-wrap input[type=text],.hl-wrap input[type=email],.hl-wrap input[type=tel],.hl-wrap input[type=number],.hl-wrap textarea{padding:9px 10px;border:1px solid #cfd3c8;border-radius:8px;font:inherit;width:100%;box-sizing:border-box}
  .hl-btn{padding:10px 16px;border-radius:8px;border:1px solid #d8dbd2;background:#eef0ea;color:#1e2b23;font-weight:700;cursor:pointer;font-size:.95rem}
  .hl-btn.primary{background:#2c5b3f;color:#fff;border-color:#2c5b3f}
  .hl-btn[disabled]{opacity:.6;cursor:default}
  .hl-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .hl-item h3{font-size:1rem;margin:14px 0 8px}
  .hl-offer{display:block;border:1px solid #e4e2da;border-radius:10px;padding:10px 12px;margin:0 0 8px;cursor:pointer}
  .hl-offer.sel{border-color:#2c5b3f;background:#f2f7f3}
  .hl-offer input{margin-right:8px}
  .hl-offer .hl-name{font-weight:700}
  .hl-meta{font-size:.85rem;color:#41504a;margin-top:4px}
  .hl-badge{display:inline-block;font-size:.75rem;font-weight:700;border-radius:999px;padding:2px 8px;margin-left:6px;background:#e8f4ec;color:#1d5a30}
  .hl-badge.warn{background:#fdf3e7;color:#7a5218}
  .hl-msg{border-radius:8px;padding:10px 12px;margin:12px 0;font-size:.9rem;background:#fdf3e7;border:1px solid #f0d4ae;color:#7a5218}
  .hl-ok{background:#e8f4ec;border-color:#bcd9c5;color:#1d5a30}
  .hl-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .hl-handoff{border:1px solid #e4e2da;border-radius:10px;padding:12px;margin:0 0 12px}
  .hl-handoff pre{white-space:pre-wrap;background:#f5f3ee;border-radius:8px;padding:10px;font:inherit;font-size:.9rem;margin:6px 0}
  .hl-handoff a{margin-right:12px}
  .hl-hint{font-size:.82rem;color:#7c877f}
  .hl-check{display:flex;gap:8px;align-items:flex-start;font-size:.88rem;margin:10px 0}
</style>`;

function escapeText(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CLIENT_SCRIPT = `
(function(){
  var C = JSON.parse(document.getElementById('hl-copy').textContent);
  var MAX_ITEMS = C.__max_items, INITIAL = C.__initial;
  var LS_CART = 'rfb_handleliste_cart', LS_RESULT = 'rfb_handleliste_result';
  var el = function(id){ return document.getElementById(id); };
  var state = { items: [], place: '', offers: [], picks: [], nearLat: null };

  function lsGet(k){ try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(_) { return null; } }
  function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(_) {} }
  function lsDel(k){ try { localStorage.removeItem(k); } catch(_) {} }

  function mk(tag, props, kids){
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'text') n.textContent = props[k];
      else if (k === 'cls') n.className = props[k];
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function(c){ if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n){ while (n.firstChild) n.removeChild(n.firstChild); }
  // href allow-list: same-origin path, http(s), tel:, mailto: only.
  function safeHref(u){
    u = String(u == null ? '' : u);
    if (/^\\/(?!\\/)/.test(u) || /^https?:\\/\\//i.test(u)) return u;
    return null;
  }
  function telHref(p){ var d = String(p == null ? '' : p).replace(/[^0-9+]/g, ''); return d ? 'tel:' + d : null; }
  function mailHref(e, subject, body){
    e = String(e == null ? '' : e).trim();
    if (!/^[^\\s@<>"]+@[^\\s@<>"]+$/.test(e)) return null;
    return 'mailto:' + encodeURIComponent(e).replace(/%40/g, '@') + (body ? '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body) : '');
  }
  function show(step){
    ['hl-s1','hl-s2','hl-s3','hl-s4'].forEach(function(id){ el(id).hidden = (id !== step); });
    try { el(step).scrollIntoView(); } catch(_) {}
  }
  function msg(id, text, ok){
    var n = el(id); clear(n);
    if (!text) { n.hidden = true; return; }
    n.className = 'hl-msg' + (ok ? ' hl-ok' : ''); n.textContent = text; n.hidden = false;
  }

  // ── step 1: item rows ──
  function addRow(term, qty){
    var rows = el('hl-rows');
    if (rows.children.length >= MAX_ITEMS) return;
    var t = mk('input', { type: 'text', maxlength: '80', placeholder: C.item_ph, 'aria-label': C.item_label });
    var q = mk('input', { type: 'number', min: '1', max: '99', value: String(qty || 1), 'aria-label': C.qty_label });
    if (term) t.value = term;
    var rm = mk('button', { type: 'button', cls: 'hl-btn', text: C.remove_item });
    var row = mk('div', { cls: 'hl-row' }, [
      mk('label', null, [C.item_label, t]),
      mk('label', { cls: 'hl-qty' }, [C.qty_label, q]),
      rm
    ]);
    rm.addEventListener('click', function(){ if (rows.children.length > 1) rows.removeChild(row); el('hl-add').hidden = rows.children.length >= MAX_ITEMS; });
    rows.appendChild(row);
    el('hl-add').hidden = rows.children.length >= MAX_ITEMS;
  }
  function readRows(){
    var out = [];
    Array.prototype.forEach.call(el('hl-rows').children, function(row){
      var ins = row.getElementsByTagName('input');
      var term = (ins[0].value || '').trim();
      var qty = parseInt(ins[1].value, 10);
      if (term) out.push({ term: term.slice(0, 80), qty: (qty > 0 && qty < 100) ? qty : 1 });
    });
    return out;
  }

  function api(method, path, body){
    var opts = { method: method, headers: { 'Accept': 'application/json' } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){ return { status: r.status, body: j }; });
    });
  }
  function errText(r){
    if (r && r.status === 429) return C.error_rate;
    if (r && r.status === 409) return C.error_conflict;
    return C.error_generic;
  }

  // ── step 2: offers ──
  function fetchOffers(){
    var items = readRows(), place = (el('hl-place').value || '').trim();
    if (!items.length || !place) { msg('hl-msg1', C.err_fields); return; }
    msg('hl-msg1', '');
    state.items = items; state.place = place; state.offers = []; state.picks = [];
    el('hl-find').disabled = true;
    Promise.all(items.map(function(it){
      return api('GET', '/api/marketplace/catalog/offers?q=' + encodeURIComponent(it.term) + '&near=' + encodeURIComponent(place) + '&radius_km=50&limit=5');
    })).then(function(rs){
      el('hl-find').disabled = false;
      var anyOk = false;
      rs.forEach(function(r, i){
        var offers = (r.status === 200 && r.body && Array.isArray(r.body.offers)) ? r.body.offers.slice(0, 5) : [];
        if (r.status === 200) anyOk = true;
        state.offers[i] = offers; state.picks[i] = null;
      });
      if (!anyOk) { msg('hl-msg1', C.error_generic); return; }
      renderOffers(); show('hl-s2');
    }).catch(function(){ el('hl-find').disabled = false; msg('hl-msg1', C.error_generic); });
  }

  function offerNode(i, j, o){
    var p = o.producer || {};
    var id = 'hl-o-' + i + '-' + j;
    var radio = mk('input', { type: 'radio', name: 'hl-pick-' + i, id: id });
    var lbl = mk('label', { cls: 'hl-offer', 'for': id });
    var head = mk('div', null, [radio, mk('span', { cls: 'hl-name', text: String(p.name || '') })]);
    if (p.verifisert_av_eier) head.appendChild(mk('span', { cls: 'hl-badge', text: C.badge_verified }));
    head.appendChild(mk('span', { cls: 'hl-badge' + (p.can_order ? '' : ' warn'), text: p.can_order ? C.can_order : C.contact_only }));
    lbl.appendChild(head);
    var bits = [];
    if (p.city) bits.push(String(p.city));
    if (typeof p.distance_km === 'number') bits.push(p.distance_km + ' ' + C.km);
    if (o.product_name) bits.push(String(o.product_name));
    if (typeof o.price_nok === 'number') bits.push(o.price_nok + ' kr' + (o.unit ? '/' + o.unit : ''));
    lbl.appendChild(mk('div', { cls: 'hl-meta', text: bits.join(' · ') }));
    if (o.availability) lbl.appendChild(mk('div', { cls: 'hl-meta', text: C.availability + ' ' + String(o.availability) }));
    if (Array.isArray(p.salgskanaler) && p.salgskanaler.length) lbl.appendChild(mk('div', { cls: 'hl-meta', text: C.channels + ' ' + p.salgskanaler.join(', ') }));
    if (p.delivery_text) lbl.appendChild(mk('div', { cls: 'hl-meta', text: C.producer_says + ' ' + String(p.delivery_text) }));
    radio.addEventListener('change', function(){
      state.picks[i] = j;
      var sibs = lbl.parentNode.querySelectorAll('.hl-offer');
      Array.prototype.forEach.call(sibs, function(s){ s.classList.remove('sel'); });
      lbl.classList.add('sel');
      msg('hl-msg2', '');
    });
    return lbl;
  }
  function renderOffers(){
    var box = el('hl-offers'); clear(box);
    state.items.forEach(function(it, i){
      var sec = mk('div', { cls: 'hl-item' }, [mk('h3', { text: it.term + ' × ' + it.qty })]);
      var offers = state.offers[i] || [];
      if (!offers.length) sec.appendChild(mk('p', { cls: 'hl-hint', text: C.no_offers }));
      var list = mk('div');
      offers.forEach(function(o, j){
        var n = offerNode(i, j, o);
        if (j >= INITIAL) n.hidden = true;
        list.appendChild(n);
      });
      sec.appendChild(list);
      if (offers.length > INITIAL) {
        var more = mk('button', { type: 'button', cls: 'hl-btn', text: C.show_more });
        more.addEventListener('click', function(){
          Array.prototype.forEach.call(list.children, function(c){ c.hidden = false; });
          more.hidden = true;
        });
        sec.appendChild(more);
      }
      if (offers.length) {
        var skip = mk('button', { type: 'button', cls: 'hl-btn', text: C.skip_item });
        skip.addEventListener('click', function(){
          state.picks[i] = null;
          Array.prototype.forEach.call(list.querySelectorAll('input'), function(r){ r.checked = false; });
          Array.prototype.forEach.call(list.querySelectorAll('.hl-offer'), function(s){ s.classList.remove('sel'); });
        });
        sec.appendChild(skip);
      }
      box.appendChild(sec);
    });
  }
  function chosen(){
    var out = [];
    state.items.forEach(function(it, i){
      var j = state.picks[i];
      if (j == null) return;
      var o = state.offers[i][j];
      if (o) out.push({ item: it, offer: o });
    });
    return out;
  }

  // ── step 3: summary ──
  function toSummary(){
    var ch = chosen();
    if (!ch.length) { msg('hl-msg2', C.pick_one); return; }
    var box = el('hl-summary'); clear(box);
    var orderable = ch.filter(function(c){ return c.offer.producer && c.offer.producer.can_order && c.offer.product_id; });
    var contact = ch.filter(function(c){ return orderable.indexOf(c) < 0; });
    function group(title, list){
      if (!list.length) return;
      box.appendChild(mk('h3', { text: title }));
      list.forEach(function(c){
        box.appendChild(mk('div', { cls: 'hl-meta', text: c.item.qty + ' × ' + c.item.term + ' — ' + String((c.offer.producer || {}).name || '') }));
      });
    }
    group(C.summary_order, orderable);
    group(C.summary_contact, contact);
    state.hasOrders = orderable.length > 0;
    msg('hl-msg3', '');
    show('hl-s3');
  }

  // ── submit ──
  function submit(){
    var name = (el('hl-name').value || '').trim(), email = (el('hl-email').value || '').trim();
    var phone = (el('hl-phone').value || '').trim(), note = (el('hl-note').value || '').trim();
    var consent = el('hl-consent').checked;
    if (state.hasOrders && (!consent || !(email || phone))) { msg('hl-msg3', C.consent_needed); return; }
    var btn = el('hl-submit'); btn.disabled = true; btn.textContent = C.sending; msg('hl-msg3', '');
    var done = function(text){ btn.disabled = false; btn.textContent = C.submit; msg('hl-msg3', text); };
    var ch = chosen(), cart = null;
    api('POST', '/api/marketplace/cart').then(function(r){
      if (r.status !== 201 || !r.body || !r.body.buyer_ref) throw r;
      cart = { cart_id: r.body.cart_id, buyer_ref: r.body.buyer_ref };
      lsSet(LS_CART, cart);
      // Sequential: a chosen product can only back one wish (server returns 409 otherwise).
      var chain = Promise.resolve();
      ch.forEach(function(c){
        chain = chain.then(function(){
          return api('POST', '/api/marketplace/cart/' + encodeURIComponent(cart.cart_id) + '/wishes', { term: c.item.term, qty: c.item.qty, buyer_ref: cart.buyer_ref }).then(function(w){
            if (w.status !== 201 || !w.body || !w.body.wish) throw w;
            var p = c.offer.producer || {};
            var body = (p.can_order && c.offer.product_id) ? { product_id: c.offer.product_id, qty: c.item.qty } : { agent_id: p.agent_id, mode: 'contact' };
            body.buyer_ref = cart.buyer_ref;
            return api('PATCH', '/api/marketplace/cart/' + encodeURIComponent(cart.cart_id) + '/wishes/' + encodeURIComponent(w.body.wish.id), body).then(function(pr){
              if (pr.status !== 200) throw pr;
            });
          });
        });
      });
      return chain;
    }).then(function(){
      var body = { buyer_ref: cart.buyer_ref, website: (el('hl-website').value || '') };
      if (consent) { body.contact_consent = true; if (name) body.buyer_name = name; if (email) body.buyer_email = email; if (phone) body.buyer_phone = phone; }
      if (note) body.delivery_note = note;
      return api('POST', '/api/marketplace/cart/' + encodeURIComponent(cart.cart_id) + '/submit', body);
    }).then(function(r){
      if (r.status !== 201 || !r.body || r.body.success !== true) throw r;
      var vcards = {};
      ch.forEach(function(c){ var p = c.offer.producer || {}; if (p.agent_id) vcards[p.agent_id] = p.vcard_url || null; });
      var result = { orders: r.body.orders || [], handoffs: r.body.contact_handoffs || [], vcards: vcards };
      lsDel(LS_CART); lsSet(LS_RESULT, result);
      el('hl-name').value = ''; el('hl-email').value = ''; el('hl-phone').value = ''; el('hl-note').value = '';
      btn.disabled = false; btn.textContent = C.submit;
      renderResult(result); show('hl-s4');
    }).catch(function(r){ done(errText(r)); });
  }

  // ── step 4: result ──
  function renderResult(res){
    var box = el('hl-result'); clear(box);
    if (res.orders && res.orders.length) {
      box.appendChild(mk('div', { cls: 'hl-msg hl-ok' }, [mk('strong', { text: C.sent_h }), mk('div', { text: C.sent_p })]));
      res.orders.forEach(function(o){ box.appendChild(mk('div', { cls: 'hl-meta', text: String(o.producer_name || '') + (o.total_nok != null ? ' — ' + o.total_nok + ' kr' : '') })); });
    }
    if (res.handoffs && res.handoffs.length) {
      box.appendChild(mk('h3', { text: C.contact_h2 }));
      box.appendChild(mk('p', { cls: 'hl-hint', text: C.contact_p }));
      res.handoffs.forEach(function(h){
        var card = mk('div', { cls: 'hl-handoff' }, [mk('strong', { text: String(h.name || '') })]);
        var links = mk('div', { cls: 'hl-meta' });
        var tel = telHref(h.phone);
        if (tel) links.appendChild(mk('a', { href: tel, text: C.call + ' ' + String(h.phone) }));
        var ml = mailHref(h.email, '', h.message);
        if (ml) links.appendChild(mk('a', { href: ml, text: C.mail + ' ' + String(h.email) }));
        var vc = safeHref(res.vcards && res.vcards[h.agent_id]);
        if (vc) links.appendChild(mk('a', { href: vc, text: C.vcard }));
        var pr = safeHref(h.profile_url);
        if (pr) links.appendChild(mk('a', { href: pr, text: C.profile }));
        card.appendChild(links);
        card.appendChild(mk('div', { cls: 'hl-meta', text: C.msg_label }));
        card.appendChild(mk('pre', { text: String(h.message || '') }));
        var cp = mk('button', { type: 'button', cls: 'hl-btn', text: C.copy_msg });
        cp.addEventListener('click', function(){
          try { navigator.clipboard.writeText(String(h.message || '')).then(function(){ cp.textContent = C.copied; }); } catch(_) {}
        });
        card.appendChild(cp);
        box.appendChild(card);
      });
    }
  }

  // ── wiring ──
  el('hl-add').addEventListener('click', function(){ addRow('', 1); });
  el('hl-find').addEventListener('click', fetchOffers);
  el('hl-back1').addEventListener('click', function(){ show('hl-s1'); });
  el('hl-next2').addEventListener('click', toSummary);
  el('hl-back2').addEventListener('click', function(){ show('hl-s2'); });
  el('hl-submit').addEventListener('click', submit);
  el('hl-new').addEventListener('click', function(){ lsDel(LS_RESULT); lsDel(LS_CART); clear(el('hl-rows')); addRow('', 1); show('hl-s1'); });
  el('hl-form').addEventListener('submit', function(e){ e.preventDefault(); });
  el('hl-js').hidden = false;

  var saved = lsGet(LS_RESULT);
  addRow('', 1);
  if (saved && (saved.orders || saved.handoffs)) { renderResult(saved); show('hl-s4'); } else { show('hl-s1'); }
})();
`;

export interface HandelistePage {
  title: string;
  description: string;
  content: string;
  extraCss: string;
}

/** Pure: builds the (static, escaped) page content for the given language. */
export function buildHandelistePage(lang: Lang): HandelistePage {
  const c = COPY[lang === "en" ? "en" : "no"];
  const copyJson = JSON.stringify({ ...c, __max_items: HANDELISTE_MAX_ITEMS, __initial: HANDELISTE_OFFERS_INITIAL })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const e = escapeText;
  const content = `
  <main class="hl-wrap">
    <h1>${e(c.h1)}</h1>
    <p class="hl-lede">${e(c.lede)}</p>
    <noscript><div class="hl-msg">${e(c.noscript)}</div></noscript>
    <form id="hl-form" autocomplete="off" novalidate>
      <div id="hl-js" hidden></div>
      <section class="hl-step" id="hl-s1">
        <h2>${e(c.step1)}</h2>
        <div id="hl-rows"></div>
        <button type="button" class="hl-btn" id="hl-add">${e(c.add_item)}</button>
        <div class="hl-row" style="margin-top:12px"><label>${e(c.place_label)}<input type="text" id="hl-place" maxlength="80" placeholder="${e(c.place_ph)}"></label></div>
        <div id="hl-msg1" class="hl-msg" hidden role="alert"></div>
        <div class="hl-actions"><button type="button" class="hl-btn primary" id="hl-find">${e(c.find)}</button></div>
      </section>
      <section class="hl-step" id="hl-s2" hidden>
        <h2>${e(c.step2)}</h2>
        <div id="hl-offers"></div>
        <div id="hl-msg2" class="hl-msg" hidden role="alert"></div>
        <div class="hl-actions">
          <button type="button" class="hl-btn" id="hl-back1">${e(c.back)}</button>
          <button type="button" class="hl-btn primary" id="hl-next2">${e(c.next_summary)}</button>
        </div>
      </section>
      <section class="hl-step" id="hl-s3" hidden>
        <h2>${e(c.step3)}</h2>
        <div id="hl-summary"></div>
        <h3>${e(c.contact_h)}</h3>
        <div class="hl-row">
          <label>${e(c.name_label)}<input type="text" id="hl-name" maxlength="120" autocomplete="name"></label>
          <label>${e(c.email_label)}<input type="email" id="hl-email" maxlength="254" autocomplete="email"></label>
          <label>${e(c.phone_label)}<input type="tel" id="hl-phone" maxlength="40" autocomplete="tel"></label>
        </div>
        <label style="font-size:.85rem;display:block">${e(c.note_label)}<textarea id="hl-note" rows="2" maxlength="500" placeholder="${e(c.note_ph)}"></textarea></label>
        <label class="hl-check"><input type="checkbox" id="hl-consent"><span>${e(c.consent_label)}</span></label>
        <div class="hl-hp" aria-hidden="true"><label>Website<input type="text" id="hl-website" tabindex="-1" autocomplete="off"></label></div>
        <p class="hl-hint">${e(c.no_payment)}</p>
        <p class="hl-hint" id="hl-terms">${e(c.terms_before)} <a href="${localizedPath(KJOPSVILKAR_PATH, lang)}">${e(c.terms_link)}</a>${e(c.terms_after)}</p>
        <div id="hl-msg3" class="hl-msg" hidden role="alert"></div>
        <div class="hl-actions">
          <button type="button" class="hl-btn" id="hl-back2">${e(c.back)}</button>
          <button type="button" class="hl-btn primary" id="hl-submit">${e(c.submit)}</button>
        </div>
      </section>
      <section class="hl-step" id="hl-s4" hidden>
        <h2>${e(c.step4)}</h2>
        <div id="hl-result"></div>
        <div class="hl-actions"><button type="button" class="hl-btn" id="hl-new">${e(c.new_list)}</button></div>
      </section>
    </form>
    <script type="application/json" id="hl-copy">${copyJson}</script>
    <script>${CLIENT_SCRIPT}</script>
  </main>`;
  return { title: c.title, description: c.description, content, extraCss: HANDELISTE_CSS };
}

/** Exposed for tests (syntax check + endpoint-contract assertions). */
export const HANDELISTE_CLIENT_SCRIPT = CLIENT_SCRIPT;

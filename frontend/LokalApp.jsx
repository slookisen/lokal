import { useState, useEffect, useCallback } from "react";

// ─── Lokal — Én app, to roller ─────────────────────────────────────
// Same app for consumers AND producers. Switch roles with a tap.
//
// CONSUMER: Onboarding → Feed → Producer Detail → Cart → Reservation
// PRODUCER: Dashboard → Products → Upload → Reservations
//
// This is the key design decision: no separate apps. A farmer on
// Bygdøy and a customer on Oppsal use the same interface.

const PRODUCERS = [
  {
    id: "p1", name: "Aker Gård", type: "farm", district: "Nordre Aker",
    description: "Familiegård med økologiske grønnsaker siden 1987",
    tags: ["organic", "seasonal", "family-run"], trustScore: 0.92,
    distance: 4.2, rating: 4.8, totalTransactions: 156,
    certifications: ["debio-organic"],
    openToday: "08:00–16:00",
    products: [
      { id: "a1", name: "Tomater", variety: "Frilandstomater", price: 35, unit: "kg", organic: true, harvestedHoursAgo: 3, chainPrice: 45, chainName: "Rema 1000", available: 40 },
      { id: "a2", name: "Gulrøtter", price: 22, unit: "kg", organic: true, harvestedHoursAgo: 5, chainPrice: 30, chainName: "Rema 1000", available: 25 },
      { id: "a3", name: "Friske urter", variety: "Blanding", price: 25, unit: "bunt", organic: true, harvestedHoursAgo: 2, chainPrice: 35, chainName: "Rema 1000", available: 30 },
      { id: "a4", name: "Frittgående egg", price: 55, unit: "12-pk", organic: true, harvestedHoursAgo: 6, chainPrice: 70, chainName: "Rema 1000", available: 15 },
    ],
  },
  {
    id: "p2", name: "Grønland Grønt", type: "shop", district: "Grønland",
    description: "Grønnsaksbutikk med daglige leveranser fra lokale bønder",
    tags: ["daily-fresh", "local-sourced", "affordable"], trustScore: 0.88,
    distance: 2.1, rating: 4.6, totalTransactions: 89,
    certifications: [],
    openToday: "07:00–19:00",
    products: [
      { id: "g1", name: "Tomater", price: 29, unit: "kg", organic: false, harvestedHoursAgo: 8, chainPrice: 42, chainName: "Kiwi", available: 60 },
      { id: "g2", name: "Agurk", price: 15, unit: "stk", organic: false, harvestedHoursAgo: 6, chainPrice: 20, chainName: "Kiwi", available: 40 },
      { id: "g3", name: "Norske epler", variety: "Hardanger-blanding", price: 32, unit: "kg", organic: false, harvestedHoursAgo: 24, chainPrice: 40, chainName: "Rema 1000", available: 30 },
    ],
  },
  {
    id: "p3", name: "Løkka Honning & Urter", type: "garden", district: "Grünerløkka",
    description: "Byhage med honning og urter",
    tags: ["urban-garden", "honey", "sustainable"], trustScore: 0.95,
    distance: 3.1, rating: 4.9, totalTransactions: 43,
    certifications: [],
    openToday: "Stengt (åpen ons/lør)",
    products: [
      { id: "l1", name: "Lokal honning", variety: "350g glass", price: 120, unit: "glass", organic: false, chainPrice: 140, chainName: "Meny", available: 8 },
      { id: "l2", name: "Basilikum", price: 20, unit: "bunt", organic: true, harvestedHoursAgo: 1, chainPrice: 30, chainName: "Rema 1000", available: 20 },
    ],
  },
  {
    id: "p4", name: "Nordre Åker Andelsgård", type: "cooperative", district: "Storo",
    description: "Andelsjordbruk med ukentlige grønnsakskasser",
    tags: ["cooperative", "organic", "subscription"], trustScore: 0.91,
    distance: 5.0, rating: 4.7, totalTransactions: 234,
    certifications: ["debio-organic"],
    openToday: "Stengt (åpen tor/lør)",
    products: [
      { id: "n1", name: "Nypoteter", price: 18, unit: "kg", organic: true, harvestedHoursAgo: 4, chainPrice: 30, chainName: "Rema 1000", available: 50 },
      { id: "n2", name: "Grønnkål", price: 30, unit: "bunt", organic: true, harvestedHoursAgo: 3, chainPrice: 40, chainName: "Meny", available: 15 },
      { id: "n3", name: "Jordbær", variety: "500g kurv", price: 60, unit: "kurv", organic: true, harvestedHoursAgo: 2, chainPrice: 75, chainName: "Rema 1000", available: 20 },
    ],
  },
  {
    id: "p5", name: "Bygdøy Frukt & Bær", type: "farm", district: "Bygdøy",
    description: "Fruktgård med epler, plommer og bær",
    tags: ["fruits", "berries", "traditional"], trustScore: 0.87,
    distance: 7.3, rating: 4.5, totalTransactions: 67,
    certifications: ["nyt-norge"],
    openToday: "Stengt (åpen fre–søn)",
    products: [
      { id: "b1", name: "Epler", variety: "Gravenstein", price: 28, unit: "kg", organic: false, harvestedHoursAgo: 12, chainPrice: 42, chainName: "Rema 1000", available: 80 },
      { id: "b2", name: "Plommer", price: 45, unit: "kg", organic: false, harvestedHoursAgo: 6, chainPrice: 60, chainName: "Rema 1000", available: 25 },
    ],
  },
  {
    id: "p6", name: "Nordlys Dagligvarer", type: "shop", district: "Oppsal",
    description: "Nabolagsbutikk med ferske, rimelige grønnsaker og frukt",
    tags: ["affordable", "neighborhood", "fresh-daily", "variety"], trustScore: 0.85,
    distance: 0.8, rating: 4.4, totalTransactions: 312,
    certifications: [],
    openToday: "08:00–20:00",
    products: [
      { id: "nd1", name: "Tomater", variety: "Cherry", price: 32, unit: "kg", organic: false, harvestedHoursAgo: 10, chainPrice: 52, chainName: "Kiwi", available: 30 },
      { id: "nd2", name: "Tomater", variety: "Bifftomat", price: 38, unit: "kg", organic: false, harvestedHoursAgo: 10, chainPrice: 50, chainName: "Rema 1000", available: 20 },
      { id: "nd3", name: "Poteter", variety: "Mandel", price: 24, unit: "kg", organic: false, harvestedHoursAgo: 18, chainPrice: 35, chainName: "Rema 1000", available: 40 },
      { id: "nd4", name: "Poteter", variety: "Gulløye", price: 20, unit: "kg", organic: false, harvestedHoursAgo: 18, chainPrice: 32, chainName: "Rema 1000", available: 35 },
      { id: "nd5", name: "Epler", variety: "Summerred", price: 30, unit: "kg", organic: false, harvestedHoursAgo: 24, chainPrice: 40, chainName: "Rema 1000", available: 25 },
      { id: "nd6", name: "Agurk", price: 14, unit: "stk", organic: false, harvestedHoursAgo: 8, chainPrice: 20, chainName: "Kiwi", available: 50 },
      { id: "nd7", name: "Salat", variety: "Romaine", price: 22, unit: "stk", organic: false, harvestedHoursAgo: 6, chainPrice: 30, chainName: "Rema 1000", available: 20 },
      { id: "nd8", name: "Løk", variety: "Rødløk", price: 18, unit: "kg", organic: false, harvestedHoursAgo: 24, chainPrice: 25, chainName: "Rema 1000", available: 30 },
    ],
  },
];

// ─── Helper Components ────────────────────────────────────────────

function Badge({ children, color = "green" }) {
  const colors = {
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    orange: "bg-orange-100 text-orange-800",
    purple: "bg-purple-100 text-purple-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colors[color]}`}>
      {children}
    </span>
  );
}

function StarRating({ rating }) {
  return (
    <span className="text-yellow-500 text-sm">
      {"★".repeat(Math.floor(rating))}
      {rating % 1 >= 0.5 ? "½" : ""}
      <span className="text-gray-300 ml-1 text-xs">{rating.toFixed(1)}</span>
    </span>
  );
}

function SavingsBadge({ price, chainPrice, chainName }) {
  const pct = Math.round(((chainPrice - price) / chainPrice) * 100);
  if (pct <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 bg-green-50 border border-green-200 text-green-700 text-xs px-2 py-0.5 rounded-full">
      <span>↓</span> {pct}% billigere enn {chainName}
    </span>
  );
}

function FreshnessBadge({ hoursAgo }) {
  if (!hoursAgo) return null;
  if (hoursAgo <= 4)
    return <Badge color="green">Plukket for {hoursAgo}t siden</Badge>;
  if (hoursAgo <= 12)
    return <Badge color="blue">Fersk i dag</Badge>;
  if (hoursAgo <= 24)
    return <Badge color="orange">Levert i dag</Badge>;
  return null;
}

function TypeIcon({ type }) {
  const icons = { farm: "🌾", shop: "🏪", garden: "🌿", cooperative: "🤝" };
  return <span>{icons[type] || "📍"}</span>;
}

// ─── Phone Frame ──────────────────────────────────────────────────

function PhoneFrame({ children }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-green-50 via-white to-emerald-50 p-4">
      <div className="relative w-full max-w-sm">
        <div className="bg-black rounded-[3rem] p-3 shadow-2xl">
          <div className="bg-white rounded-[2.4rem] overflow-hidden relative" style={{ height: "812px" }}>
            {/* Status bar */}
            <div className="bg-white px-8 pt-3 pb-1 flex justify-between items-center text-xs font-semibold text-gray-900 z-50 relative">
              <span>09:41</span>
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-7 bg-black rounded-b-2xl" />
              <div className="flex items-center gap-1">
                <span>5G</span>
                <span>▐▐▐▐</span>
                <span>🔋</span>
              </div>
            </div>
            {/* Content area */}
            <div className="h-full overflow-y-auto pb-24" style={{ maxHeight: "740px" }}>
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Screen: Onboarding ──────────────────────────────────────────

function OnboardingScreen({ onComplete }) {
  const [step, setStep] = useState(0);
  const [prefs, setPrefs] = useState({
    priceSensitivity: 0.7,
    organicPreference: 0.5,
    freshnessWeight: 0.8,
    maxDistanceKm: 10,
    categories: ["vegetables", "fruits"],
  });

  const steps = [
    // Welcome
    () => (
      <div className="px-6 pt-12 text-center">
        <div className="text-6xl mb-6">🥬</div>
        <h1 className="text-3xl font-bold text-gray-900 mb-3">Lokal</h1>
        <p className="text-gray-500 text-lg mb-2">Mat fra nabolaget ditt</p>
        <p className="text-gray-400 text-sm mb-10 leading-relaxed px-4">
          Finn ferske grønnsaker, frukt og lokalprodusert mat fra bønder og butikker nær deg — ofte billigere enn kjedene.
        </p>
        <div className="space-y-3 text-left px-2 mb-10">
          {[
            ["🎯", "Finner mat basert på dine verdier, ikke annonser"],
            ["💰", "Sammenligner priser med Rema, Kiwi, Meny"],
            ["🌱", "Støtter lokale produsenter direkte"],
            ["⚡", "Du får varsel når noe matcher ønskene dine"],
          ].map(([icon, text], i) => (
            <div key={i} className="flex items-start gap-3 py-2">
              <span className="text-xl">{icon}</span>
              <span className="text-gray-700 text-sm">{text}</span>
            </div>
          ))}
        </div>
        <button
          onClick={() => setStep(1)}
          className="w-full bg-green-600 text-white py-3.5 rounded-2xl font-semibold text-base hover:bg-green-700 transition-colors"
        >
          Kom i gang
        </button>
        <p className="text-xs text-gray-400 mt-4">Ingen konto nødvendig for å se tilbud</p>
      </div>
    ),
    // Preferences
    () => (
      <div className="px-6 pt-8">
        <h2 className="text-xl font-bold text-gray-900 mb-1">Hva er viktig for deg?</h2>
        <p className="text-gray-500 text-sm mb-6">
          Vi bruker dette til å finne de beste matchene — ingen annonser, bare dine preferanser.
        </p>

        <div className="space-y-5">
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium text-gray-700">Pris</span>
              <span className="text-xs text-gray-500">
                {prefs.priceSensitivity > 0.7 ? "Lavest mulig" : prefs.priceSensitivity > 0.4 ? "Balansert" : "Kvalitet først"}
              </span>
            </div>
            <input type="range" min="0" max="1" step="0.1" value={prefs.priceSensitivity}
              onChange={e => setPrefs(p => ({ ...p, priceSensitivity: +e.target.value }))}
              className="w-full accent-green-600" />
            <div className="flex justify-between text-xs text-gray-400"><span>Kvalitet</span><span>Pris</span></div>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium text-gray-700">Økologisk</span>
              <span className="text-xs text-gray-500">
                {prefs.organicPreference > 0.7 ? "Helst økologisk" : prefs.organicPreference > 0.3 ? "Gjerne" : "Ikke viktig"}
              </span>
            </div>
            <input type="range" min="0" max="1" step="0.1" value={prefs.organicPreference}
              onChange={e => setPrefs(p => ({ ...p, organicPreference: +e.target.value }))}
              className="w-full accent-green-600" />
            <div className="flex justify-between text-xs text-gray-400"><span>Uansett</span><span>Kun øko</span></div>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium text-gray-700">Ferskhet</span>
              <span className="text-xs text-gray-500">
                {prefs.freshnessWeight > 0.7 ? "Nyplukket!" : prefs.freshnessWeight > 0.4 ? "Gjerne fersk" : "Greit nok"}
              </span>
            </div>
            <input type="range" min="0" max="1" step="0.1" value={prefs.freshnessWeight}
              onChange={e => setPrefs(p => ({ ...p, freshnessWeight: +e.target.value }))}
              className="w-full accent-green-600" />
            <div className="flex justify-between text-xs text-gray-400"><span>Greit nok</span><span>Ferskest</span></div>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium text-gray-700">Maks avstand</span>
              <span className="text-xs text-green-700 font-semibold">{prefs.maxDistanceKm} km</span>
            </div>
            <input type="range" min="1" max="20" step="1" value={prefs.maxDistanceKm}
              onChange={e => setPrefs(p => ({ ...p, maxDistanceKm: +e.target.value }))}
              className="w-full accent-green-600" />
            <div className="flex justify-between text-xs text-gray-400"><span>1 km</span><span>20 km</span></div>
          </div>

          <div>
            <span className="text-sm font-medium text-gray-700 block mb-2">Kategorier</span>
            <div className="flex flex-wrap gap-2">
              {[
                ["vegetables", "Grønnsaker"], ["fruits", "Frukt"], ["berries", "Bær"],
                ["herbs", "Urter"], ["eggs", "Egg"], ["honey", "Honning"],
                ["dairy", "Meieri"], ["bread", "Brød"],
              ].map(([key, label]) => (
                <button key={key}
                  onClick={() => setPrefs(p => ({
                    ...p,
                    categories: p.categories.includes(key)
                      ? p.categories.filter(c => c !== key)
                      : [...p.categories, key]
                  }))}
                  className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                    prefs.categories.includes(key)
                      ? "bg-green-600 text-white border-green-600"
                      : "bg-white text-gray-600 border-gray-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={() => setStep(2)}
          className="w-full bg-green-600 text-white py-3.5 rounded-2xl font-semibold mt-8 hover:bg-green-700 transition-colors"
        >
          Finn lokale tilbud
        </button>
      </div>
    ),
    // Location
    () => (
      <div className="px-6 pt-12 text-center">
        <div className="text-5xl mb-6">📍</div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">Hvor er du?</h2>
        <p className="text-gray-500 text-sm mb-8">
          Vi trenger plasseringen din for å finne produsenter nær deg.
        </p>

        <button
          onClick={() => onComplete(prefs)}
          className="w-full bg-green-600 text-white py-3.5 rounded-2xl font-semibold hover:bg-green-700 transition-colors mb-3"
        >
          Bruk min plassering (Oppsal)
        </button>
        <button
          onClick={() => onComplete(prefs)}
          className="w-full bg-gray-100 text-gray-700 py-3.5 rounded-2xl font-medium"
        >
          Skriv inn adresse
        </button>

        <div className="mt-8 p-4 bg-green-50 rounded-2xl text-left">
          <p className="text-sm text-green-800 font-medium mb-1">Din agent vil:</p>
          <div className="text-xs text-green-700 space-y-1">
            <p>• Skanne lokale produsenter nær Oppsal</p>
            <p>• Sammenligne priser med Rema 1000, Kiwi, Meny</p>
            <p>• Sende deg varsel når noe matcher ønskene dine</p>
          </div>
        </div>
      </div>
    ),
  ];

  return (
    <div className="min-h-full bg-white">
      {steps[step]()}
      {/* Step indicator */}
      <div className="flex justify-center gap-2 py-6">
        {steps.map((_, i) => (
          <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i === step ? "bg-green-600" : "bg-gray-200"}`} />
        ))}
      </div>
    </div>
  );
}

// ─── Screen: Notification Feed ───────────────────────────────────

function NotificationFeed({ producers, onSelectProducer, onOpenCart, cartCount, onStartOver }) {
  const [activeTab, setActiveTab] = useState("feed");
  const [notifications] = useState(() => generateNotifications(producers));

  return (
    <div className="bg-gray-50 min-h-full">
      {/* Header */}
      <div className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <div className="flex justify-between items-center mb-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Lokal</h1>
            <p className="text-xs text-gray-500">Oppsal, Oslo</p>
          </div>
          <div className="flex gap-2">
            <button onClick={onOpenCart} className="relative w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
              <span className="text-lg">🛒</span>
              {cartCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-green-600 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                  {cartCount}
                </span>
              )}
            </button>
            <button onClick={onStartOver} className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center" title="Start over">
              <span className="text-lg">↺</span>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {[
            ["feed", "Varsler"],
            ["nearby", "I nærheten"],
            ["seasonal", "Sesong"],
          ].map(([key, label]) => (
            <button key={key}
              onClick={() => setActiveTab(key)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Feed Content */}
      <div className="px-4 py-3 space-y-3">
        {activeTab === "feed" && (
          <>
            {/* Active alert */}
            <div className="bg-gradient-to-r from-green-600 to-emerald-600 rounded-2xl p-4 text-white">
              <div className="flex items-start gap-3">
                <span className="text-2xl">🎯</span>
                <div className="flex-1">
                  <p className="font-semibold text-sm">3 nye treff i dag!</p>
                  <p className="text-green-100 text-xs mt-0.5">
                    Basert på dine preferanser fant agenten din ferske tilbud som matcher det du liker.
                  </p>
                </div>
              </div>
            </div>

            {/* Notification cards */}
            {notifications.map((notif, i) => (
              <NotificationCard key={i} notification={notif} onTap={() => {
                const p = producers.find(p => p.id === notif.producerId);
                if (p) onSelectProducer(p);
              }} />
            ))}

            {/* Coming soon: Community */}
            <div className="bg-purple-50 border border-purple-200 rounded-2xl p-4 mt-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl">👥</span>
                <div>
                  <p className="font-semibold text-sm text-purple-900">Lokal Fellesskap</p>
                  <p className="text-purple-700 text-xs mt-0.5">
                    Snart: Se hva naboene dine handler. Del oppskrifter. Felles bestillinger for bedre priser.
                  </p>
                  <Badge color="purple">Kommer snart</Badge>
                </div>
              </div>
            </div>

            {/* Coming soon: Weekly box */}
            <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl">📦</span>
                <div>
                  <p className="font-semibold text-sm text-orange-900">Ukeskasse</p>
                  <p className="text-orange-700 text-xs mt-0.5">
                    Snart: La agenten din sette sammen en ukentlig grønnsakskasse basert på hva som er fersk og billig akkurat nå.
                  </p>
                  <Badge color="orange">Kommer snart</Badge>
                </div>
              </div>
            </div>
          </>
        )}

        {activeTab === "nearby" && (
          <div className="space-y-3">
            {/* Map placeholder */}
            <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-center">
              <span className="text-3xl">🗺️</span>
              <p className="text-sm text-green-800 font-medium mt-2">Kart over produsenter</p>
              <p className="text-xs text-green-600 mt-1">6 produsenter innen 10 km fra Oppsal</p>
            </div>

            {/* Producer list sorted by distance */}
            {[...producers].sort((a, b) => a.distance - b.distance).map(p => (
              <button key={p.id}
                onClick={() => onSelectProducer(p)}
                className="w-full bg-white rounded-2xl p-4 text-left shadow-sm border border-gray-100 hover:border-green-200 transition-colors"
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <TypeIcon type={p.type} />
                      <span className="font-semibold text-sm text-gray-900">{p.name}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{p.district} · {p.distance} km unna</p>
                    <p className="text-xs text-gray-400 mt-0.5">{p.openToday}</p>
                  </div>
                  <div className="text-right">
                    <StarRating rating={p.rating} />
                    <p className="text-xs text-gray-400 mt-1">{p.products.length} produkter</p>
                  </div>
                </div>
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  {p.tags.slice(0, 3).map(t => (
                    <Badge key={t} color="gray">{t}</Badge>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}

        {activeTab === "seasonal" && (
          <div className="space-y-4">
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <h3 className="font-semibold text-sm text-gray-900 mb-2">🍓 Mars – Hva er i sesong?</h3>
              <div className="space-y-2">
                {[
                  ["Nypoteter", "Sesongstart — nå fra andelsgårder", "green"],
                  ["Jordbær", "Tidlige norske jordbær fra drivhus", "red"],
                  ["Grønnkål", "Siste innhøsting av vintergrønnkål", "green"],
                  ["Urter", "Basilikum og persille fra byhager", "green"],
                ].map(([name, desc, color], i) => (
                  <div key={i} className="flex items-center gap-3 py-1">
                    <div className={`w-2 h-2 rounded-full ${color === "red" ? "bg-red-400" : "bg-green-500"}`} />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{name}</p>
                      <p className="text-xs text-gray-500">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Seasonal alert setup */}
            <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl">🔔</span>
                <div>
                  <p className="font-semibold text-sm text-yellow-900">Sesongvarsler</p>
                  <p className="text-yellow-700 text-xs mt-0.5">
                    Snart: Agenten din varsler deg når favorittprodukter er i sesong og tilgjengelig nær deg.
                  </p>
                  <Badge color="orange">Kommer snart</Badge>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-6 py-2 flex justify-around" style={{ maxWidth: "375px", margin: "0 auto" }}>
        {[
          ["feed", "Hjem", "🏠"],
          ["nearby", "Nærme", "📍"],
          ["seasonal", "Sesong", "🌿"],
          ["orders", "Ordre", "📋"],
        ].map(([key, label, icon]) => (
          <button key={key} onClick={() => setActiveTab(key)} className="flex flex-col items-center py-1">
            <span className="text-xl">{icon}</span>
            <span className={`text-xs mt-0.5 ${activeTab === key ? "text-green-600 font-semibold" : "text-gray-400"}`}>
              {label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Notification Card ───────────────────────────────────────────

function NotificationCard({ notification, onTap }) {
  const { type, title, body, time, producer, product, savings } = notification;

  const icons = {
    match: "🎯", price: "💰", fresh: "🌱", lowStock: "⚠️", ready: "✅",
  };

  return (
    <button onClick={onTap} className="w-full bg-white rounded-2xl p-4 text-left shadow-sm border border-gray-100 hover:border-green-200 transition-all">
      <div className="flex gap-3">
        <div className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center text-xl flex-shrink-0">
          {icons[type] || "📬"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start">
            <p className="font-semibold text-sm text-gray-900">{title}</p>
            <span className="text-xs text-gray-400 flex-shrink-0 ml-2">{time}</span>
          </div>
          <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{body}</p>
          {savings && (
            <div className="mt-2">
              <SavingsBadge price={savings.local} chainPrice={savings.chain} chainName={savings.chainName} />
            </div>
          )}
          {product && (
            <div className="flex gap-1.5 mt-2">
              <Badge color="green">{product}</Badge>
              {producer && <Badge color="gray">{producer}</Badge>}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Screen: Producer Detail ─────────────────────────────────────

function ProducerDetail({ producer, onBack, onAddToCart, cart }) {
  return (
    <div className="bg-gray-50 min-h-full">
      {/* Header */}
      <div className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
        <button onClick={onBack} className="flex items-center gap-1 text-green-600 text-sm font-medium mb-3">
          ← Tilbake
        </button>
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2">
              <TypeIcon type={producer.type} />
              <h2 className="text-lg font-bold text-gray-900">{producer.name}</h2>
            </div>
            <p className="text-sm text-gray-500 mt-0.5">{producer.district} · {producer.distance} km</p>
          </div>
          <div className="text-right">
            <StarRating rating={producer.rating} />
            <p className="text-xs text-gray-400">{producer.totalTransactions} handler</p>
          </div>
        </div>
        <p className="text-sm text-gray-600 mt-2">{producer.description}</p>

        <div className="flex gap-2 mt-3 flex-wrap">
          {producer.certifications.map(c => (
            <Badge key={c} color="green">{c}</Badge>
          ))}
          {producer.tags.map(t => (
            <Badge key={t} color="gray">{t}</Badge>
          ))}
        </div>

        <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
          <span>📍 {producer.openToday}</span>
          <span>🛡️ Tillit: {Math.round(producer.trustScore * 100)}%</span>
        </div>
      </div>

      {/* Products */}
      <div className="px-4 py-3">
        <h3 className="font-semibold text-sm text-gray-900 mb-3">
          Tilgjengelig nå ({producer.products.length} produkter)
        </h3>
        <div className="space-y-3">
          {producer.products.map(product => {
            const inCart = cart.find(c => c.product.id === product.id);
            return (
              <div key={product.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <p className="font-semibold text-sm text-gray-900">
                      {product.name}
                      {product.variety && <span className="font-normal text-gray-500"> · {product.variety}</span>}
                    </p>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className="text-lg font-bold text-green-700">{product.price} kr</span>
                      <span className="text-xs text-gray-400">/ {product.unit}</span>
                      {product.chainPrice && (
                        <span className="text-xs text-gray-400 line-through">{product.chainPrice} kr</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {inCart ? (
                      <div className="flex items-center gap-2 bg-green-50 rounded-xl px-2 py-1">
                        <button onClick={() => onAddToCart(product, producer, -1)} className="w-7 h-7 rounded-full bg-white text-green-700 font-bold border border-green-200 flex items-center justify-center">−</button>
                        <span className="text-sm font-semibold text-green-700 w-6 text-center">{inCart.quantity}</span>
                        <button onClick={() => onAddToCart(product, producer, 1)} className="w-7 h-7 rounded-full bg-green-600 text-white font-bold flex items-center justify-center">+</button>
                      </div>
                    ) : (
                      <button onClick={() => onAddToCart(product, producer, 1)}
                        className="bg-green-600 text-white text-xs font-semibold px-4 py-2 rounded-xl hover:bg-green-700 transition-colors">
                        Legg til
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  <FreshnessBadge hoursAgo={product.harvestedHoursAgo} />
                  {product.organic && <Badge color="green">Økologisk</Badge>}
                  <SavingsBadge price={product.price} chainPrice={product.chainPrice} chainName={product.chainName} />
                </div>
                <p className="text-xs text-gray-400 mt-1">{product.available} {product.unit} tilgjengelig</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Screen: Cart / Reservation ──────────────────────────────────

function CartScreen({ cart, onBack, onUpdateQuantity, onReserve }) {
  const [fulfillment, setFulfillment] = useState("pickup");
  const [pickupTime, setPickupTime] = useState("16:00");
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Group by producer
  const grouped = {};
  cart.forEach(item => {
    if (!grouped[item.producer.id]) {
      grouped[item.producer.id] = { producer: item.producer, items: [] };
    }
    grouped[item.producer.id].items.push(item);
  });

  const totalAmount = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const totalChainAmount = cart.reduce((sum, item) => sum + (item.product.chainPrice || item.product.price) * item.quantity, 0);
  const totalSavings = totalChainAmount - totalAmount;

  if (cart.length === 0) {
    return (
      <div className="bg-gray-50 min-h-full">
        <div className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
          <button onClick={onBack} className="flex items-center gap-1 text-green-600 text-sm font-medium">← Tilbake</button>
        </div>
        <div className="px-6 pt-20 text-center">
          <span className="text-5xl">🛒</span>
          <p className="text-gray-500 mt-4">Handlekurven er tom</p>
          <p className="text-gray-400 text-sm mt-1">Finn produkter fra lokale produsenter</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 min-h-full pb-8">
      <div className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
        <button onClick={onBack} className="flex items-center gap-1 text-green-600 text-sm font-medium mb-2">← Tilbake</button>
        <h2 className="text-lg font-bold text-gray-900">Reservasjon</h2>
        <p className="text-xs text-gray-500">
          Reserver varer hos lokale produsenter — de bekrefter og gjør klart for deg.
        </p>
      </div>

      <div className="px-4 py-3 space-y-4">
        {Object.values(grouped).map(({ producer, items }) => (
          <div key={producer.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 mb-3">
              <TypeIcon type={producer.type} />
              <span className="font-semibold text-sm text-gray-900">{producer.name}</span>
              <span className="text-xs text-gray-400">{producer.district}</span>
            </div>
            {items.map(({ product, quantity }) => (
              <div key={product.id} className="flex justify-between items-center py-2 border-t border-gray-50">
                <div>
                  <p className="text-sm text-gray-800">
                    {product.name}
                    {product.variety && <span className="text-gray-400"> ({product.variety})</span>}
                  </p>
                  <p className="text-xs text-gray-500">{product.price} kr / {product.unit}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => onUpdateQuantity(product.id, -1)} className="w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-sm flex items-center justify-center">−</button>
                  <span className="text-sm font-semibold w-6 text-center">{quantity}</span>
                  <button onClick={() => onUpdateQuantity(product.id, 1)} className="w-6 h-6 rounded-full bg-green-100 text-green-700 text-sm flex items-center justify-center">+</button>
                  <span className="text-sm font-semibold text-gray-900 ml-2 w-16 text-right">
                    {product.price * quantity} kr
                  </span>
                </div>
              </div>
            ))}
          </div>
        ))}

        {/* Fulfillment */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <p className="font-semibold text-sm text-gray-900 mb-2">Henting</p>
          <div className="flex gap-2 mb-3">
            <button onClick={() => setFulfillment("pickup")}
              className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${
                fulfillment === "pickup" ? "bg-green-50 border-green-300 text-green-700" : "border-gray-200 text-gray-500"
              }`}>
              🚶 Henter selv
            </button>
            <button onClick={() => setFulfillment("delivery")}
              className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${
                fulfillment === "delivery" ? "bg-green-50 border-green-300 text-green-700" : "border-gray-200 text-gray-500"
              }`}>
              🚲 Levering
            </button>
          </div>
          {fulfillment === "pickup" && (
            <div>
              <label className="text-xs text-gray-500 block mb-1">Hentetid</label>
              <select value={pickupTime} onChange={e => setPickupTime(e.target.value)}
                className="w-full border border-gray-200 rounded-xl py-2 px-3 text-sm bg-white">
                <option value="12:00">12:00</option>
                <option value="14:00">14:00</option>
                <option value="16:00">16:00</option>
                <option value="18:00">18:00</option>
              </select>
            </div>
          )}
          <div className="mt-3">
            <label className="text-xs text-gray-500 block mb-1">Melding til produsent (valgfritt)</label>
            <input type="text" value={note} onChange={e => setNote(e.target.value)}
              placeholder="F.eks. «Kan hente litt senere»"
              className="w-full border border-gray-200 rounded-xl py-2 px-3 text-sm" />
          </div>
        </div>

        {/* Total */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Totalt</span>
            <span className="font-bold text-gray-900">{totalAmount} kr</span>
          </div>
          {totalSavings > 0 && (
            <div className="flex justify-between text-sm mt-1">
              <span className="text-green-600">Du sparer vs. kjedene</span>
              <span className="font-bold text-green-600">−{Math.round(totalSavings)} kr</span>
            </div>
          )}
          <div className="mt-2 text-xs text-gray-400">
            Betaling skjer ved henting. Ingen forskuddsbetaling.
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={() => {
            setIsSubmitting(true);
            setTimeout(() => onReserve({ fulfillment, pickupTime, note }), 1200);
          }}
          disabled={isSubmitting}
          className={`w-full py-3.5 rounded-2xl font-semibold text-base transition-colors ${
            isSubmitting ? "bg-gray-300 text-gray-500" : "bg-green-600 text-white hover:bg-green-700"
          }`}
        >
          {isSubmitting ? "Sender til produsent..." : `Reserver (${totalAmount} kr)`}
        </button>

        {/* A2A explainer */}
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <span className="text-xl">🤖</span>
            <div>
              <p className="font-semibold text-xs text-blue-900">Hvordan fungerer det?</p>
              <p className="text-blue-700 text-xs mt-0.5 leading-relaxed">
                Din agent sender reservasjonen til produsentens agent via A2A-protokollen.
                Du får varsel når produsenten bekrefter, og igjen når ordren er klar for henting.
                Alt skjer automatisk — du trenger ikke ringe eller sende meldinger.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Screen: Reservation Confirmed ──────────────────────────────

function ReservationConfirmed({ cart, reservationDetails, onBackToFeed }) {
  const [status, setStatus] = useState("requested");
  const [timeline, setTimeline] = useState([
    { status: "requested", label: "Reservasjon sendt", time: "Nå", active: true },
    { status: "confirmed", label: "Produsent bekrefter", time: "", active: false },
    { status: "ready", label: "Klar for henting", time: "", active: false },
    { status: "completed", label: "Hentet!", time: "", active: false },
  ]);

  // Simulate producer confirmation after 3s
  useEffect(() => {
    const t1 = setTimeout(() => {
      setStatus("confirmed");
      setTimeline(prev => prev.map((t, i) =>
        i === 1 ? { ...t, active: true, time: "Om 2 min" } : t
      ));
    }, 3000);

    const t2 = setTimeout(() => {
      setStatus("ready");
      setTimeline(prev => prev.map((t, i) =>
        i === 2 ? { ...t, active: true, time: "Om 45 min" } : t
      ));
    }, 6000);

    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const totalAmount = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

  return (
    <div className="bg-gray-50 min-h-full">
      <div className="bg-gradient-to-b from-green-600 to-green-700 px-6 pt-10 pb-8 text-center text-white">
        <div className="text-4xl mb-3">
          {status === "requested" ? "⏳" : status === "confirmed" ? "✅" : "🎉"}
        </div>
        <h2 className="text-xl font-bold">
          {status === "requested" ? "Reservasjon sendt!" :
           status === "confirmed" ? "Bekreftet av produsent!" :
           "Klar for henting!"}
        </h2>
        <p className="text-green-100 text-sm mt-1">{totalAmount} kr · Henting kl {reservationDetails.pickupTime}</p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Timeline */}
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <div className="space-y-4">
            {timeline.map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                    step.active ? "bg-green-600 text-white" : "bg-gray-200 text-gray-400"
                  }`}>
                    {step.active ? "✓" : i + 1}
                  </div>
                  {i < timeline.length - 1 && (
                    <div className={`w-0.5 h-6 mt-1 ${step.active ? "bg-green-300" : "bg-gray-200"}`} />
                  )}
                </div>
                <div>
                  <p className={`text-sm font-medium ${step.active ? "text-gray-900" : "text-gray-400"}`}>
                    {step.label}
                  </p>
                  {step.time && <p className="text-xs text-gray-400">{step.time}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Items summary */}
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="font-semibold text-sm text-gray-900 mb-2">Din bestilling</p>
          {cart.map(({ product, quantity, producer }) => (
            <div key={product.id} className="flex justify-between py-1.5 text-sm">
              <span className="text-gray-600">
                {quantity}x {product.name}
                {product.variety ? ` (${product.variety})` : ""}
                <span className="text-gray-400 text-xs ml-1">— {producer.name}</span>
              </span>
              <span className="font-medium text-gray-900">{product.price * quantity} kr</span>
            </div>
          ))}
        </div>

        {/* Live notification simulation */}
        {status === "confirmed" && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-4 animate-pulse">
            <div className="flex items-start gap-3">
              <span className="text-xl">🔔</span>
              <div>
                <p className="font-semibold text-sm text-green-900">Produsenten jobber med bestillingen!</p>
                <p className="text-green-700 text-xs mt-0.5">
                  «Flott! Vi pakker varene dine nå. Står klart ved inngangen kl {reservationDetails.pickupTime}.»
                </p>
              </div>
            </div>
          </div>
        )}

        {status === "ready" && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-4">
            <div className="flex items-start gap-3">
              <span className="text-xl">📍</span>
              <div>
                <p className="font-semibold text-sm text-yellow-900">Klar for henting!</p>
                <p className="text-yellow-700 text-xs mt-0.5">
                  Varene dine står klart. Vis denne skjermen ved henting.
                </p>
                <div className="mt-2 bg-white rounded-xl p-3 border border-yellow-200">
                  <p className="text-xs text-gray-500">Hentekode</p>
                  <p className="text-2xl font-mono font-bold text-gray-900 tracking-wider">LKL-{Math.random().toString(36).substr(2, 4).toUpperCase()}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Coming soon: Rating */}
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <span className="text-xl">⭐</span>
            <div>
              <p className="font-semibold text-xs text-gray-600">Etter henting</p>
              <p className="text-gray-500 text-xs mt-0.5">
                Snart: Vurder opplevelsen — tillitsscoren oppdateres og hjelper andre forbrukere.
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={onBackToFeed}
          className="w-full bg-white border border-gray-200 text-gray-700 py-3 rounded-2xl font-medium text-sm"
        >
          Tilbake til forsiden
        </button>
      </div>
    </div>
  );
}

// ─── Generate Notifications ──────────────────────────────────────

function generateNotifications(producers) {
  return [
    {
      type: "match",
      title: "Cherrytomater 38% billigere!",
      body: "Nordlys Dagligvarer på Oppsal har cherrytomater til 32 kr/kg — 0.8 km unna deg.",
      time: "2 min",
      producerId: "p6",
      product: "Tomater (Cherry)",
      producer: "Nordlys Dagligvarer",
      savings: { local: 32, chain: 52, chainName: "Kiwi" },
    },
    {
      type: "fresh",
      title: "Nyplukket basilikum!",
      body: "Løkka Honning har basilikum plukket for 1 time siden. Økologisk, 20 kr/bunt.",
      time: "14 min",
      producerId: "p3",
      product: "Basilikum",
      producer: "Løkka Honning & Urter",
    },
    {
      type: "price",
      title: "Nypoteter 40% under Rema-pris",
      body: "Nordre Åker Andelsgård selger økologiske nypoteter til 18 kr/kg. Rema tar 30 kr.",
      time: "28 min",
      producerId: "p4",
      product: "Nypoteter",
      producer: "Nordre Åker Andelsgård",
      savings: { local: 18, chain: 30, chainName: "Rema 1000" },
    },
    {
      type: "match",
      title: "Gravenstein-epler fra Bygdøy",
      body: "80 kg tilgjengelig til 28 kr/kg. Plukket i dag — 33% billigere enn i butikken.",
      time: "1t",
      producerId: "p5",
      product: "Epler (Gravenstein)",
      producer: "Bygdøy Frukt & Bær",
      savings: { local: 28, chain: 42, chainName: "Rema 1000" },
    },
    {
      type: "lowStock",
      title: "Kun 8 glass honning igjen!",
      body: "Lokal honning fra Grünerløkka — 120 kr, 14% under Meny-pris. Snart utsolgt.",
      time: "2t",
      producerId: "p3",
      product: "Lokal honning",
      producer: "Løkka Honning & Urter",
      savings: { local: 120, chain: 140, chainName: "Meny" },
    },
    {
      type: "fresh",
      title: "Økologiske tomater fra Aker Gård",
      body: "Frilandstomater plukket for 3 timer siden. 35 kr/kg — 22% under Rema 1000 øko-pris.",
      time: "3t",
      producerId: "p1",
      product: "Tomater",
      producer: "Aker Gård",
      savings: { local: 35, chain: 65, chainName: "Rema 1000 (øko)" },
    },
  ];
}

// ─── Role Switcher ───────────────────────────────────────────────

function RoleSwitcher({ role, onSwitch }) {
  return (
    <div className="flex bg-gray-100 rounded-2xl p-1 mx-4 mb-2">
      <button
        onClick={() => onSwitch("consumer")}
        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
          role === "consumer"
            ? "bg-white text-green-700 shadow-sm"
            : "text-gray-400"
        }`}
      >
        🛒 Kunde
      </button>
      <button
        onClick={() => onSwitch("producer")}
        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${
          role === "producer"
            ? "bg-white text-amber-700 shadow-sm"
            : "text-gray-400"
        }`}
      >
        🌾 Selger
      </button>
    </div>
  );
}

// ─── Producer: Onboarding ────────────────────────────────────────

function ProducerOnboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [shop, setShop] = useState({
    name: "",
    type: "shop",
    district: "",
    description: "",
  });

  const steps = [
    () => (
      <div className="px-6 pt-12 text-center">
        <div className="text-6xl mb-6">🌾</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-3">Selg lokalt med Lokal</h1>
        <p className="text-gray-500 text-sm mb-8 leading-relaxed px-4">
          Nå kundene dine direkte. Ta bilde av varene, sett priser, og motta reservasjoner — alt fra telefonen.
        </p>
        <div className="space-y-3 text-left px-2 mb-10">
          {[
            ["📸", "Ta bilde av varene — AI gjenkjenner og legger dem til"],
            ["💬", "Kunder finner deg basert på verdier, ikke annonser"],
            ["📋", "Motta reservasjoner direkte — bekreft med ett trykk"],
            ["📊", "Se hva som selger og hva kundene dine leter etter"],
          ].map(([icon, text], i) => (
            <div key={i} className="flex items-start gap-3 py-2">
              <span className="text-xl">{icon}</span>
              <span className="text-gray-700 text-sm">{text}</span>
            </div>
          ))}
        </div>
        <button
          onClick={() => setStep(1)}
          className="w-full bg-amber-600 text-white py-3.5 rounded-2xl font-semibold hover:bg-amber-700 transition-colors"
        >
          Registrer butikken din
        </button>
        <p className="text-xs text-gray-400 mt-4">Gratis å bruke. Ingen bindingstid.</p>
      </div>
    ),
    () => (
      <div className="px-6 pt-8">
        <h2 className="text-xl font-bold text-gray-900 mb-1">Om din butikk</h2>
        <p className="text-gray-500 text-sm mb-6">Fyll inn det grunnleggende — du kan endre alt senere.</p>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Navn</label>
            <input type="text" value={shop.name} onChange={e => setShop(s => ({ ...s, name: e.target.value }))}
              placeholder="F.eks. «Nordlys Dagligvarer»"
              className="w-full border border-gray-200 rounded-xl py-2.5 px-3 text-sm" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Type</label>
            <div className="flex flex-wrap gap-2">
              {[
                ["shop", "🏪 Butikk"],
                ["farm", "🌾 Gård"],
                ["garden", "🌿 Hage"],
                ["cooperative", "🤝 Andel"],
              ].map(([key, label]) => (
                <button key={key}
                  onClick={() => setShop(s => ({ ...s, type: key }))}
                  className={`px-3 py-2 rounded-xl text-sm border transition-colors ${
                    shop.type === key
                      ? "bg-amber-50 border-amber-300 text-amber-800"
                      : "bg-white border-gray-200 text-gray-600"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Bydel / sted</label>
            <input type="text" value={shop.district} onChange={e => setShop(s => ({ ...s, district: e.target.value }))}
              placeholder="F.eks. «Oppsal» eller «Bygdøy»"
              className="w-full border border-gray-200 rounded-xl py-2.5 px-3 text-sm" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">Kort beskrivelse</label>
            <textarea value={shop.description} onChange={e => setShop(s => ({ ...s, description: e.target.value }))}
              placeholder="Hva gjør din butikk/gård spesiell?"
              rows={3}
              className="w-full border border-gray-200 rounded-xl py-2.5 px-3 text-sm resize-none" />
          </div>
        </div>

        <button
          onClick={() => onComplete(shop)}
          className="w-full bg-amber-600 text-white py-3.5 rounded-2xl font-semibold mt-6 hover:bg-amber-700 transition-colors"
        >
          Start — legg til varer
        </button>
      </div>
    ),
  ];

  return (
    <div className="min-h-full bg-white">
      {steps[step]()}
      <div className="flex justify-center gap-2 py-6">
        {steps.map((_, i) => (
          <div key={i} className={`w-2 h-2 rounded-full ${i === step ? "bg-amber-600" : "bg-gray-200"}`} />
        ))}
      </div>
    </div>
  );
}

// ─── Producer: Dashboard ─────────────────────────────────────────

function ProducerDashboard({ shop, products, reservations, onNavigate, onStartOver }) {
  const activeProducts = products.filter(p => p.available > 0);
  const pendingReservations = reservations.filter(r => r.status === "requested");
  const confirmedReservations = reservations.filter(r => r.status === "confirmed" || r.status === "ready");
  const todayRevenue = reservations
    .filter(r => r.status === "completed")
    .reduce((sum, r) => sum + r.total, 0);

  return (
    <div className="bg-gray-50 min-h-full">
      {/* Header */}
      <div className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <div className="flex justify-between items-center mb-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{shop.name || "Min butikk"}</h1>
            <p className="text-xs text-gray-500">{shop.district || "Oslo"} · Selger-modus</p>
          </div>
          <button onClick={onStartOver} className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center" title="Start over">
            <span className="text-lg">↺</span>
          </button>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-white rounded-2xl p-3 text-center shadow-sm border border-gray-100">
            <p className="text-2xl font-bold text-amber-600">{activeProducts.length}</p>
            <p className="text-xs text-gray-500">Aktive varer</p>
          </div>
          <div className="bg-white rounded-2xl p-3 text-center shadow-sm border border-gray-100">
            <p className="text-2xl font-bold text-red-500">{pendingReservations.length}</p>
            <p className="text-xs text-gray-500">Venter svar</p>
          </div>
          <div className="bg-white rounded-2xl p-3 text-center shadow-sm border border-gray-100">
            <p className="text-2xl font-bold text-green-600">{todayRevenue} kr</p>
            <p className="text-xs text-gray-500">I dag</p>
          </div>
        </div>

        {/* Pending reservations alert */}
        {pendingReservations.length > 0 && (
          <button onClick={() => onNavigate("reservations")}
            className="w-full bg-red-50 border border-red-200 rounded-2xl p-4 text-left">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔔</span>
              <div className="flex-1">
                <p className="font-semibold text-sm text-red-900">
                  {pendingReservations.length} nye reservasjoner!
                </p>
                <p className="text-red-700 text-xs mt-0.5">
                  Trykk for å se og bekrefte bestillinger.
                </p>
              </div>
              <span className="text-gray-400">→</span>
            </div>
          </button>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => onNavigate("upload")}
            className="bg-amber-600 text-white rounded-2xl p-4 text-left hover:bg-amber-700 transition-colors">
            <span className="text-2xl block mb-2">📸</span>
            <p className="font-semibold text-sm">Last opp varer</p>
            <p className="text-amber-200 text-xs mt-0.5">Bilde eller video</p>
          </button>
          <button onClick={() => onNavigate("products")}
            className="bg-white rounded-2xl p-4 text-left shadow-sm border border-gray-100 hover:border-amber-200 transition-colors">
            <span className="text-2xl block mb-2">📦</span>
            <p className="font-semibold text-sm text-gray-900">Mine varer</p>
            <p className="text-gray-500 text-xs mt-0.5">{products.length} produkter</p>
          </button>
          <button onClick={() => onNavigate("reservations")}
            className="bg-white rounded-2xl p-4 text-left shadow-sm border border-gray-100 hover:border-amber-200 transition-colors">
            <span className="text-2xl block mb-2">📋</span>
            <p className="font-semibold text-sm text-gray-900">Reservasjoner</p>
            <p className="text-gray-500 text-xs mt-0.5">{confirmedReservations.length} aktive</p>
          </button>
          <button onClick={() => onNavigate("quickprice")}
            className="bg-white rounded-2xl p-4 text-left shadow-sm border border-gray-100 hover:border-amber-200 transition-colors">
            <span className="text-2xl block mb-2">💰</span>
            <p className="font-semibold text-sm text-gray-900">Oppdater pris</p>
            <p className="text-gray-500 text-xs mt-0.5">Rask endring</p>
          </button>
        </div>

        {/* Confirmed orders ready for action */}
        {confirmedReservations.length > 0 && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h3 className="font-semibold text-sm text-gray-900 mb-2">Aktive bestillinger</h3>
            {confirmedReservations.map(r => (
              <div key={r.id} className="flex items-center justify-between py-2 border-t border-gray-50">
                <div>
                  <p className="text-sm text-gray-800">{r.customerName}</p>
                  <p className="text-xs text-gray-500">{r.items} · {r.total} kr · Henting kl {r.pickupTime}</p>
                </div>
                <Badge color={r.status === "ready" ? "green" : "blue"}>
                  {r.status === "ready" ? "Klar" : "Bekreftet"}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {/* Coming soon: Insights */}
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
          <div className="flex items-start gap-3">
            <span className="text-xl">📊</span>
            <div>
              <p className="font-semibold text-sm text-blue-900">Innsikt</p>
              <p className="text-blue-700 text-xs mt-0.5">
                Snart: Se hvilke varer kundene i nabolaget ditt leter etter, trender og etterspørsel i sanntid.
              </p>
              <Badge color="blue">Kommer snart</Badge>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-6 py-2 flex justify-around" style={{ maxWidth: "375px", margin: "0 auto" }}>
        {[
          ["dashboard", "Hjem", "🏠"],
          ["products", "Varer", "📦"],
          ["upload", "Last opp", "📸"],
          ["reservations", "Ordre", "📋"],
        ].map(([key, label, icon]) => (
          <button key={key} onClick={() => onNavigate(key)} className="flex flex-col items-center py-1">
            <span className="text-xl">{icon}</span>
            <span className="text-xs mt-0.5 text-gray-400">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Producer: Upload Screen ─────────────────────────────────────

function ProducerUpload({ products, onAddProducts, onBack }) {
  const [mode, setMode] = useState(null); // null | photo | video | manual
  const [isScanning, setIsScanning] = useState(false);
  const [scanResults, setScanResults] = useState(null);
  const [manualProduct, setManualProduct] = useState({ name: "", price: "", unit: "kg", category: "vegetables" });

  const simulateScan = () => {
    setIsScanning(true);
    setTimeout(() => {
      setIsScanning(false);
      setScanResults([
        { name: "Tomater", variety: "Cherry", price: 32, unit: "kg", confidence: 0.94, quantity: 30 },
        { name: "Agurk", variety: null, price: 14, unit: "stk", confidence: 0.91, quantity: 50 },
        { name: "Paprika", variety: "Rød", price: 28, unit: "stk", confidence: 0.87, quantity: 20 },
      ]);
    }, 2500);
  };

  return (
    <div className="bg-gray-50 min-h-full">
      <div className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
        <button onClick={onBack} className="flex items-center gap-1 text-amber-600 text-sm font-medium mb-2">
          ← Tilbake
        </button>
        <h2 className="text-lg font-bold text-gray-900">Legg til varer</h2>
        <p className="text-xs text-gray-500">Ta bilde, film, eller legg til manuelt</p>
      </div>

      <div className="px-4 py-3 space-y-3">
        {!mode && !scanResults && (
          <>
            {/* Upload options */}
            <button onClick={() => { setMode("photo"); simulateScan(); }}
              className="w-full bg-amber-600 text-white rounded-2xl p-5 text-left hover:bg-amber-700 transition-colors">
              <div className="flex items-center gap-4">
                <span className="text-3xl">📸</span>
                <div>
                  <p className="font-semibold text-base">Ta bilde</p>
                  <p className="text-amber-200 text-sm mt-0.5">AI gjenkjenner varer, sorter og mengder</p>
                </div>
              </div>
            </button>

            <button onClick={() => { setMode("video"); simulateScan(); }}
              className="w-full bg-white rounded-2xl p-5 text-left shadow-sm border border-gray-100 hover:border-amber-200 transition-colors">
              <div className="flex items-center gap-4">
                <span className="text-3xl">🎬</span>
                <div>
                  <p className="font-semibold text-base text-gray-900">Film varene</p>
                  <p className="text-gray-500 text-sm mt-0.5">Panorér over disken — alt fanges opp</p>
                </div>
              </div>
            </button>

            <button onClick={() => setMode("manual")}
              className="w-full bg-white rounded-2xl p-5 text-left shadow-sm border border-gray-100 hover:border-amber-200 transition-colors">
              <div className="flex items-center gap-4">
                <span className="text-3xl">✏️</span>
                <div>
                  <p className="font-semibold text-base text-gray-900">Legg til manuelt</p>
                  <p className="text-gray-500 text-sm mt-0.5">Skriv inn varer, priser og mengder</p>
                </div>
              </div>
            </button>

            {/* Existing products count */}
            {products.length > 0 && (
              <div className="bg-gray-50 rounded-2xl p-3 text-center">
                <p className="text-xs text-gray-500">Du har {products.length} varer registrert</p>
              </div>
            )}
          </>
        )}

        {/* Scanning animation */}
        {isScanning && (
          <div className="text-center py-16">
            <div className="text-5xl mb-6 animate-pulse">
              {mode === "photo" ? "📸" : "🎬"}
            </div>
            <p className="text-lg font-semibold text-gray-900">Analyserer...</p>
            <p className="text-sm text-gray-500 mt-1">AI gjenkjenner varer og priser</p>
            <div className="mt-6 mx-auto w-48 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full animate-pulse" style={{ width: "60%" }} />
            </div>
            <div className="mt-6 space-y-2 text-xs text-gray-400">
              <p className="animate-pulse">Fant tomater...</p>
              <p className="animate-pulse" style={{ animationDelay: "0.5s" }}>Gjenkjenner sorter...</p>
              <p className="animate-pulse" style={{ animationDelay: "1s" }}>Estimerer mengder...</p>
            </div>
          </div>
        )}

        {/* Scan results */}
        {scanResults && (
          <>
            <div className="bg-green-50 border border-green-200 rounded-2xl p-4">
              <div className="flex items-center gap-2">
                <span className="text-xl">✅</span>
                <div>
                  <p className="font-semibold text-sm text-green-900">
                    {scanResults.length} varer gjenkjent!
                  </p>
                  <p className="text-green-700 text-xs">Juster priser og mengder, trykk godkjenn.</p>
                </div>
              </div>
            </div>

            {scanResults.map((item, i) => (
              <div key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-sm text-gray-900">
                      {item.name}
                      {item.variety && <span className="font-normal text-gray-500"> · {item.variety}</span>}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge color={item.confidence > 0.9 ? "green" : "orange"}>
                        {Math.round(item.confidence * 100)}% sikker
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <input type="number" value={item.price}
                      onChange={e => {
                        const updated = [...scanResults];
                        updated[i] = { ...item, price: +e.target.value };
                        setScanResults(updated);
                      }}
                      className="w-16 border border-gray-200 rounded-lg py-1 px-2 text-sm text-right" />
                    <span className="text-xs text-gray-500">kr/{item.unit}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-xs text-gray-500">Antall:</span>
                  <input type="number" value={item.quantity}
                    onChange={e => {
                      const updated = [...scanResults];
                      updated[i] = { ...item, quantity: +e.target.value };
                      setScanResults(updated);
                    }}
                    className="w-16 border border-gray-200 rounded-lg py-1 px-2 text-sm" />
                  <span className="text-xs text-gray-500">{item.unit}</span>
                </div>
              </div>
            ))}

            <button
              onClick={() => {
                onAddProducts(scanResults);
                setScanResults(null);
                setMode(null);
              }}
              className="w-full bg-amber-600 text-white py-3.5 rounded-2xl font-semibold hover:bg-amber-700 transition-colors"
            >
              Godkjenn {scanResults.length} varer
            </button>
            <button
              onClick={() => { setScanResults(null); setMode(null); }}
              className="w-full bg-white border border-gray-200 text-gray-600 py-3 rounded-2xl text-sm"
            >
              Avbryt
            </button>
          </>
        )}

        {/* Manual entry */}
        {mode === "manual" && (
          <>
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Produktnavn</label>
                <input type="text" value={manualProduct.name}
                  onChange={e => setManualProduct(p => ({ ...p, name: e.target.value }))}
                  placeholder="F.eks. «Cherrytomater»"
                  className="w-full border border-gray-200 rounded-xl py-2 px-3 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Pris</label>
                  <input type="number" value={manualProduct.price}
                    onChange={e => setManualProduct(p => ({ ...p, price: e.target.value }))}
                    placeholder="kr"
                    className="w-full border border-gray-200 rounded-xl py-2 px-3 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Enhet</label>
                  <select value={manualProduct.unit}
                    onChange={e => setManualProduct(p => ({ ...p, unit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl py-2 px-3 text-sm bg-white">
                    <option value="kg">kg</option>
                    <option value="stk">stk</option>
                    <option value="bunt">bunt</option>
                    <option value="kurv">kurv</option>
                    <option value="glass">glass</option>
                    <option value="12-pk">12-pk</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Kategori</label>
                <div className="flex flex-wrap gap-2">
                  {[["vegetables","Grønnsaker"],["fruits","Frukt"],["berries","Bær"],["herbs","Urter"],["eggs","Egg"],["honey","Honning"]].map(([k,l]) => (
                    <button key={k}
                      onClick={() => setManualProduct(p => ({ ...p, category: k }))}
                      className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                        manualProduct.category === k ? "bg-amber-50 border-amber-300 text-amber-700" : "border-gray-200 text-gray-500"
                      }`}
                    >{l}</button>
                  ))}
                </div>
              </div>
            </div>
            <button
              onClick={() => {
                if (manualProduct.name && manualProduct.price) {
                  onAddProducts([{
                    name: manualProduct.name,
                    price: +manualProduct.price,
                    unit: manualProduct.unit,
                    quantity: 10,
                    confidence: 1.0,
                  }]);
                  setManualProduct({ name: "", price: "", unit: "kg", category: "vegetables" });
                  setMode(null);
                }
              }}
              className="w-full bg-amber-600 text-white py-3.5 rounded-2xl font-semibold hover:bg-amber-700 transition-colors"
            >
              Legg til vare
            </button>
            <button onClick={() => setMode(null)}
              className="w-full bg-white border border-gray-200 text-gray-600 py-3 rounded-2xl text-sm"
            >
              Avbryt
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Producer: Product List ──────────────────────────────────────

function ProducerProducts({ products, onUpdatePrice, onToggleAvailable, onBack }) {
  return (
    <div className="bg-gray-50 min-h-full">
      <div className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
        <button onClick={onBack} className="flex items-center gap-1 text-amber-600 text-sm font-medium mb-2">
          ← Tilbake
        </button>
        <h2 className="text-lg font-bold text-gray-900">Mine varer ({products.length})</h2>
      </div>

      <div className="px-4 py-3 space-y-2">
        {products.length === 0 ? (
          <div className="text-center py-16">
            <span className="text-4xl">📦</span>
            <p className="text-gray-500 mt-3">Ingen varer ennå</p>
            <p className="text-gray-400 text-sm mt-1">Bruk opplasting for å legge til varer</p>
          </div>
        ) : (
          products.map(product => (
            <div key={product.id} className={`bg-white rounded-2xl p-4 shadow-sm border transition-colors ${
              product.available > 0 ? "border-gray-100" : "border-red-100 bg-red-50"
            }`}>
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <p className="font-semibold text-sm text-gray-900">
                    {product.name}
                    {product.variety && <span className="font-normal text-gray-500"> · {product.variety}</span>}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-sm font-bold text-amber-700">{product.price} kr</span>
                    <span className="text-xs text-gray-400">/ {product.unit}</span>
                    <span className="text-xs text-gray-400">· {product.available} tilgj.</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const newPrice = prompt(`Ny pris for ${product.name}:`, product.price);
                      if (newPrice) onUpdatePrice(product.id, +newPrice);
                    }}
                    className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center text-sm"
                    title="Endre pris"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => onToggleAvailable(product.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      product.available > 0
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-600"
                    }`}
                  >
                    {product.available > 0 ? "Aktiv" : "Utsolgt"}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Producer: Reservations ──────────────────────────────────────

function ProducerReservations({ reservations, onConfirm, onMarkReady, onBack }) {
  const pending = reservations.filter(r => r.status === "requested");
  const confirmed = reservations.filter(r => r.status === "confirmed");
  const ready = reservations.filter(r => r.status === "ready");
  const completed = reservations.filter(r => r.status === "completed");

  return (
    <div className="bg-gray-50 min-h-full">
      <div className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
        <button onClick={onBack} className="flex items-center gap-1 text-amber-600 text-sm font-medium mb-2">
          ← Tilbake
        </button>
        <h2 className="text-lg font-bold text-gray-900">Reservasjoner</h2>
        <p className="text-xs text-gray-500">{reservations.length} totalt</p>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Pending — needs action */}
        {pending.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">Venter på deg ({pending.length})</p>
            {pending.map(r => (
              <div key={r.id} className="bg-white rounded-2xl p-4 shadow-sm border border-red-200 mb-2">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-sm text-gray-900">{r.customerName}</p>
                    <p className="text-xs text-gray-500">{r.items} · {r.total} kr</p>
                    <p className="text-xs text-gray-400">Henting kl {r.pickupTime}</p>
                    {r.note && <p className="text-xs text-blue-600 mt-1">«{r.note}»</p>}
                  </div>
                  <button
                    onClick={() => onConfirm(r.id)}
                    className="bg-green-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors"
                  >
                    Bekreft
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Confirmed — preparing */}
        {confirmed.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-2">Under klargjøring ({confirmed.length})</p>
            {confirmed.map(r => (
              <div key={r.id} className="bg-white rounded-2xl p-4 shadow-sm border border-blue-200 mb-2">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-sm text-gray-900">{r.customerName}</p>
                    <p className="text-xs text-gray-500">{r.items} · {r.total} kr · kl {r.pickupTime}</p>
                  </div>
                  <button
                    onClick={() => onMarkReady(r.id)}
                    className="bg-amber-500 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-amber-600 transition-colors"
                  >
                    Klar!
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Ready — waiting for pickup */}
        {ready.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wide mb-2">Klar for henting ({ready.length})</p>
            {ready.map(r => (
              <div key={r.id} className="bg-green-50 rounded-2xl p-4 border border-green-200 mb-2">
                <p className="font-semibold text-sm text-gray-900">{r.customerName}</p>
                <p className="text-xs text-gray-500">{r.items} · {r.total} kr · kl {r.pickupTime}</p>
                <Badge color="green">Venter på henting</Badge>
              </div>
            ))}
          </div>
        )}

        {/* Completed */}
        {completed.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Fullført ({completed.length})</p>
            {completed.map(r => (
              <div key={r.id} className="bg-gray-50 rounded-2xl p-3 border border-gray-200 mb-2 opacity-60">
                <p className="text-sm text-gray-700">{r.customerName} · {r.total} kr</p>
              </div>
            ))}
          </div>
        )}

        {reservations.length === 0 && (
          <div className="text-center py-16">
            <span className="text-4xl">📋</span>
            <p className="text-gray-500 mt-3">Ingen reservasjoner ennå</p>
            <p className="text-gray-400 text-sm mt-1">Legg til varer — kundene finner deg!</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Producer: Quick Price ───────────────────────────────────────

function ProducerQuickPrice({ products, onUpdatePrice, onBack }) {
  return (
    <div className="bg-gray-50 min-h-full">
      <div className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
        <button onClick={onBack} className="flex items-center gap-1 text-amber-600 text-sm font-medium mb-2">
          ← Tilbake
        </button>
        <h2 className="text-lg font-bold text-gray-900">Rask prisoppdatering</h2>
        <p className="text-xs text-gray-500">Endre priser med ett trykk</p>
      </div>

      <div className="px-4 py-3 space-y-2">
        {products.filter(p => p.available > 0).map(product => (
          <div key={product.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <p className="font-semibold text-sm text-gray-900 mb-2">
              {product.name}
              {product.variety && <span className="font-normal text-gray-500"> · {product.variety}</span>}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => onUpdatePrice(product.id, Math.max(1, product.price - 5))}
                className="w-10 h-10 bg-red-50 text-red-600 rounded-xl font-bold text-lg flex items-center justify-center border border-red-200">
                −5
              </button>
              <button onClick={() => onUpdatePrice(product.id, Math.max(1, product.price - 1))}
                className="w-10 h-10 bg-red-50 text-red-600 rounded-xl font-bold flex items-center justify-center border border-red-200">
                −1
              </button>
              <div className="flex-1 text-center">
                <span className="text-xl font-bold text-amber-700">{product.price}</span>
                <span className="text-xs text-gray-400 ml-1">kr/{product.unit}</span>
              </div>
              <button onClick={() => onUpdatePrice(product.id, product.price + 1)}
                className="w-10 h-10 bg-green-50 text-green-600 rounded-xl font-bold flex items-center justify-center border border-green-200">
                +1
              </button>
              <button onClick={() => onUpdatePrice(product.id, product.price + 5)}
                className="w-10 h-10 bg-green-50 text-green-600 rounded-xl font-bold text-lg flex items-center justify-center border border-green-200">
                +5
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────

export default function LokalApp() {
  // ─── Role management ──────────────────────────────────
  const [role, setRole] = useState(null); // null (chooser) | "consumer" | "producer"

  // ─── Consumer state ────────────────────────────────────
  const [consumerScreen, setConsumerScreen] = useState("onboarding");
  const [preferences, setPreferences] = useState(null);
  const [selectedProducer, setSelectedProducer] = useState(null);
  const [cart, setCart] = useState([]);
  const [reservationDetails, setReservationDetails] = useState(null);

  // ─── Producer state ────────────────────────────────────
  const [producerScreen, setProducerScreen] = useState("onboarding");
  const [shopInfo, setShopInfo] = useState(null);
  const [myProducts, setMyProducts] = useState([]);
  const [myReservations, setMyReservations] = useState([
    // Seed some demo reservations for the producer view
    { id: "r1", customerName: "Daniel F.", items: "2 kg Tomater (Cherry), 1 stk Agurk", total: 78, pickupTime: "16:00", status: "requested", note: "Kan hente etter kl 16" },
    { id: "r2", customerName: "Maja S.", items: "1 kg Gulrøtter, 3 bunt Urter", total: 97, pickupTime: "14:00", status: "confirmed" },
    { id: "r3", customerName: "Erik B.", items: "2 kurv Jordbær", total: 120, pickupTime: "12:00", status: "completed" },
  ]);
  let nextProductId = myProducts.length + 1;

  // ─── Consumer handlers ─────────────────────────────────
  const handleOnboardingComplete = useCallback((prefs) => {
    setPreferences(prefs);
    setConsumerScreen("feed");
  }, []);

  const handleSelectProducer = useCallback((producer) => {
    setSelectedProducer(producer);
    setConsumerScreen("producerDetail");
  }, []);

  const handleAddToCart = useCallback((product, producer, delta) => {
    setCart(prev => {
      const existing = prev.find(c => c.product.id === product.id);
      if (existing) {
        const newQty = existing.quantity + delta;
        if (newQty <= 0) return prev.filter(c => c.product.id !== product.id);
        return prev.map(c => c.product.id === product.id ? { ...c, quantity: newQty } : c);
      }
      if (delta > 0) return [...prev, { product, producer, quantity: 1 }];
      return prev;
    });
  }, []);

  const handleUpdateQuantity = useCallback((productId, delta) => {
    setCart(prev => {
      const existing = prev.find(c => c.product.id === productId);
      if (!existing) return prev;
      const newQty = existing.quantity + delta;
      if (newQty <= 0) return prev.filter(c => c.product.id !== productId);
      return prev.map(c => c.product.id === productId ? { ...c, quantity: newQty } : c);
    });
  }, []);

  const handleReserve = useCallback((details) => {
    setReservationDetails(details);
    setConsumerScreen("confirmed");
  }, []);

  // ─── Producer handlers ─────────────────────────────────
  const handleProducerOnboard = useCallback((info) => {
    setShopInfo(info);
    setProducerScreen("dashboard");
  }, []);

  const handleAddProducts = useCallback((scannedItems) => {
    setMyProducts(prev => {
      const newProducts = scannedItems.map((item, i) => ({
        id: `mp-${Date.now()}-${i}`,
        name: item.name,
        variety: item.variety || null,
        price: item.price,
        unit: item.unit,
        available: item.quantity,
        confidence: item.confidence,
      }));
      return [...prev, ...newProducts];
    });
    setProducerScreen("dashboard");
  }, []);

  const handleUpdateProductPrice = useCallback((productId, newPrice) => {
    setMyProducts(prev =>
      prev.map(p => p.id === productId ? { ...p, price: newPrice } : p)
    );
  }, []);

  const handleToggleAvailable = useCallback((productId) => {
    setMyProducts(prev =>
      prev.map(p => p.id === productId ? { ...p, available: p.available > 0 ? 0 : 10 } : p)
    );
  }, []);

  const handleConfirmReservation = useCallback((resId) => {
    setMyReservations(prev =>
      prev.map(r => r.id === resId ? { ...r, status: "confirmed" } : r)
    );
  }, []);

  const handleMarkReady = useCallback((resId) => {
    setMyReservations(prev =>
      prev.map(r => r.id === resId ? { ...r, status: "ready" } : r)
    );
  }, []);

  // ─── Start over (resets everything) ────────────────────
  const handleStartOver = useCallback(() => {
    setRole(null);
    setConsumerScreen("onboarding");
    setPreferences(null);
    setSelectedProducer(null);
    setCart([]);
    setReservationDetails(null);
    setProducerScreen("onboarding");
    setShopInfo(null);
  }, []);

  // ─── Role switch (keeps state) ─────────────────────────
  const handleSwitchRole = useCallback((newRole) => {
    setRole(newRole);
  }, []);

  // ─── Render ────────────────────────────────────────────
  return (
    <PhoneFrame>
      {/* ─── Role Chooser ─── */}
      {!role && (
        <div className="min-h-full bg-white px-6 pt-16 text-center">
          <div className="text-6xl mb-6">🥬</div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Lokal</h1>
          <p className="text-gray-500 text-sm mb-10">Mat fra nabolaget ditt</p>

          <div className="space-y-3">
            <button
              onClick={() => setRole("consumer")}
              className="w-full bg-green-600 text-white rounded-2xl p-5 text-left hover:bg-green-700 transition-colors"
            >
              <div className="flex items-center gap-4">
                <span className="text-3xl">🛒</span>
                <div>
                  <p className="font-semibold text-lg">Jeg vil handle</p>
                  <p className="text-green-200 text-sm mt-0.5">Finn fersk, lokal mat nær deg</p>
                </div>
              </div>
            </button>

            <button
              onClick={() => setRole("producer")}
              className="w-full bg-amber-600 text-white rounded-2xl p-5 text-left hover:bg-amber-700 transition-colors"
            >
              <div className="flex items-center gap-4">
                <span className="text-3xl">🌾</span>
                <div>
                  <p className="font-semibold text-lg">Jeg vil selge</p>
                  <p className="text-amber-200 text-sm mt-0.5">Nå kunder direkte fra telefonen</p>
                </div>
              </div>
            </button>
          </div>

          <p className="text-xs text-gray-400 mt-8">Du kan bytte rolle når som helst</p>
        </div>
      )}

      {/* ─── Consumer Mode ─── */}
      {role === "consumer" && (
        <>
          {consumerScreen === "onboarding" && (
            <div>
              <div className="pt-2">
                <RoleSwitcher role={role} onSwitch={handleSwitchRole} />
              </div>
              <OnboardingScreen onComplete={handleOnboardingComplete} />
            </div>
          )}
          {consumerScreen === "feed" && (
            <div>
              <div className="bg-white pt-2">
                <RoleSwitcher role={role} onSwitch={handleSwitchRole} />
              </div>
              <NotificationFeed
                producers={PRODUCERS}
                onSelectProducer={handleSelectProducer}
                onOpenCart={() => setConsumerScreen("cart")}
                cartCount={cart.reduce((sum, c) => sum + c.quantity, 0)}
                onStartOver={handleStartOver}
              />
            </div>
          )}
          {consumerScreen === "producerDetail" && selectedProducer && (
            <ProducerDetail
              producer={selectedProducer}
              onBack={() => setConsumerScreen("feed")}
              onAddToCart={handleAddToCart}
              cart={cart}
            />
          )}
          {consumerScreen === "cart" && (
            <CartScreen
              cart={cart}
              onBack={() => setConsumerScreen(selectedProducer ? "producerDetail" : "feed")}
              onUpdateQuantity={handleUpdateQuantity}
              onReserve={handleReserve}
            />
          )}
          {consumerScreen === "confirmed" && (
            <ReservationConfirmed
              cart={cart}
              reservationDetails={reservationDetails}
              onBackToFeed={() => {
                setCart([]);
                setReservationDetails(null);
                setSelectedProducer(null);
                setConsumerScreen("feed");
              }}
            />
          )}
        </>
      )}

      {/* ─── Producer Mode ─── */}
      {role === "producer" && (
        <>
          {producerScreen === "onboarding" && (
            <div>
              <div className="pt-2">
                <RoleSwitcher role={role} onSwitch={handleSwitchRole} />
              </div>
              <ProducerOnboarding onComplete={handleProducerOnboard} />
            </div>
          )}
          {producerScreen === "dashboard" && (
            <div>
              <div className="bg-white pt-2">
                <RoleSwitcher role={role} onSwitch={handleSwitchRole} />
              </div>
              <ProducerDashboard
                shop={shopInfo}
                products={myProducts}
                reservations={myReservations}
                onNavigate={(screen) => setProducerScreen(screen)}
                onStartOver={handleStartOver}
              />
            </div>
          )}
          {producerScreen === "upload" && (
            <ProducerUpload
              products={myProducts}
              onAddProducts={handleAddProducts}
              onBack={() => setProducerScreen("dashboard")}
            />
          )}
          {producerScreen === "products" && (
            <ProducerProducts
              products={myProducts}
              onUpdatePrice={handleUpdateProductPrice}
              onToggleAvailable={handleToggleAvailable}
              onBack={() => setProducerScreen("dashboard")}
            />
          )}
          {producerScreen === "reservations" && (
            <ProducerReservations
              reservations={myReservations}
              onConfirm={handleConfirmReservation}
              onMarkReady={handleMarkReady}
              onBack={() => setProducerScreen("dashboard")}
            />
          )}
          {producerScreen === "quickprice" && (
            <ProducerQuickPrice
              products={myProducts}
              onUpdatePrice={handleUpdateProductPrice}
              onBack={() => setProducerScreen("dashboard")}
            />
          )}
        </>
      )}
    </PhoneFrame>
  );
}

import { useState, useMemo, useEffect, useRef, memo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────────

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://ttotfguudxiwwsvqknlz.supabase.co";
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_uD1GClVKzQG-pgcB2r3iLQ_ZUgAyxIQ";
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── DATA ────────────────────────────────────────────────────────────────────

// base/quote: ISO currency codes for forex pairs, used to auto-convert margin
// and pip value into USD via getUsdRate() below. null base = value already
// denominated in USD at its own price (metals, indices).
const ASSETS = {
  GBPUSD: { price: 1.34308, contractSize: 100000, type: "Forex", base: "GBP", quote: "USD", pipSize: 0.0001 },
  USDJPY: { price: 158.995, contractSize: 100000, type: "Forex", base: "USD", quote: "JPY", pipSize: 0.01 },
  EURUSD: { price: 1.0842, contractSize: 100000, type: "Forex", base: "EUR", quote: "USD", pipSize: 0.0001 },
  USDCAD: { price: 1.3712, contractSize: 100000, type: "Forex", base: "USD", quote: "CAD", pipSize: 0.0001 },
  USDCHF: { price: 0.8821, contractSize: 100000, type: "Forex", base: "USD", quote: "CHF", pipSize: 0.0001 },
  AUDUSD: { price: 0.6512, contractSize: 100000, type: "Forex", base: "AUD", quote: "USD", pipSize: 0.0001 },
  NZDUSD: { price: 0.5978, contractSize: 100000, type: "Forex", base: "NZD", quote: "USD", pipSize: 0.0001 },
  GBPJPY: { price: 195.42, contractSize: 100000, type: "Forex", base: "GBP", quote: "JPY", pipSize: 0.01 },
  XAUUSD: { price: 3350.0, contractSize: 100, type: "Metal", base: null, quote: "USD", pipSize: 0.01 },
  NDAQ100: { price: 29475.65, contractSize: 10, type: "Index", base: null, quote: "USD", pipSize: 1 },
  US30: { price: 50405.92, contractSize: 1, type: "Index", base: null, quote: "USD", pipSize: 1 },
  US100M: { price: 29539.25, contractSize: 20, type: "Index", base: null, quote: "USD", pipSize: 1 },
};

const BROKERS = ["FxPro", "JustMarkets", "Headway", "Deriv"];
const LEVERAGE_OPTIONS = [1, 10, 50, 100, 200, 500, 1000, 2000, "Unlimited"];

// Default retail/standard account tier caps per broker, by asset type
// (standard offshore retail entity, NOT the EU/ESMA-regulated 1:30 entity).
// These are just starting values — edit them in the Margin Calculator UI to
// match your real account's contract specs; your edits persist in this browser.
const DEFAULT_LEVERAGE_TABLE = {
  FxPro:       { Forex: 500,  Metal: 100,  Index: 200 },
  JustMarkets: { Forex: 3000, Metal: 3000, Index: 1000 },
  Headway:     { Forex: 2000, Metal: 2000, Index: 400 },
  Deriv:       { Forex: 1000, Metal: 500,  Index: 400 },
};

const LEVERAGE_TABLE_STORAGE_KEY = "arx_leverage_table_v1";

function loadLeverageTable() {
  try {
    const saved = localStorage.getItem(LEVERAGE_TABLE_STORAGE_KEY);
    if (!saved) return DEFAULT_LEVERAGE_TABLE;
    const parsed = JSON.parse(saved);
    // Merge over defaults so newly added brokers/assets always have a value.
    const merged = {};
    for (const broker of Object.keys(DEFAULT_LEVERAGE_TABLE)) {
      merged[broker] = { ...DEFAULT_LEVERAGE_TABLE[broker], ...(parsed[broker] || {}) };
    }
    return merged;
  } catch {
    return DEFAULT_LEVERAGE_TABLE;
  }
}

// ─── CALC HELPERS ─────────────────────────────────────────────────────────────

function getEffectiveLeverage(broker, assetType, leverage, leverageTable) {
  const cap = leverageTable[broker]?.[assetType] ?? 500;
  if (leverage === "Unlimited") return cap;
  if (leverage > cap) return cap;
  return leverage;
}

// Looks up the USD value of one unit of a currency using whichever ASSETS
// pair quotes it (either CODEUSD directly, or the inverse of USDCODE).
// Falls back to 1 (treats as USD) if no pair is defined for that currency.
function getUsdRate(currencyCode) {
  if (!currencyCode || currencyCode === "USD") return 1;
  const direct = ASSETS[`${currencyCode}USD`];
  if (direct) return direct.price;
  const inverse = ASSETS[`USD${currencyCode}`];
  if (inverse) return 1 / inverse.price;
  return 1;
}

function calcMargin(asset, price, lotSize, effectiveLeverage) {
  if (effectiveLeverage === "Unlimited") return 0;
  const { contractSize, base } = asset;
  // Metals/indices (base: null) are already valued in USD at their own price.
  const baseRateUsd = base ? getUsdRate(base) : price;
  return (lotSize * contractSize * baseRateUsd) / effectiveLeverage;
}

function calcPipValue(asset, price, lotSize) {
  const { contractSize, pipSize, quote } = asset;
  const quoteRateUsd = getUsdRate(quote);
  return pipSize * contractSize * lotSize * quoteRateUsd;
}

function calcPnL(asset, entry, exit, lotSize, direction) {
  const { contractSize, pipSize } = asset;
  const priceDiff = direction === "long" ? exit - entry : entry - exit;
  const pips = priceDiff / pipSize;
  const pipVal = calcPipValue(asset, entry, lotSize);
  return { pnl: pips * pipVal, pips };
}

const fmt = (v) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

const fmtPips = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} pips`;

// ─── SHARED UI ────────────────────────────────────────────────────────────────

// Deliberate split: UI chrome (labels, nav, buttons) uses Inter for a calm,
// legible interface; anything numeric (prices, PnL, pips) stays in mono with
// tabular-nums so figures align in a column — that's the one place density
// and precision still matter on an otherwise airy, card-based layout.
const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };

function Label({ children }) {
  return <span className="text-zinc-500 dark:text-zinc-500 text-xs tracking-wide font-medium shrink-0">{children}</span>;
}

function Row({ label, children }) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-4">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Divider() { return <div className="border-t border-zinc-100 dark:border-zinc-800 mx-4" />; }

function StyledSelect({ value, onChange, children }) {
  return (
    <select value={value} onChange={onChange} style={mono}
      className="bg-transparent text-zinc-800 dark:text-zinc-200 text-sm text-right outline-none cursor-pointer border-none appearance-none">
      {children}
    </select>
  );
}

function StyledInput({ value, onChange, type = "number", placeholder, step, min, className = "" }) {
  return (
    <input type={type} value={value} onChange={onChange} step={step} min={min} placeholder={placeholder}
      style={mono}
      className={`bg-transparent text-zinc-800 dark:text-zinc-200 text-sm text-right outline-none border-none tabular-nums placeholder:text-zinc-400 dark:placeholder:text-zinc-600 ${className}`}
    />
  );
}

function Badge({ children, color = "zinc" }) {
  const colors = {
    zinc: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    red: "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
    blue: "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-md font-medium tracking-wide ${colors[color]}`} style={mono}>
      {children}
    </span>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="px-1 pb-3 flex items-center justify-between">
      <span className="text-zinc-900 dark:text-zinc-100 text-sm font-semibold tracking-tight">{children}</span>
    </div>
  );
}

// accent: optional left-border color signaling category at a glance
// (e.g. emerald = personal/active, amber = prop firm, red = failed/breached).
function Block({ children, className = "", accent = null }) {
  const accentBorder = {
    emerald: "border-l-4 border-l-emerald-400 dark:border-l-emerald-500",
    amber: "border-l-4 border-l-amber-400 dark:border-l-amber-500",
    red: "border-l-4 border-l-red-400 dark:border-l-red-500",
    zinc: "border-l-4 border-l-zinc-300 dark:border-l-zinc-700",
  };
  return (
    <div
      className={`rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm shadow-zinc-200/50 dark:shadow-none overflow-hidden ${accent ? accentBorder[accent] : ""} ${className}`}
    >
      {children}
    </div>
  );
}

function ThemeToggle({ theme, setTheme }) {
  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

// ─── NAV ──────────────────────────────────────────────────────────────────────

function Nav({ page, setPage, theme, setTheme }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 mb-6">
      <div className="flex overflow-x-auto">
        {[["calc", "Margin Calc"], ["journal", "Trade Journal"], ["accounts", "Accounts"], ["analytics", "Analytics"], ["setups", "Setups"], ["backtest", "Backtest"], ["calendar", "Calendar"]].map(([key, label]) => (
          <button key={key} onClick={() => setPage(key)}
            className={`px-4 py-3 text-xs font-medium whitespace-nowrap transition-colors ${
              page === key
                ? "text-amber-600 dark:text-amber-400 border-b-2 border-amber-500 -mb-px"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
            }`}>
            {label}
          </button>
        ))}
      </div>
      <ThemeToggle theme={theme} setTheme={setTheme} />
    </div>
  );
}

// ─── PAGE 1: MARGIN CALCULATOR ────────────────────────────────────────────────

function MarginCalcPage() {
  const [broker, setBroker] = useState("FxPro");
  const [assetKey, setAssetKey] = useState("GBPUSD");
  const [price, setPrice] = useState(ASSETS.GBPUSD.price);
  const [lotSize, setLotSize] = useState(0.01);
  const [leverage, setLeverage] = useState("Unlimited");
  const [leverageTable, setLeverageTable] = useState(loadLeverageTable);
  const [editingCap, setEditingCap] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(LEVERAGE_TABLE_STORAGE_KEY, JSON.stringify(leverageTable)); } catch {}
  }, [leverageTable]);

  const asset = ASSETS[assetKey];
  const effectiveLeverage = getEffectiveLeverage(broker, asset.type, leverage, leverageTable);
  const margin = calcMargin(asset, price, lotSize, effectiveLeverage);
  const pipValue = calcPipValue(asset, price, lotSize);
  const rawLeverage = leverage === "Unlimited" ? Infinity : leverage;
  const leverageCap = leverageTable[broker]?.[asset.type] ?? 500;
  const leverageCapped = rawLeverage > leverageCap;

  const updateCap = (newCap) => {
    setLeverageTable((prev) => ({
      ...prev,
      [broker]: { ...prev[broker], [asset.type]: newCap },
    }));
  };

  const resetCaps = () => {
    setLeverageTable(DEFAULT_LEVERAGE_TABLE);
  };

  const handleAssetChange = (e) => {
    setAssetKey(e.target.value);
    setPrice(ASSETS[e.target.value].price);
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <SectionHeader>Margin Calculator</SectionHeader>

      <div className="border border-zinc-700 border-b-0 px-4 py-4 bg-zinc-900 flex items-center justify-between">
        <Label>Required Margin</Label>
        <span className={`text-2xl font-semibold tracking-tight tabular-nums ${margin === 0 ? "text-zinc-600" : "text-emerald-400"}`} style={mono}>
          {fmt(margin)}
        </span>
      </div>

      <div className="border border-zinc-700 border-b-0 px-4 py-2 bg-zinc-900 flex items-center justify-between">
        <Label>Pip Value</Label>
        <span className="text-zinc-300 text-sm tabular-nums" style={mono}>{fmt(pipValue)} / pip</span>
      </div>

      {leverageCapped && !editingCap && (
        <div className="border border-amber-800 border-b-0 px-4 py-2 bg-amber-950 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-amber-500 text-xs">▲</span>
            <span className="text-amber-400 text-xs">{broker} caps {asset.type.toLowerCase()} leverage at 1:{leverageCap}. Using 1:{leverageCap}.</span>
          </div>
          <button onClick={() => setEditingCap(true)} className="text-amber-500 text-xs underline shrink-0">Edit</button>
        </div>
      )}

      {editingCap && (
        <div className="border border-amber-800 border-b-0 px-4 py-2 bg-amber-950 flex items-center justify-between gap-2">
          <span className="text-amber-400 text-xs">Cap for {broker} / {asset.type}:</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              defaultValue={leverageCap}
              className="w-20 bg-zinc-900 border border-amber-800 text-amber-300 text-xs px-2 py-1 tabular-nums"
              style={mono}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v) && v > 0) updateCap(v);
                  setEditingCap(false);
                }
              }}
              onBlur={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v > 0) updateCap(v);
                setEditingCap(false);
              }}
              autoFocus
            />
            <button onClick={resetCaps} className="text-zinc-500 text-xs underline shrink-0">Reset all</button>
          </div>
        </div>
      )}

      <Block>
        <Row label="Broker">
          <StyledSelect value={broker} onChange={(e) => setBroker(e.target.value)}>
            {BROKERS.map((b) => <option key={b} value={b}>{b}</option>)}
          </StyledSelect>
        </Row>
        <Divider />
        <Row label="Asset">
          <StyledSelect value={assetKey} onChange={handleAssetChange}>
            {Object.keys(ASSETS).map((k) => <option key={k} value={k}>{k}</option>)}
          </StyledSelect>
        </Row>
        <Divider />
        <div className="px-4 py-2 flex gap-5">
          <div className="flex flex-col gap-0.5">
            <span className="text-zinc-700 text-xs tracking-widest uppercase">Type</span>
            <span className="text-zinc-400 text-xs font-medium">{asset.type}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-zinc-700 text-xs tracking-widest uppercase">Contract</span>
            <span className="text-zinc-400 text-xs font-medium">{asset.contractSize.toLocaleString()}</span>
          </div>
          {asset.base && (
            <div className="flex flex-col gap-0.5">
              <span className="text-zinc-700 text-xs tracking-widest uppercase">Base</span>
              <span className="text-amber-500 text-xs font-medium">{asset.base}</span>
            </div>
          )}
          <div className="flex flex-col gap-0.5 ml-auto">
            <span className="text-zinc-700 text-xs tracking-widest uppercase">Cap</span>
            <button onClick={() => setEditingCap(true)} className="text-zinc-400 text-xs font-medium underline text-left" style={mono}>1:{leverageCap}</button>
          </div>
        </div>
        <Divider />
        <Row label="Price"><StyledInput value={price} step={0.00001} min={0.00001} onChange={(e) => setPrice(parseFloat(e.target.value) || 0)} /></Row>
        <Divider />
        <Row label="Lot Size"><StyledInput value={lotSize} step={0.01} min={0.01} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0.01) setLotSize(v); }} /></Row>
        <Divider />
        <Row label="Leverage">
          <StyledSelect value={leverage} onChange={(e) => { const v = e.target.value; setLeverage(v === "Unlimited" ? "Unlimited" : parseInt(v)); }}>
            {LEVERAGE_OPTIONS.map((l) => <option key={l} value={l}>{l === "Unlimited" ? "Unlimited" : `1:${l}`}</option>)}
          </StyledSelect>
        </Row>
        {effectiveLeverage !== leverage && (
          <>
            <Divider />
            <div className="px-4 py-2 flex items-center justify-between">
              <Label>Effective</Label>
              <span className="text-amber-500 text-xs font-medium" style={mono}>1:{effectiveLeverage}</span>
            </div>
          </>
        )}
      </Block>

      <div className="border border-zinc-700 border-t-0 px-4 py-2 bg-zinc-900 flex justify-between">
        <span className="text-zinc-700 text-xs" style={mono}>{lotSize} lot × {asset.contractSize.toLocaleString()} = {(lotSize * asset.contractSize).toLocaleString()} units</span>
        <span className="text-zinc-700 text-xs" style={mono}>{assetKey}</span>
      </div>
    </div>
  );
}

// ─── PAGE 2: TRADE JOURNAL ────────────────────────────────────────────────

const OUTCOME_COLORS = { TP: "emerald", SL: "red", Manual: "amber" };
const OUTCOME_ICONS = { TP: "✓", SL: "✕", Manual: "◎" };

function TradeJournalPage() {
  const [trades, setTrades] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [setups, setSetups] = useState([]);
  const [view, setView] = useState("planner"); // planner | log
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── Load Data ──
  useEffect(() => {
    supabase.from("trades").select("*").order("opened_at", { ascending: false })
      .then(({ data, error }) => {
        if (data && !error) setTrades(data);
      });
    supabase.from("accounts").select("id, name, broker").eq("status", "active").order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (data && !error) setAccounts(data);
      });
    supabase.from("setups").select("id, name").order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (data && !error) setSetups(data);
      });
  }, []);

  // ── Planner state ──
  const [pAsset, setPAsset] = useState("GBPUSD");
  const [pDirection, setPDirection] = useState("long");
  const [pEntry, setPEntry] = useState(ASSETS.GBPUSD.price);
  const [pTP, setPTP] = useState("");
  const [pSL, setPSL] = useState("");
  const [pLotSize, setPLotSize] = useState(0.01);
  const [pAccountId, setPAccountId] = useState("");
  const [pSession, setPSession] = useState("");
  const [pSetupId, setPSetupId] = useState("");

  // ── Close trade modal ──
  const [closingId, setClosingId] = useState(null);
  const [closeOutcome, setCloseOutcome] = useState("TP");
  const [closePrice, setClosePrice] = useState("");
  const [closeReason, setCloseReason] = useState("");

  const pAssetData = ASSETS[pAsset];

  const pTP_result = pTP ? calcPnL(pAssetData, pEntry, parseFloat(pTP), pLotSize, pDirection) : null;
  const pSL_result = pSL ? calcPnL(pAssetData, pEntry, parseFloat(pSL), pLotSize, pDirection) : null;
  const pipVal = calcPipValue(pAssetData, pEntry, pLotSize);
  const rrRatio = pTP_result && pSL_result && pSL_result.pnl !== 0
    ? Math.abs(pTP_result.pnl / pSL_result.pnl).toFixed(2)
    : null;

  async function openTrade() {
    if (!pEntry || !pTP || !pSL) return;
    setIsSubmitting(true);

    const { data: { user } } = await supabase.auth.getUser();

    const { data, error } = await supabase.from("trades").insert({
      asset: pAsset,
      direction: pDirection,
      lot_size: pLotSize,
      entry_price: parseFloat(pEntry),
      tp_price: parseFloat(pTP),
      sl_price: parseFloat(pSL),
      status: "open",
      user_id: user?.id,
      account_id: pAccountId || null,
      session: pSession || null,
      setup_id: pSetupId || null,
    }).select().single();

    if (!error && data) {
      setTrades((t) => [data, ...t]);
      setView("log");
      setPTP("");
      setPSL("");
    }
    setIsSubmitting(false);
  }

  async function submitClose() {
    const trade = trades.find((t) => t.id === closingId);
    if (!trade || !closePrice) return;
    setIsSubmitting(true);

    const asset = ASSETS[trade.asset];
    const { pnl, pips } = calcPnL(asset, trade.entry_price, parseFloat(closePrice), trade.lot_size, trade.direction);
    
    const updatePayload = {
      status: "closed",
      outcome: closeOutcome,
      close_price: parseFloat(closePrice),
      close_reason: closeReason || null,
      pnl,
      pips,
      closed_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("trades").update(updatePayload).eq("id", closingId);

    if (!error) {
      setTrades((prev) =>
        prev.map((t) => (t.id === closingId ? { ...t, ...updatePayload } : t))
      );
      setClosingId(null);
      setClosePrice("");
      setCloseReason("");
      setCloseOutcome("TP");
    }
    setIsSubmitting(false);
  }

  // ── Stats ──
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.pnl > 0).length;
  const totalPnL = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate = closed.length ? ((wins / closed.length) * 100).toFixed(1) : null;
  const outcomeCounts = { TP: 0, SL: 0, Manual: 0 };
  closed.forEach((t) => { if (t.outcome) outcomeCounts[t.outcome]++; });

  // Equity curve
  const equityCurve = useMemo(() => {
    let equity = 0;
    return closed
      .slice()
      .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at))
      .map((t, i) => {
        equity += t.pnl;
        return { i: i + 1, equity: parseFloat(equity.toFixed(2)), label: t.asset };
      });
  }, [closed]);

  const handleAssetChange = (e) => {
    setPAsset(e.target.value);
    setPEntry(ASSETS[e.target.value].price);
    setPTP("");
    setPSL("");
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      {/* Sub-nav */}
      <div className="flex gap-1" style={mono}>
        {[["planner", "Pre-Trade"], ["log", "Journal"]].map(([key, label]) => (
          <button key={key} onClick={() => setView(key)}
            className={`px-4 py-2 text-xs tracking-widest uppercase rounded-sm transition-colors ${
              view === key ? "bg-zinc-800 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── PLANNER ── */}
      {view === "planner" && (
        <div className="space-y-4">
          <SectionHeader>Trade Planner</SectionHeader>

          <Block>
            <Row label="Asset">
              <StyledSelect value={pAsset} onChange={handleAssetChange}>
                {Object.keys(ASSETS).map((k) => <option key={k} value={k}>{k}</option>)}
              </StyledSelect>
            </Row>
            <Divider />
            <Row label="Account">
              <StyledSelect value={pAccountId} onChange={(e) => setPAccountId(e.target.value)}>
                <option value="">— None —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.broker})</option>)}
              </StyledSelect>
            </Row>
            <Divider />
            <Row label="Session">
              <StyledSelect value={pSession} onChange={(e) => setPSession(e.target.value)}>
                <option value="">— None —</option>
                {["Asian", "London", "NY", "Overlap"].map((s) => <option key={s} value={s}>{s}</option>)}
              </StyledSelect>
            </Row>
            <Divider />
            <Row label="Setup">
              <StyledSelect value={pSetupId} onChange={(e) => setPSetupId(e.target.value)}>
                <option value="">— None —</option>
                {setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </StyledSelect>
            </Row>
            <Divider />
            <Row label="Direction">
              <div className="flex gap-2">
                {["long", "short"].map((d) => (
                  <button key={d} onClick={() => setPDirection(d)}
                    className={`px-3 py-1 text-xs tracking-widest uppercase rounded-sm transition-colors ${
                      pDirection === d
                        ? d === "long" ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
                        : "bg-zinc-800 text-zinc-600 hover:text-zinc-400"
                    }`} style={mono}>
                    {d === "long" ? "▲ Long" : "▼ Short"}
                  </button>
                ))}
              </div>
            </Row>
            <Divider />
            <Row label="Lot Size"><StyledInput value={pLotSize} step={0.01} min={0.01} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0.01) setPLotSize(v); }} /></Row>
            <Divider />
            <Row label="Entry Price"><StyledInput value={pEntry} step={0.00001} onChange={(e) => setPEntry(parseFloat(e.target.value) || "")} /></Row>
            <Divider />
            <Row label="Take Profit">
              <div className="flex items-center gap-3">
                {pTP_result && <span className={`text-xs tabular-nums ${pTP_result.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>{fmt(pTP_result.pnl)}</span>}
                <StyledInput value={pTP} placeholder="0.00000" onChange={(e) => setPTP(e.target.value)} />
              </div>
            </Row>
            <Divider />
            <Row label="Stop Loss">
              <div className="flex items-center gap-3">
                {pSL_result && <span className={`text-xs tabular-nums ${pSL_result.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>{fmt(pSL_result.pnl)}</span>}
                <StyledInput value={pSL} placeholder="0.00000" onChange={(e) => setPSL(e.target.value)} />
              </div>
            </Row>
          </Block>

          {/* Projections */}
          {(pTP_result || pSL_result) && (
            <>
              <SectionHeader>Projections</SectionHeader>
              <Block>
                <div className="px-4 py-2 grid grid-cols-2 gap-x-8 gap-y-3">
                  <div>
                    <div className="text-zinc-600 text-xs tracking-widest uppercase mb-1">Pip Value</div>
                    <div className="text-zinc-300 text-sm tabular-nums" style={mono}>{fmt(pipVal)}/pip</div>
                  </div>
                  {rrRatio && (
                    <div>
                      <div className="text-zinc-600 text-xs tracking-widest uppercase mb-1">R:R Ratio</div>
                      <div className="text-zinc-300 text-sm tabular-nums" style={mono}>1 : {rrRatio}</div>
                    </div>
                  )}
                  {pTP_result && (
                    <div>
                      <div className="text-emerald-700 text-xs tracking-widest uppercase mb-1">TP Profit</div>
                      <div className="text-emerald-400 text-sm tabular-nums font-medium" style={mono}>{fmt(pTP_result.pnl)}</div>
                      <div className="text-emerald-800 text-xs mt-0.5" style={mono}>{fmtPips(pTP_result.pips)}</div>
                    </div>
                  )}
                  {pSL_result && (
                    <div>
                      <div className="text-red-700 text-xs tracking-widest uppercase mb-1">SL Loss</div>
                      <div className="text-red-400 text-sm tabular-nums font-medium" style={mono}>{fmt(pSL_result.pnl)}</div>
                      <div className="text-red-800 text-xs mt-0.5" style={mono}>{fmtPips(pSL_result.pips)}</div>
                    </div>
                  )}
                </div>
              </Block>
            </>
          )}

          <button onClick={openTrade}
            disabled={!pEntry || !pTP || !pSL || isSubmitting}
            className="w-full py-3 text-xs tracking-widest uppercase font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900"
            style={mono}>
            {isSubmitting ? "Logging..." : "Log Trade as Open →"}
          </button>
        </div>
      )}

      {/* ── JOURNAL LOG ── */}
      {view === "log" && (
        <div className="space-y-4">
          {/* Stats */}
          {closed.length > 0 && (
            <>
              <SectionHeader>Summary</SectionHeader>
              <Block>
                <div className="px-4 py-3 grid grid-cols-3 divide-x divide-zinc-800">
                  <div className="pr-4">
                    <div className="text-zinc-600 text-xs tracking-widest uppercase mb-1">Total P&L</div>
                    <div className={`text-xl font-semibold tabular-nums ${totalPnL >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>{fmt(totalPnL)}</div>
                  </div>
                  <div className="px-4">
                    <div className="text-zinc-600 text-xs tracking-widest uppercase mb-1">Win Rate</div>
                    <div className="text-zinc-200 text-xl font-semibold tabular-nums" style={mono}>{winRate}%</div>
                    <div className="text-zinc-600 text-xs mt-0.5" style={mono}>{wins}W / {closed.length - wins}L</div>
                  </div>
                  <div className="pl-4">
                    <div className="text-zinc-600 text-xs tracking-widest uppercase mb-2">Outcomes</div>
                    <div className="flex flex-col gap-1">
                      {Object.entries(outcomeCounts).map(([k, v]) => (
                        <div key={k} className="flex items-center gap-2">
                          <Badge color={OUTCOME_COLORS[k]}>{OUTCOME_ICONS[k]} {k}</Badge>
                          <span className="text-zinc-400 text-xs" style={mono}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {equityCurve.length > 1 && (
                  <>
                    <Divider />
                    <div className="px-4 py-3">
                      <div className="text-zinc-600 text-xs tracking-widest uppercase mb-3">Equity Curve</div>
                      <ResponsiveContainer width="100%" height={120}>
                        <LineChart data={equityCurve}>
                          <XAxis dataKey="i" tick={false} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: "#52525b", fontSize: 10, fontFamily: "IBM Plex Mono" }} axisLine={false} tickLine={false} width={55} tickFormatter={(v) => `$${v}`} />
                          <Tooltip
                            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 0, fontFamily: "IBM Plex Mono", fontSize: 11 }}
                            labelStyle={{ color: "#71717a" }}
                            formatter={(v) => [fmt(v), "Equity"]}
                          />
                          <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="3 3" />
                          <Line type="monotone" dataKey="equity" stroke="#34d399" strokeWidth={1.5} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
              </Block>
            </>
          )}

          {/* Trade list */}
          <SectionHeader>Trade History</SectionHeader>

          {trades.length === 0 && (
            <Block>
              <div className="px-4 py-8 text-center text-zinc-600 text-xs tracking-widest uppercase" style={mono}>
                No trades logged yet. Use Pre-Trade to open one.
              </div>
            </Block>
          )}

          {trades.map((t) => {
            const asset = ASSETS[t.asset];
            const tpPnL = calcPnL(asset, t.entry_price, t.tp_price, t.lot_size, t.direction);
            const slPnL = calcPnL(asset, t.entry_price, t.sl_price, t.lot_size, t.direction);
            return (
              <Block key={t.id}>
                <div className="px-4 py-3 flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-200 text-sm font-medium" style={mono}>{t.asset}</span>
                      <Badge color={t.direction === "long" ? "emerald" : "red"}>
                        {t.direction === "long" ? "▲ Long" : "▼ Short"}
                      </Badge>
                      {t.status === "open"
                        ? <Badge color="blue">● Open</Badge>
                        : <Badge color={OUTCOME_COLORS[t.outcome]}>{OUTCOME_ICONS[t.outcome]} {t.outcome}</Badge>
                      }
                    </div>
                    <span className="text-zinc-600 text-xs" style={mono}>
                      {new Date(t.opened_at).toLocaleString()} · {t.lot_size} lot
                    </span>
                  </div>
                  {t.status === "closed" && t.pnl !== null && (
                    <div className={`text-right tabular-nums ${t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>
                      <div className="text-lg font-semibold">{fmt(t.pnl)}</div>
                      <div className="text-xs opacity-70">{fmtPips(t.pips)}</div>
                    </div>
                  )}
                </div>

                <Divider />

                <div className="px-4 py-2 grid grid-cols-3 gap-4 text-xs" style={mono}>
                  <div>
                    <div className="text-zinc-600 uppercase tracking-widest mb-0.5">Entry</div>
                    <div className="text-zinc-300 tabular-nums">{t.entry_price}</div>
                  </div>
                  <div>
                    <div className="text-emerald-800 uppercase tracking-widest mb-0.5">TP · {fmt(tpPnL.pnl)}</div>
                    <div className="text-emerald-600 tabular-nums">{t.tp_price}</div>
                  </div>
                  <div>
                    <div className="text-red-800 uppercase tracking-widest mb-0.5">SL · {fmt(slPnL.pnl)}</div>
                    <div className="text-red-600 tabular-nums">{t.sl_price}</div>
                  </div>
                </div>

                {t.status === "closed" && (
                  <>
                    <Divider />
                    <div className="px-4 py-2 grid grid-cols-2 gap-4 text-xs" style={mono}>
                      <div>
                        <div className="text-zinc-600 uppercase tracking-widest mb-0.5">Close Price</div>
                        <div className="text-zinc-300 tabular-nums">{t.close_price}</div>
                      </div>
                      <div>
                        <div className="text-zinc-600 uppercase tracking-widest mb-0.5">Closed At</div>
                        <div className="text-zinc-400">{new Date(t.closed_at).toLocaleString()}</div>
                      </div>
                      {t.close_reason && (
                        <div className="col-span-2">
                          <div className="text-zinc-600 uppercase tracking-widest mb-0.5">Reason</div>
                          <div className="text-zinc-400">{t.close_reason}</div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {t.status === "open" && (
                  <>
                    <Divider />
                    <div className="px-4 py-2">
                      <button onClick={() => { setClosingId(t.id); setClosePrice(t.entry_price); }}
                        className="text-xs tracking-widest uppercase text-zinc-500 hover:text-zinc-300 transition-colors"
                        style={mono}>
                        Close Trade →
                      </button>
                    </div>
                  </>
                )}
              </Block>
            );
          })}
        </div>
      )}

      {/* ── CLOSE MODAL ── */}
      {closingId !== null && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-sm border border-zinc-700 bg-zinc-950" style={mono}>
            <div className="border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
              <span className="text-zinc-400 text-xs tracking-widest uppercase">Close Trade</span>
              <button onClick={() => setClosingId(null)} className="text-zinc-600 hover:text-zinc-400 text-xs">✕</button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1">Outcome</div>
                <div className="flex gap-2">
                  {["TP", "SL", "Manual"].map((o) => (
                    <button key={o} onClick={() => setCloseOutcome(o)}
                      className={`px-3 py-1.5 text-xs tracking-widest uppercase rounded-sm transition-colors flex items-center gap-1.5 ${
                        closeOutcome === o
                          ? o === "TP" ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                            : o === "SL" ? "bg-red-950 text-red-400 border border-red-800"
                            : "bg-amber-950 text-amber-400 border border-amber-800"
                          : "bg-zinc-900 text-zinc-600 border border-zinc-800 hover:text-zinc-400"
                      }`}>
                      {OUTCOME_ICONS[o]} {o}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1">Close Price</div>
                <input type="number" value={closePrice} onChange={(e) => setClosePrice(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 tabular-nums"
                  style={mono} step="0.00001" />
              </div>

              {closeOutcome === "Manual" && (
                <div>
                  <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1">Reason</div>
                  <textarea value={closeReason} onChange={(e) => setCloseReason(e.target.value)}
                    placeholder="e.g. News event, drawdown limit, setup invalidated..."
                    className="w-full bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 resize-none"
                    style={{ ...mono, height: 72 }} />
                </div>
              )}

              {/* Live P&L preview */}
              {closePrice && (() => {
                const trade = trades.find((t) => t.id === closingId);
                if (!trade) return null;
                const { pnl, pips } = calcPnL(ASSETS[trade.asset], trade.entry_price, parseFloat(closePrice), trade.lot_size, trade.direction);
                return (
                  <div className={`flex items-center justify-between px-3 py-2 border ${pnl >= 0 ? "border-emerald-900 bg-emerald-950" : "border-red-900 bg-red-950"}`}>
                    <span className="text-xs tracking-widest uppercase text-zinc-500">P&L Preview</span>
                    <div className="text-right">
                      <div className={`text-sm font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(pnl)}</div>
                      <div className={`text-xs ${pnl >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtPips(pips)}</div>
                    </div>
                  </div>
                );
              })()}

              <button onClick={submitClose} disabled={!closePrice || isSubmitting}
                className="w-full py-2.5 text-xs tracking-widest uppercase font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700"
                style={mono}>
                {isSubmitting ? "Closing..." : "Confirm Close"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AuthGate() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [awaitingOtp, setAwaitingOtp] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error } = isSignUp
      ? await supabase.auth.signUp({
          email,
          password,
          options: { data: { username } }
        })
      : await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else if (isSignUp) {
      setAwaitingOtp(true);
      setLoading(false);
    }
  }

  async function verifyOtp(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: "signup"
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  async function resendOtp() {
    setError("");
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
    });
    if (error) setError(error.message);
  }

  if (awaitingOtp) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="text-zinc-300 text-xs tracking-[0.3em] uppercase" style={mono}>
              Arx Trading Tools
            </h1>
          </div>

          <div className="border border-zinc-700 bg-zinc-900">
            <div className="border-b border-zinc-800 px-4 py-3">
              <span className="text-zinc-400 text-xs tracking-widest uppercase" style={mono}>
                Verify Email
              </span>
            </div>

            <div className="p-4 space-y-4">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto mb-3 border border-emerald-800 bg-emerald-950 rounded-full flex items-center justify-center">
                  <span className="text-emerald-400 text-lg">✉</span>
                </div>
                <p className="text-zinc-400 text-xs" style={mono}>
                  We sent a 6-digit code to
                </p>
                <p className="text-zinc-200 text-sm mt-1" style={mono}>
                  {email}
                </p>
              </div>

              <form onSubmit={verifyOtp} className="space-y-3">
                <div>
                  <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1" style={mono}>Verification Code</div>
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    required
                    maxLength={6}
                    className="w-full bg-zinc-950 border border-zinc-700 px-3 py-3 text-center text-2xl text-zinc-200 outline-none focus:border-emerald-700 tracking-[1em] tabular-nums"
                    style={mono}
                    placeholder="000000"
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 border border-red-900 bg-red-950 text-red-400 text-xs" style={mono}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || otp.length !== 6}
                  className="w-full py-2.5 text-xs tracking-widest uppercase font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900"
                  style={mono}
                >
                  {loading ? "Verifying..." : "Verify & Continue"}
                </button>
              </form>
            </div>

            <div className="border-t border-zinc-800 px-4 py-3 flex items-center justify-between">
              <button
                onClick={resendOtp}
                className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors"
                style={mono}
              >
                Resend code
              </button>
              <button
                onClick={() => { setAwaitingOtp(false); setOtp(""); setError(""); }}
                className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors"
                style={mono}
              >
                Back to sign up
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-zinc-300 text-xs tracking-[0.3em] uppercase" style={mono}>
            Arx Trading Tools
          </h1>
        </div>

        <div className="border border-zinc-700 bg-zinc-900">
          <div className="border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
            <span className="text-zinc-400 text-xs tracking-widest uppercase" style={mono}>
              {isSignUp ? "Create Account" : "Sign In"}
            </span>
          </div>

          <form onSubmit={handleSubmit} className="p-4 space-y-3">
            {isSignUp && (
              <div>
                <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1" style={mono}>Username</div>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20))}
                  required={isSignUp}
                  className="w-full bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-700 tabular-nums"
                  style={mono}
                  placeholder="trader_01"
                />
              </div>
            )}

            <div>
              <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1" style={mono}>Email</div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-700 tabular-nums"
                style={mono}
                placeholder="you@example.com"
              />
            </div>

            <div>
              <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1" style={mono}>Password</div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="w-full bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-700 tabular-nums"
                style={mono}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="px-3 py-2 border border-red-900 bg-red-950 text-red-400 text-xs" style={mono}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full py-2.5 text-xs tracking-widest uppercase font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900"
              style={mono}
            >
              {loading ? "..." : isSignUp ? "Create Account" : "Sign In"}
            </button>
          </form>

          <div className="border-t border-zinc-800 px-4 py-3 text-center">
            <button
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors"
              style={mono}
            >
              {isSignUp ? "Already have an account? Sign in" : "Don't have an account? Sign up"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PAGE 3: ACCOUNTS ─────────────────────────────────────────────────────────

const ACCOUNT_TYPES = ["personal", "prop_firm", "funded", "demo"];
const ACCOUNT_STATUSES = ["active", "passed", "failed", "breached", "archived"];

function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [broker, setBroker] = useState(BROKERS[0]);
  const [accountType, setAccountType] = useState("personal");
  const [startingBalance, setStartingBalance] = useState(10000);
  const [currency, setCurrency] = useState("USD");

  useEffect(() => {
    Promise.all([
      supabase.from("accounts").select("*").order("created_at", { ascending: false }),
      supabase.from("trades").select("account_id, pnl, status"),
    ]).then(([accRes, tradeRes]) => {
      if (accRes.data) setAccounts(accRes.data);
      if (tradeRes.data) setTrades(tradeRes.data);
      setLoading(false);
    });
  }, []);

  async function createAccount() {
    if (!name.trim()) return;
    setIsSubmitting(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from("accounts").insert({
      user_id: user?.id,
      name: name.trim(),
      broker,
      account_type: accountType,
      starting_balance: parseFloat(startingBalance) || 0,
      currency,
    }).select().single();
    if (!error && data) {
      setAccounts((a) => [data, ...a]);
      setName("");
      setStartingBalance(10000);
      setShowForm(false);
    }
    setIsSubmitting(false);
  }

  async function updateStatus(id, status) {
    const { error } = await supabase.from("accounts").update({ status }).eq("id", id);
    if (!error) setAccounts((a) => a.map((acc) => (acc.id === id ? { ...acc, status } : acc)));
  }

  async function deleteAccount(id) {
    const { error } = await supabase.from("accounts").delete().eq("id", id);
    if (!error) setAccounts((a) => a.filter((acc) => acc.id !== id));
  }

  const statusColor = { active: "emerald", passed: "emerald", failed: "red", breached: "red", archived: "zinc" };

  return (
    <div className="w-full max-w-md mx-auto">
      <SectionHeader>Accounts</SectionHeader>

      {loading && <div className="text-zinc-600 text-xs px-4 py-6 text-center" style={mono}>Loading...</div>}

      {!loading && accounts.length === 0 && !showForm && (
        <div className="border border-zinc-700 bg-zinc-900 px-4 py-8 text-center">
          <p className="text-zinc-500 text-xs mb-3" style={mono}>No accounts yet.</p>
        </div>
      )}

      {!loading && accounts.map((acc) => {
        const accTrades = trades.filter((t) => t.account_id === acc.id && t.status === "closed");
        const pnl = accTrades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
        const balance = parseFloat(acc.starting_balance) + pnl;
        const winCount = accTrades.filter((t) => parseFloat(t.pnl) > 0).length;
        const winRate = accTrades.length ? ((winCount / accTrades.length) * 100).toFixed(0) : null;

        return (
          <Block key={acc.id} className="mb-3">
            <div className="px-4 py-3 flex items-center justify-between border-b border-zinc-800">
              <div>
                <div className="text-zinc-200 text-sm font-medium" style={mono}>{acc.name}</div>
                <div className="text-zinc-600 text-xs" style={mono}>{acc.broker} · {acc.account_type.replace("_", " ")}</div>
              </div>
              <select
                value={acc.status}
                onChange={(e) => updateStatus(acc.id, e.target.value)}
                className={`bg-zinc-900 border border-${statusColor[acc.status]}-800 text-${statusColor[acc.status]}-400 text-xs px-2 py-1 uppercase tracking-wider`}
                style={mono}
              >
                {ACCOUNT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="px-4 py-3 flex items-center justify-between">
              <Label>Balance</Label>
              <span className={`text-lg font-semibold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>
                {fmt(balance)}
              </span>
            </div>
            <Divider />
            <div className="px-4 py-2 flex justify-between text-xs" style={mono}>
              <span className="text-zinc-600">{accTrades.length} closed trade{accTrades.length !== 1 ? "s" : ""}</span>
              <span className="text-zinc-600">{winRate !== null ? `${winRate}% win rate` : "—"}</span>
            </div>
            <Divider />
            <div className="px-4 py-2 flex justify-end">
              <button onClick={() => deleteAccount(acc.id)} className="text-red-500 text-xs hover:text-red-400" style={mono}>Delete</button>
            </div>
          </Block>
        );
      })}

      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="w-full border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 text-xs tracking-widest uppercase py-3 transition-colors"
          style={mono}
        >
          + Add Account
        </button>
      )}

      {showForm && (
        <Block>
          <Row label="Name"><StyledInput type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. FTMO Phase 1" /></Row>
          <Divider />
          <Row label="Broker">
            <StyledSelect value={broker} onChange={(e) => setBroker(e.target.value)}>
              {BROKERS.map((b) => <option key={b} value={b}>{b}</option>)}
            </StyledSelect>
          </Row>
          <Divider />
          <Row label="Type">
            <StyledSelect value={accountType} onChange={(e) => setAccountType(e.target.value)}>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
            </StyledSelect>
          </Row>
          <Divider />
          <Row label="Starting Balance">
            <StyledInput value={startingBalance} step={100} min={0} onChange={(e) => setStartingBalance(e.target.value)} />
          </Row>
          <Divider />
          <div className="px-4 py-3 flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-xs tracking-widest uppercase bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700" style={mono}>Cancel</button>
            <button onClick={createAccount} disabled={isSubmitting || !name.trim()} className="flex-1 py-2.5 text-xs tracking-widest uppercase bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900 disabled:opacity-50" style={mono}>
              {isSubmitting ? "Adding..." : "Add"}
            </button>
          </div>
        </Block>
      )}
    </div>
  );
}

// ─── PAGE 4: ECONOMIC CALENDAR ────────────────────────────────────────────────

const EconomicCalendarWidget = memo(function EconomicCalendarWidget() {
  const container = useRef();

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://www.tradays.com/c/js/widgets/calendar/widget.js?v=15";
    script.type = "text/javascript";
    script.async = true;
    script.dataset.type = "calendar-widget";
    script.innerHTML = JSON.stringify({
      width: "100%",
      height: "100%",
      mode: "2",
      fw: "react",
      theme: 1,
      timezone: "Africa/Nairobi",
    });
    container.current?.appendChild(script);
  }, []);

  return (
    <div ref={container} style={{ minHeight: 500 }}>
      <div id="economicCalendarWidget"></div>
      <div className="ecw-copyright text-zinc-700 text-xs mt-1" style={mono}>
        <a
          href="https://www.metatrader.com/?utm_source=calendar.widget&utm_medium=link&utm_term=economic.calendar&utm_content=visit.mql5.calendar&utm_campaign=202.calendar.widget"
          rel="noopener nofollow"
          target="_blank"
          className="hover:text-zinc-500"
        >
          MetaTrader World Markets
        </a>
      </div>
    </div>
  );
});

function CalendarPage() {
  return (
    <div className="w-full max-w-2xl mx-auto">
      <SectionHeader>Economic Calendar</SectionHeader>
      <Block>
        <div className="px-2 py-2">
          <EconomicCalendarWidget />
        </div>
      </Block>
    </div>
  );
}

// ─── PAGE 3.5: ANALYTICS ──────────────────────────────────────────────────────

function groupPnL(trades, keyFn) {
  const groups = {};
  for (const t of trades) {
    const key = keyFn(t);
    if (!key) continue;
    if (!groups[key]) groups[key] = { key, trades: 0, wins: 0, pnl: 0 };
    groups[key].trades += 1;
    groups[key].pnl += parseFloat(t.pnl) || 0;
    if (parseFloat(t.pnl) > 0) groups[key].wins += 1;
  }
  return Object.values(groups)
    .map((g) => ({ ...g, winRate: g.trades ? Math.round((g.wins / g.trades) * 100) : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
}

function AnalyticsTable({ title, rows }) {
  if (!rows.length) return null;
  return (
    <Block className="mb-3">
      <div className="px-4 py-2 border-b border-zinc-800">
        <span className="text-zinc-500 text-xs tracking-widest uppercase" style={mono}>{title}</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="px-4 py-2 flex items-center justify-between border-b border-zinc-800 last:border-b-0">
          <div className="flex items-center gap-2">
            <span className="text-zinc-300 text-xs font-medium" style={mono}>{r.key}</span>
            <span className="text-zinc-700 text-xs" style={mono}>{r.trades} trade{r.trades !== 1 ? "s" : ""} · {r.winRate}% win</span>
          </div>
          <span className={`text-sm font-semibold tabular-nums ${r.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>
            {fmt(r.pnl)}
          </span>
        </div>
      ))}
    </Block>
  );
}

function AnalyticsPage() {
  const [trades, setTrades] = useState([]);
  const [setups, setSetups] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      supabase.from("trades").select("*").eq("status", "closed").order("closed_at", { ascending: true }),
      supabase.from("setups").select("id, name"),
    ]).then(([tradeRes, setupRes]) => {
      if (tradeRes.data) setTrades(tradeRes.data);
      if (setupRes.data) setSetups(setupRes.data);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div className="text-zinc-600 text-xs px-4 py-6 text-center" style={mono}>Loading...</div>;
  }

  if (!trades.length) {
    return (
      <div className="w-full max-w-md mx-auto">
        <SectionHeader>Analytics</SectionHeader>
        <div className="border border-zinc-700 bg-zinc-900 px-4 py-8 text-center">
          <p className="text-zinc-500 text-xs" style={mono}>No closed trades yet — analytics fill in as you close trades.</p>
        </div>
      </div>
    );
  }

  const totalPnl = trades.reduce((s, t) => s + (parseFloat(t.pnl) || 0), 0);
  const totalWins = trades.filter((t) => parseFloat(t.pnl) > 0).length;
  const overallWinRate = Math.round((totalWins / trades.length) * 100);

  const setupNameById = Object.fromEntries(setups.map((s) => [s.id, s.name]));
  const byAsset = groupPnL(trades, (t) => t.asset);
  const bySession = groupPnL(trades, (t) => t.session);
  const byDirection = groupPnL(trades, (t) => t.direction === "long" ? "Long" : t.direction === "short" ? "Short" : null);
  const bySetup = groupPnL(trades, (t) => t.setup_id ? (setupNameById[t.setup_id] || "Unknown setup") : null);
  const byDayOfWeek = groupPnL(trades, (t) => {
    if (!t.closed_at) return null;
    return new Date(t.closed_at).toLocaleDateString("en-US", { weekday: "long" });
  });

  const equityCurve = trades.reduce((acc, t) => {
    const prev = acc.length ? acc[acc.length - 1].equity : 0;
    acc.push({ label: acc.length + 1, equity: prev + (parseFloat(t.pnl) || 0) });
    return acc;
  }, []);

  return (
    <div className="w-full max-w-md mx-auto">
      <SectionHeader>Analytics</SectionHeader>

      <div className="border border-zinc-700 border-b-0 px-4 py-4 bg-zinc-900 flex items-center justify-between">
        <Label>Total PnL</Label>
        <span className={`text-2xl font-semibold tracking-tight tabular-nums ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>
          {fmt(totalPnl)}
        </span>
      </div>
      <div className="border border-zinc-700 border-t-0 px-4 py-2 bg-zinc-900 flex items-center justify-between mb-4">
        <Label>Win Rate</Label>
        <span className="text-zinc-300 text-sm tabular-nums" style={mono}>{overallWinRate}% ({trades.length} trades)</span>
      </div>

      {equityCurve.length > 1 && (
        <Block className="mb-4">
          <div className="px-4 py-2 border-b border-zinc-800">
            <span className="text-zinc-500 text-xs tracking-widest uppercase" style={mono}>Equity Curve</span>
          </div>
          <div className="px-2 py-3" style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equityCurve}>
                <XAxis dataKey="label" hide />
                <YAxis hide domain={["auto", "auto"]} />
                <ReferenceLine y={0} stroke="#3f3f46" />
                <Tooltip
                  formatter={(v) => fmt(v)}
                  labelFormatter={() => ""}
                  contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }}
                />
                <Line type="monotone" dataKey="equity" stroke="#34d399" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Block>
      )}

      <AnalyticsTable title="By Asset" rows={byAsset} />
      <AnalyticsTable title="By Session" rows={bySession} />
      <AnalyticsTable title="By Direction" rows={byDirection} />
      <AnalyticsTable title="By Setup" rows={bySetup} />
      <AnalyticsTable title="By Day of Week" rows={byDayOfWeek} />
    </div>
  );
}

// ─── PAGE 5: SETUPS ───────────────────────────────────────────────────────────

function parseLines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function SetupsPage() {
  const [setups, setSetups] = useState([]);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const [name, setName] = useState("");
  const [instrument, setInstrument] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [session, setSession] = useState("");
  const [description, setDescription] = useState("");
  const [entryCriteria, setEntryCriteria] = useState("");
  const [exitCriteria, setExitCriteria] = useState("");
  const [invalidations, setInvalidations] = useState("");

  useEffect(() => {
    Promise.all([
      supabase.from("setups").select("*").order("created_at", { ascending: false }),
      supabase.from("trades").select("setup_id, pnl, status"),
    ]).then(([setupRes, tradeRes]) => {
      if (setupRes.data) setSetups(setupRes.data);
      if (tradeRes.data) setTrades(tradeRes.data);
      setLoading(false);
    });
  }, []);

  async function createSetup() {
    if (!name.trim()) return;
    setIsSubmitting(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from("setups").insert({
      user_id: user?.id,
      name: name.trim(),
      instrument: instrument.trim() || null,
      timeframe: timeframe.trim() || null,
      session: session || null,
      description: description.trim() || null,
      entry_criteria: parseLines(entryCriteria),
      exit_criteria: parseLines(exitCriteria),
      invalidations: parseLines(invalidations),
    }).select().single();
    if (!error && data) {
      setSetups((s) => [data, ...s]);
      setName(""); setInstrument(""); setTimeframe(""); setSession("");
      setDescription(""); setEntryCriteria(""); setExitCriteria(""); setInvalidations("");
      setShowForm(false);
    }
    setIsSubmitting(false);
  }

  async function deleteSetup(id) {
    const { error } = await supabase.from("setups").delete().eq("id", id);
    if (!error) setSetups((s) => s.filter((x) => x.id !== id));
  }

  return (
    <div className="w-full max-w-md mx-auto">
      <SectionHeader>Setups</SectionHeader>

      {loading && <div className="text-zinc-600 text-xs px-4 py-6 text-center" style={mono}>Loading...</div>}

      {!loading && setups.length === 0 && !showForm && (
        <div className="border border-zinc-700 bg-zinc-900 px-4 py-8 text-center mb-4">
          <p className="text-zinc-500 text-xs" style={mono}>No setups yet. Define your trading models here and link trades to them from the planner.</p>
        </div>
      )}

      {!loading && setups.map((s) => {
        const setupTrades = trades.filter((t) => t.setup_id === s.id && t.status === "closed");
        const pnl = setupTrades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
        const wins = setupTrades.filter((t) => parseFloat(t.pnl) > 0).length;
        const winRate = setupTrades.length ? Math.round((wins / setupTrades.length) * 100) : null;
        const isOpen = expandedId === s.id;

        return (
          <Block key={s.id} className="mb-3">
            <button onClick={() => setExpandedId(isOpen ? null : s.id)} className="w-full px-4 py-3 flex items-center justify-between border-b border-zinc-800 text-left">
              <div>
                <div className="text-zinc-200 text-sm font-medium" style={mono}>{s.name}</div>
                <div className="text-zinc-600 text-xs" style={mono}>
                  {[s.instrument, s.timeframe, s.session].filter(Boolean).join(" · ") || "No details set"}
                </div>
              </div>
              <span className="text-zinc-600 text-xs">{isOpen ? "▲" : "▼"}</span>
            </button>

            <div className="px-4 py-2 flex justify-between text-xs" style={mono}>
              <span className="text-zinc-600">{setupTrades.length} closed trade{setupTrades.length !== 1 ? "s" : ""}</span>
              <div className="flex items-center gap-3">
                {winRate !== null && <span className="text-zinc-600">{winRate}% win</span>}
                <span className={`font-semibold ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(pnl)}</span>
              </div>
            </div>

            {isOpen && (
              <>
                <Divider />
                {s.description && (
                  <div className="px-4 py-3 border-b border-zinc-800">
                    <span className="text-zinc-500 text-xs">{s.description}</span>
                  </div>
                )}
                {[["Entry Criteria", s.entry_criteria], ["Exit Criteria", s.exit_criteria], ["Invalidations", s.invalidations]].map(([label, items]) => (
                  items && items.length > 0 && (
                    <div key={label} className="px-4 py-3 border-b border-zinc-800">
                      <span className="text-zinc-700 text-xs tracking-widest uppercase block mb-1.5">{label}</span>
                      <ul className="space-y-1">
                        {items.map((item, i) => (
                          <li key={i} className="text-zinc-400 text-xs flex gap-2">
                            <span className="text-zinc-700">·</span>{item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                ))}
                <div className="px-4 py-2 flex justify-end">
                  <button onClick={() => deleteSetup(s.id)} className="text-red-500 text-xs hover:text-red-400" style={mono}>Delete</button>
                </div>
              </>
            )}
          </Block>
        );
      })}

      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="w-full border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 text-xs tracking-widest uppercase py-3 transition-colors"
          style={mono}
        >
          + Add Setup
        </button>
      )}

      {showForm && (
        <Block>
          <Row label="Name"><StyledInput type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Asian Range - London" /></Row>
          <Divider />
          <Row label="Instrument"><StyledInput type="text" value={instrument} onChange={(e) => setInstrument(e.target.value)} placeholder="e.g. GBPUSD" /></Row>
          <Divider />
          <Row label="Timeframe"><StyledInput type="text" value={timeframe} onChange={(e) => setTimeframe(e.target.value)} placeholder="e.g. M5" /></Row>
          <Divider />
          <Row label="Session">
            <StyledSelect value={session} onChange={(e) => setSession(e.target.value)}>
              <option value="">— None —</option>
              {["Asian", "London", "NY", "Overlap"].map((s) => <option key={s} value={s}>{s}</option>)}
            </StyledSelect>
          </Row>
          <Divider />
          <div className="px-4 py-2">
            <span className="text-zinc-700 text-xs tracking-widest uppercase block mb-1.5">Description</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs px-2 py-1.5 focus:outline-none focus:border-zinc-600" style={mono} />
          </div>
          <Divider />
          <div className="px-4 py-2">
            <span className="text-zinc-700 text-xs tracking-widest uppercase block mb-1.5">Entry Criteria (one per line)</span>
            <textarea value={entryCriteria} onChange={(e) => setEntryCriteria(e.target.value)} rows={3}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs px-2 py-1.5 focus:outline-none focus:border-zinc-600" style={mono} />
          </div>
          <Divider />
          <div className="px-4 py-2">
            <span className="text-zinc-700 text-xs tracking-widest uppercase block mb-1.5">Exit Criteria (one per line)</span>
            <textarea value={exitCriteria} onChange={(e) => setExitCriteria(e.target.value)} rows={3}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs px-2 py-1.5 focus:outline-none focus:border-zinc-600" style={mono} />
          </div>
          <Divider />
          <div className="px-4 py-2">
            <span className="text-zinc-700 text-xs tracking-widest uppercase block mb-1.5">Invalidations (one per line)</span>
            <textarea value={invalidations} onChange={(e) => setInvalidations(e.target.value)} rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs px-2 py-1.5 focus:outline-none focus:border-zinc-600" style={mono} />
          </div>
          <Divider />
          <div className="px-4 py-3 flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-xs tracking-widest uppercase bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700" style={mono}>Cancel</button>
            <button onClick={createSetup} disabled={isSubmitting || !name.trim()} className="flex-1 py-2.5 text-xs tracking-widest uppercase bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900 disabled:opacity-50" style={mono}>
              {isSubmitting ? "Adding..." : "Add"}
            </button>
          </div>
        </Block>
      )}
    </div>
  );
}

// ─── PAGE 6: BACKTESTING ──────────────────────────────────────────────────────

function BacktestPage() {
  const [backtests, setBacktests] = useState([]);
  const [setups, setSetups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [filterSetup, setFilterSetup] = useState("");

  const [bAsset, setBAsset] = useState("GBPUSD");
  const [bDirection, setBDirection] = useState("long");
  const [bSetupId, setBSetupId] = useState("");
  const [bDate, setBDate] = useState("");
  const [bResult, setBResult] = useState("win");
  const [bR, setBR] = useState("");
  const [bNotes, setBNotes] = useState("");

  useEffect(() => {
    Promise.all([
      supabase.from("backtests").select("*").order("trade_date", { ascending: false }),
      supabase.from("setups").select("id, name"),
    ]).then(([btRes, setupRes]) => {
      if (btRes.data) setBacktests(btRes.data);
      if (setupRes.data) setSetups(setupRes.data);
      setLoading(false);
    });
  }, []);

  const setupNameById = Object.fromEntries(setups.map((s) => [s.id, s.name]));

  async function addBacktest() {
    setIsSubmitting(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase.from("backtests").insert({
      user_id: user?.id,
      asset: bAsset,
      direction: bDirection,
      setup_id: bSetupId || null,
      trade_date: bDate || null,
      result: bResult,
      r_multiple: bR ? parseFloat(bR) : null,
      notes: bNotes.trim() || null,
    }).select().single();
    if (!error && data) {
      setBacktests((b) => [data, ...b]);
      setBDate(""); setBR(""); setBNotes("");
      setShowForm(false);
    }
    setIsSubmitting(false);
  }

  async function deleteBacktest(id) {
    const { error } = await supabase.from("backtests").delete().eq("id", id);
    if (!error) setBacktests((b) => b.filter((x) => x.id !== id));
  }

  const filtered = filterSetup ? backtests.filter((b) => b.setup_id === filterSetup) : backtests;
  const totalR = filtered.reduce((s, b) => s + (parseFloat(b.r_multiple) || 0), 0);
  const wins = filtered.filter((b) => b.result === "win").length;
  const winRate = filtered.length ? Math.round((wins / filtered.length) * 100) : 0;
  const expectancy = filtered.length ? (totalR / filtered.length).toFixed(2) : "0.00";

  return (
    <div className="w-full max-w-md mx-auto">
      <SectionHeader>Backtesting</SectionHeader>

      {setups.length > 0 && (
        <div className="mb-3">
          <StyledSelect value={filterSetup} onChange={(e) => setFilterSetup(e.target.value)}>
            <option value="">All setups</option>
            {setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </StyledSelect>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <Block className="mb-4">
          <div className="px-4 py-3 flex items-center justify-between border-b border-zinc-800">
            <Label>Total R</Label>
            <span className={`text-lg font-semibold tabular-nums ${totalR >= 0 ? "text-emerald-400" : "text-red-400"}`} style={mono}>
              {totalR >= 0 ? "+" : ""}{totalR.toFixed(2)}R
            </span>
          </div>
          <div className="px-4 py-2 flex justify-between text-xs" style={mono}>
            <span className="text-zinc-600">{filtered.length} sample{filtered.length !== 1 ? "s" : ""} · {winRate}% win</span>
            <span className="text-zinc-600">Expectancy: {expectancy}R</span>
          </div>
        </Block>
      )}

      {loading && <div className="text-zinc-600 text-xs px-4 py-6 text-center" style={mono}>Loading...</div>}

      {!loading && filtered.length === 0 && !showForm && (
        <div className="border border-zinc-700 bg-zinc-900 px-4 py-8 text-center mb-4">
          <p className="text-zinc-500 text-xs" style={mono}>No backtest samples logged yet.</p>
        </div>
      )}

      {!loading && filtered.map((b) => (
        <Block key={b.id} className="mb-2">
          <div className="px-4 py-2.5 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-zinc-200 text-xs font-medium" style={mono}>{b.asset}</span>
                <Badge color={b.direction === "long" ? "emerald" : "red"}>{b.direction}</Badge>
                {b.setup_id && <span className="text-zinc-600 text-xs" style={mono}>{setupNameById[b.setup_id] || "—"}</span>}
              </div>
              {b.trade_date && <div className="text-zinc-700 text-xs mt-0.5" style={mono}>{b.trade_date}</div>}
              {b.notes && <div className="text-zinc-600 text-xs mt-1">{b.notes}</div>}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={`text-sm font-semibold tabular-nums ${
                b.result === "win" ? "text-emerald-400" : b.result === "loss" ? "text-red-400" : "text-zinc-500"
              }`} style={mono}>
                {b.r_multiple != null ? `${parseFloat(b.r_multiple) >= 0 ? "+" : ""}${b.r_multiple}R` : b.result}
              </span>
              <button onClick={() => deleteBacktest(b.id)} className="text-red-600 text-xs hover:text-red-400">✕</button>
            </div>
          </div>
        </Block>
      ))}

      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="w-full border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 text-xs tracking-widest uppercase py-3 transition-colors mt-2"
          style={mono}
        >
          + Log Backtest Sample
        </button>
      )}

      {showForm && (
        <Block>
          <Row label="Asset">
            <StyledSelect value={bAsset} onChange={(e) => setBAsset(e.target.value)}>
              {Object.keys(ASSETS).map((k) => <option key={k} value={k}>{k}</option>)}
            </StyledSelect>
          </Row>
          <Divider />
          <Row label="Direction">
            <div className="flex gap-2">
              {["long", "short"].map((d) => (
                <button key={d} onClick={() => setBDirection(d)}
                  className={`px-3 py-1 text-xs tracking-widest uppercase rounded-sm transition-colors ${
                    bDirection === d
                      ? d === "long" ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
                      : "bg-zinc-800 text-zinc-600 hover:text-zinc-400"
                  }`} style={mono}>
                  {d === "long" ? "▲ Long" : "▼ Short"}
                </button>
              ))}
            </div>
          </Row>
          <Divider />
          <Row label="Setup">
            <StyledSelect value={bSetupId} onChange={(e) => setBSetupId(e.target.value)}>
              <option value="">— None —</option>
              {setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </StyledSelect>
          </Row>
          <Divider />
          <Row label="Date"><StyledInput type="date" value={bDate} onChange={(e) => setBDate(e.target.value)} /></Row>
          <Divider />
          <Row label="Result">
            <StyledSelect value={bResult} onChange={(e) => setBResult(e.target.value)}>
              <option value="win">Win</option>
              <option value="loss">Loss</option>
              <option value="breakeven">Breakeven</option>
            </StyledSelect>
          </Row>
          <Divider />
          <Row label="R Multiple"><StyledInput value={bR} step={0.1} onChange={(e) => setBR(e.target.value)} placeholder="e.g. 2.5 or -1" /></Row>
          <Divider />
          <div className="px-4 py-2">
            <span className="text-zinc-700 text-xs tracking-widest uppercase block mb-1.5">Notes</span>
            <textarea value={bNotes} onChange={(e) => setBNotes(e.target.value)} rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs px-2 py-1.5 focus:outline-none focus:border-zinc-600" style={mono} />
          </div>
          <Divider />
          <div className="px-4 py-3 flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-xs tracking-widest uppercase bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700" style={mono}>Cancel</button>
            <button onClick={addBacktest} disabled={isSubmitting} className="flex-1 py-2.5 text-xs tracking-widest uppercase bg-emerald-950 text-emerald-400 border border-emerald-800 hover:bg-emerald-900 disabled:opacity-50" style={mono}>
              {isSubmitting ? "Adding..." : "Add"}
            </button>
          </div>
        </Block>
      )}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────

function App() {
  const [session, setSession] = useState(null);
  const [page, setPage] = useState("calc");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("arx_theme") || "dark"; } catch { return "dark"; }
  });

  useEffect(() => {
    try { localStorage.setItem("arx_theme", theme); } catch {}
  }, [theme]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function deleteAccount() {
    setDeleteError("");
    const { error } = await supabase.rpc("delete_user_account");
    if (error) {
      setDeleteError(error.message);
    } else {
      await supabase.auth.signOut();
    }
  }

  if (!session) {
    return <AuthGate />;
  }

  const username = session.user.user_metadata?.username || session.user.email?.split("@")[0] || "user";

  return (
    <div className={theme === "dark" ? "dark" : ""}>
    <div className="min-h-screen bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-4 pb-12 transition-colors">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 pt-2 flex justify-between items-center">
          <h1 className="text-zinc-800 dark:text-zinc-200 text-sm font-semibold tracking-tight">
            Arx Trading Tools
          </h1>

          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 text-xs flex items-center gap-2 transition-colors"
            >
              <span className="text-amber-600 dark:text-amber-400 font-medium">@{username}</span>
              <span>▾</span>
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg z-50 overflow-hidden">
                <div className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800">
                  <span className="text-zinc-500 text-xs" style={mono}>{session.user.email}</span>
                </div>

                <button
                  onClick={() => { supabase.auth.signOut(); setMenuOpen(false); }}
                  className="w-full text-left px-4 py-2.5 text-xs font-medium transition-colors text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Sign Out
                </button>

                <button
                  onClick={() => { setShowDeleteConfirm(true); setMenuOpen(false); }}
                  className="w-full text-left px-4 py-2.5 text-xs font-medium transition-colors text-red-600 dark:text-red-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Delete Account
                </button>
              </div>
            )}
          </div>
        </div>

        <Nav page={page} setPage={setPage} theme={theme} setTheme={setTheme} />

        {page === "calc" && <MarginCalcPage />}
        {page === "journal" && <TradeJournalPage />}
        {page === "accounts" && <AccountsPage />}
        {page === "analytics" && <AnalyticsPage />}
        {page === "setups" && <SetupsPage />}
        {page === "backtest" && <BacktestPage />}
        {page === "calendar" && <CalendarPage />}
      </div>

      {/* Delete Account Confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-sm border border-red-900 bg-zinc-950" style={mono}>
            <div className="border-b border-red-900 px-4 py-3 flex items-center justify-between">
              <span className="text-red-400 text-xs tracking-widest uppercase">Delete Account</span>
              <button onClick={() => { setShowDeleteConfirm(false); setDeleteError(""); }} className="text-zinc-600 hover:text-zinc-400 text-xs">✕</button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-zinc-400 text-xs">
                This will permanently delete your account and all associated trades. This action cannot be undone.
              </p>

              {deleteError && (
                <div className="px-3 py-2 border border-red-900 bg-red-950 text-red-400 text-xs">
                  {deleteError}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => { setShowDeleteConfirm(false); setDeleteError(""); }}
                  className="flex-1 py-2.5 text-xs tracking-widest uppercase font-medium transition-colors bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700"
                  style={mono}
                >
                  Cancel
                </button>
                <button
                  onClick={deleteAccount}
                  className="flex-1 py-2.5 text-xs tracking-widest uppercase font-medium transition-colors bg-red-950 text-red-400 border border-red-800 hover:bg-red-900"
                  style={mono}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

export default App;

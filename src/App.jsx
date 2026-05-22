import { useState, useMemo, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────────

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://ttotfguudxiwwsvqknlz.supabase.co";
const supabaseKey = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_uD1GClVKzQG-pgcB2r3iLQ_ZUgAyxIQ";
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── DATA ────────────────────────────────────────────────────────────────────

const ASSETS = {
  GBPUSD: { price: 1.34308, contractSize: 100000, type: "Forex", usdBase: false, pipSize: 0.0001 },
  USDJPY: { price: 158.995, contractSize: 100000, type: "Forex", usdBase: true, pipSize: 0.01 },
  NDAQ100: { price: 29475.65, contractSize: 1, type: "Index", usdBase: false, pipSize: 1 },
  US30: { price: 50405.92, contractSize: 1, type: "Index", usdBase: false, pipSize: 1 },
  US100M: { price: 29539.25, contractSize: 1, type: "Index", usdBase: false, pipSize: 1 },
};

const BROKERS = ["FxPro", "JustMarkets", "Headway"];
const LEVERAGE_OPTIONS = [1, 10, 50, 100, 200, 500, 1000, 2000, "Unlimited"];

// ─── CALC HELPERS ─────────────────────────────────────────────────────────────

function getEffectiveLeverage(broker, assetType, leverage) {
  if (leverage === "Unlimited") {
    if (broker === "FxPro" && assetType === "Index") return 500;
    return "Unlimited";
  }
  if (broker === "FxPro" && assetType === "Index" && leverage > 500) return 500;
  return leverage;
}

function calcMargin(asset, price, lotSize, effectiveLeverage) {
  if (effectiveLeverage === "Unlimited") return 0;
  const { contractSize, usdBase } = asset;
  if (usdBase) return (lotSize * contractSize) / effectiveLeverage;
  return (lotSize * contractSize * price) / effectiveLeverage;
}

function calcPipValue(asset, price, lotSize) {
  const { contractSize, pipSize, usdBase } = asset;
  if (usdBase) return (pipSize * contractSize * lotSize) / price;
  return pipSize * contractSize * lotSize;
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

const mono = { fontFamily: "'IBM Plex Mono', 'Courier New', monospace" };

function Label({ children }) {
  return <span className="text-zinc-500 text-xs tracking-widest uppercase shrink-0">{children}</span>;
}

function Row({ label, children }) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-4">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Divider() { return <div className="border-t border-zinc-800 mx-4" />; }

function StyledSelect({ value, onChange, children }) {
  return (
    <select value={value} onChange={onChange} style={mono}
      className="bg-transparent text-zinc-200 text-sm text-right outline-none cursor-pointer border-none appearance-none">
      {children}
    </select>
  );
}

function StyledInput({ value, onChange, type = "number", placeholder, step, min, className = "" }) {
  return (
    <input type={type} value={value} onChange={onChange} step={step} min={min} placeholder={placeholder}
      style={mono}
      className={`bg-transparent text-zinc-200 text-sm text-right outline-none border-none tabular-nums ${className}`}
    />
  );
}

function Badge({ children, color = "zinc" }) {
  const colors = {
    zinc: "bg-zinc-800 text-zinc-400",
    emerald: "bg-emerald-950 text-emerald-400",
    red: "bg-red-950 text-red-400",
    amber: "bg-amber-950 text-amber-400",
    blue: "bg-blue-950 text-blue-400",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-sm font-medium tracking-wide ${colors[color]}`} style={mono}>
      {children}
    </span>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="border border-zinc-700 border-b-0 px-4 py-3 bg-zinc-900 flex items-center justify-between">
      <span className="text-zinc-400 text-xs tracking-widest uppercase">{children}</span>
    </div>
  );
}

function Block({ children, className = "" }) {
  return <div className={`border border-zinc-700 bg-zinc-900 ${className}`}>{children}</div>;
}

// ─── NAV ──────────────────────────────────────────────────────────────────────

function Nav({ page, setPage }) {
  return (
    <div className="flex border-b border-zinc-800 mb-6" style={mono}>
      {[["calc", "Margin Calc"], ["journal", "Trade Journal"]].map(([key, label]) => (
        <button key={key} onClick={() => setPage(key)}
          className={`px-5 py-3 text-xs tracking-widest uppercase transition-colors ${
            page === key
              ? "text-emerald-400 border-b-2 border-emerald-500 -mb-px"
              : "text-zinc-600 hover:text-zinc-400"
          }`}>
          {label}
        </button>
      ))}
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

  const asset = ASSETS[assetKey];
  const effectiveLeverage = getEffectiveLeverage(broker, asset.type, leverage);
  const margin = calcMargin(asset, price, lotSize, effectiveLeverage);
  const pipValue = calcPipValue(asset, price, lotSize);
  const leverageCapped = broker === "FxPro" && asset.type === "Index" && (leverage === "Unlimited" || leverage > 500);

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

      {leverageCapped && (
        <div className="border border-amber-800 border-b-0 px-4 py-2 bg-amber-950 flex items-center gap-2">
          <span className="text-amber-500 text-xs">▲</span>
          <span className="text-amber-400 text-xs">FxPro caps index leverage at 1:500. Using 1:500.</span>
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
          {asset.usdBase && (
            <div className="flex flex-col gap-0.5">
              <span className="text-zinc-700 text-xs tracking-widest uppercase">Base</span>
              <span className="text-amber-500 text-xs font-medium">USD</span>
            </div>
          )}
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
  const [view, setView] = useState("planner"); // planner | log
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── Load Data ──
  useEffect(() => {
    supabase.from("trades").select("*").order("opened_at", { ascending: false })
      .then(({ data, error }) => {
        if (data && !error) setTrades(data);
      });
  }, []);

  // ── Planner state ──
  const [pAsset, setPAsset] = useState("GBPUSD");
  const [pDirection, setPDirection] = useState("long");
  const [pEntry, setPEntry] = useState(ASSETS.GBPUSD.price);
  const [pTP, setPTP] = useState("");
  const [pSL, setPSL] = useState("");
  const [pLotSize, setPLotSize] = useState(0.01);

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
    
    const { data, error } = await supabase.from("trades").insert({
      asset: pAsset,
      direction: pDirection,
      lot_size: pLotSize,
      entry_price: parseFloat(pEntry),
      tp_price: parseFloat(pTP),
      sl_price: parseFloat(pSL),
      status: "open"
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

// ─── ROOT ─────────────────────────────────────────────────────────────────────

function App() {
  const [page, setPage] = useState("calc");

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 pb-12">
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      <div className="max-w-2xl mx-auto">
        <div className="mb-6 pt-2">
          <h1 className="text-zinc-300 text-xs tracking-[0.3em] uppercase" style={mono}>
            Arx Trading Tools
          </h1>
        </div>

        <Nav page={page} setPage={setPage} />

        {page === "calc" && <MarginCalcPage />}
        {page === "journal" && <TradeJournalPage />}
      </div>
    </div>
  );
}

export default App;

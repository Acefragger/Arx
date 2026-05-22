import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://ttotfguudxiwwsvqknlz.supabase.co";
const supabaseKey = process.env.VITE_SUPABASE_KEY || "sb_publishable_uD1GClVKzQG-pgcB2r3iLQ_ZUgAyxIQ";
const supabase = createClient(supabaseUrl, supabaseKey);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function testConnection() {
  console.log("\n[Test 1] Supabase Connection");
  const { data, error } = await supabase.from("trades").select("count").limit(1);
  assert(!error, "Connection successful");
  if (error) console.error(`    Error: ${error.message}`);
}

async function testReadTrades() {
  console.log("\n[Test 2] Read Trades");
  const { data, error } = await supabase.from("trades").select("*").order("opened_at", { ascending: false }).limit(5);
  assert(!error, "Query executed without error");
  assert(Array.isArray(data), "Returned data is an array");
  console.log(`    Found ${data?.length || 0} recent trades`);
  
  if (data && data.length > 0) {
    const sample = data[0];
    assert(sample.id, "Trade has ID");
    assert(sample.asset, "Trade has asset");
    assert(sample.entry_price, "Trade has entry_price");
    assert(sample.direction, "Trade has direction");
    assert(sample.status, "Trade has status");
  }
}

async function testInsertTrade() {
  console.log("\n[Test 3] Insert Trade");
  const testTrade = {
    asset: "GBPUSD",
    direction: "long",
    lot_size: 0.01,
    entry_price: 1.25000,
    tp_price: 1.26000,
    sl_price: 1.24500,
    status: "open"
  };

  const { data, error } = await supabase.from("trades").insert(testTrade).select().single();
  
  assert(!error, "Insert executed without error");
  if (error) {
    console.error(`    Error: ${error.message}`);
    return null;
  }
  
  assert(data.id, "Inserted trade has ID");
  assert(data.asset === "GBPUSD", "Asset matches");
  assert(data.direction === "long", "Direction matches");
  assert(data.entry_price === 1.25000, "Entry price matches");
  assert(data.status === "open", "Status is open");
  
  return data.id;
}

async function testUpdateTrade(tradeId) {
  console.log("\n[Test 4] Update/Close Trade");
  if (!tradeId) {
    console.log("    Skipped (no trade ID from insert test)");
    return;
  }

  const updatePayload = {
    status: "closed",
    outcome: "TP",
    close_price: 1.26000,
    pnl: 10.00,
    pips: 100.0,
    closed_at: new Date().toISOString()
  };

  const { error } = await supabase.from("trades").update(updatePayload).eq("id", tradeId);
  assert(!error, "Update executed without error");
  if (error) {
    console.error(`    Error: ${error.message}`);
    return;
  }

  // Verify the update
  const { data } = await supabase.from("trades").select("*").eq("id", tradeId).single();
  assert(data.status === "closed", "Status updated to closed");
  assert(data.outcome === "TP", "Outcome set to TP");
  assert(data.close_price === 1.26000, "Close price matches");
  assert(data.pnl === 10.00, "PnL matches");
}

async function testDeleteTestTrade(tradeId) {
  console.log("\n[Test 5] Cleanup Test Trade");
  if (!tradeId) {
    console.log("    Skipped (no trade ID to delete)");
    return;
  }

  const { error } = await supabase.from("trades").delete().eq("id", tradeId);
  assert(!error, "Test trade deleted");
  if (error) console.error(`    Error: ${error.message}`);
}

async function runTests() {
  console.log("═══════════════════════════════════════════");
  console.log("  Arx Trading - Supabase Integration Tests");
  console.log("═══════════════════════════════════════════");

  await testConnection();
  await testReadTrades();
  const tradeId = await testInsertTrade();
  await testUpdateTrade(tradeId);
  await testDeleteTestTrade(tradeId);

  console.log("\n═══════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════\n");
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

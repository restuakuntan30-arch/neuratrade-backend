// ═══════════════════════════════════════════════════════
//  NEURATRADE BACKEND v2.0
//  Tambahan: /api/balance untuk ambil saldo real dari exchange
// ═══════════════════════════════════════════════════════

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const app     = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

const { createClient } = require("@supabase/supabase-js");
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Health Check ─────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ service: "NeuraTrade Backend", version: "2.0", status: "running", time: new Date().toISOString() });
});
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════
//  REAL BALANCE — Ambil saldo dari exchange
// ═══════════════════════════════════════════════════════
app.post("/api/balance", async (req, res) => {
  const apiKey    = req.headers["x-api-key"];
  const secretKey = req.headers["x-secret"];
  const exchange  = (req.headers["x-exchange"] || "binance").toLowerCase();

  if (!apiKey || !secretKey) {
    return res.status(400).json({ error: "API key dan Secret key diperlukan" });
  }

  try {
    if (exchange === "binance") {
      // ── Binance: GET /api/v3/account ──────────────────
      const timestamp = Date.now();
      const params    = new URLSearchParams({ timestamp: timestamp.toString() });
      const signature = crypto.createHmac("sha256", secretKey)
        .update(params.toString()).digest("hex");
      params.append("signature", signature);

      const response = await fetch(
        "https://api.binance.com/api/v3/account?" + params.toString(),
        { headers: { "X-MBX-APIKEY": apiKey } }
      );
      const data = await response.json();

      if (data.code) {
        return res.status(400).json({ error: "Binance error: " + data.msg });
      }

      // Return semua aset yang punya saldo > 0
      const balances = (data.balances || [])
        .map(function(b) {
          return { asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) };
        })
        .filter(function(b) { return b.free > 0 || b.locked > 0; })
        .sort(function(a, b) { return b.free - a.free; });

      // Hitung total dalam USDT
      const usdtBalance = balances.find(function(b) { return b.asset === "USDT"; });
      const usdcBalance = balances.find(function(b) { return b.asset === "USDC"; });
      const busdBalance = balances.find(function(b) { return b.asset === "BUSD"; });

      const totalUsdt = (usdtBalance ? usdtBalance.free : 0)
                      + (usdcBalance ? usdcBalance.free : 0)
                      + (busdBalance ? busdBalance.free : 0);

      return res.json({
        exchange:    "binance",
        totalUsdt:   Math.round(totalUsdt * 100) / 100,
        balances:    balances.slice(0, 20), // top 20 aset
        accountType: data.accountType || "SPOT",
        canTrade:    data.canTrade,
        canWithdraw: data.canWithdraw,
      });
    }

    if (exchange === "bybit") {
      // ── Bybit V5: GET /v5/account/wallet-balance ──────
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const queryStr  = "accountType=UNIFIED";
      const signStr   = timestamp + apiKey + recvWindow + queryStr;
      const signature = crypto.createHmac("sha256", secretKey)
        .update(signStr).digest("hex");

      const response = await fetch(
        "https://api.bybit.com/v5/account/wallet-balance?" + queryStr,
        { headers: {
          "X-BAPI-API-KEY":     apiKey,
          "X-BAPI-TIMESTAMP":   timestamp,
          "X-BAPI-SIGN":        signature,
          "X-BAPI-RECV-WINDOW": recvWindow,
        }}
      );
      const data = await response.json();

      if (data.retCode !== 0) {
        return res.status(400).json({ error: "Bybit error: " + data.retMsg });
      }

      const wallet = data.result?.list?.[0];
      const totalEquity = parseFloat(wallet?.totalEquity || 0);
      const coins = (wallet?.coin || [])
        .filter(function(c) { return parseFloat(c.walletBalance) > 0; })
        .map(function(c) {
          return { asset: c.coin, free: parseFloat(c.availableToWithdraw), locked: parseFloat(c.walletBalance) - parseFloat(c.availableToWithdraw) };
        });

      return res.json({
        exchange:  "bybit",
        totalUsdt: Math.round(totalEquity * 100) / 100,
        balances:  coins,
      });
    }

    if (exchange === "okx") {
      // ── OKX: GET /api/v5/account/balance ─────────────
      const timestamp = new Date().toISOString();
      const method    = "GET";
      const path      = "/api/v5/account/balance";
      const body      = "";
      const signStr   = timestamp + method + path + body;
      const signature = crypto.createHmac("sha256", secretKey)
        .update(signStr).digest("base64");

      const response = await fetch("https://www.okx.com" + path, {
        headers: {
          "OK-ACCESS-KEY":        apiKey,
          "OK-ACCESS-SIGN":       signature,
          "OK-ACCESS-TIMESTAMP":  timestamp,
          "OK-ACCESS-PASSPHRASE": req.headers["x-passphrase"] || "",
        }
      });
      const data = await response.json();

      if (data.code !== "0") {
        return res.status(400).json({ error: "OKX error: " + data.msg });
      }

      const details = data.data?.[0]?.details || [];
      const totalUsdt = parseFloat(data.data?.[0]?.totalEq || 0);
      const balances  = details
        .filter(function(d) { return parseFloat(d.cashBal) > 0; })
        .map(function(d) {
          return { asset: d.ccy, free: parseFloat(d.availBal), locked: parseFloat(d.frozenBal) };
        });

      return res.json({
        exchange:  "okx",
        totalUsdt: Math.round(totalUsdt * 100) / 100,
        balances:  balances,
      });
    }

    // Exchange lain belum support REST API standar
    return res.status(400).json({
      error: "Exchange " + exchange + " belum didukung untuk fetch balance otomatis. Input manual diperlukan."
    });

  } catch (err) {
    console.error("[Balance error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── User Management ──────────────────────────────────
app.get("/api/user/:email", async (req, res) => {
  try {
    const { data, error } = await db
      .from("neuratrade_users").select("*")
      .eq("email", req.params.email).maybeSingle();
    if (error) throw error;
    if (!data) {
      const { data: newUser, error: err2 } = await db
        .from("neuratrade_users")
        .insert({ email: req.params.email, tier: "free" })
        .select().single();
      if (err2) throw err2;
      return res.json(newUser);
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Subscribe / Activate Pro ─────────────────────────
app.post("/api/subscribe", async (req, res) => {
  try {
    const { email, plan } = req.body;
    const days   = plan === "yearly" ? 365 : plan === "trial" ? 7 : 30;
    const tier   = plan === "trial" ? "trial" : "pro";
    const expiry = new Date(Date.now() + days * 24 * 3600 * 1000);
    const { data, error } = await db.from("neuratrade_users").upsert({
      email, tier,
      pro_expiry:   tier === "pro"   ? expiry.toISOString() : null,
      trial_expiry: tier === "trial" ? expiry.toISOString() : null,
      updated_at:   new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json({ success: true, user: data, expiry });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Place Order ──────────────────────────────────────
app.post("/api/order", async (req, res) => {
  const { symbol, side, quantity, type, price } = req.body;
  const apiKey    = req.headers["x-api-key"];
  const secretKey = req.headers["x-secret"];
  const exchange  = (req.headers["x-exchange"] || "binance").toLowerCase();
  try {
    if (!apiKey || !secretKey) {
      const { data } = await db.from("neuratrade_trades").insert({
        pair: symbol, action: side,
        entry_price: price || 0, size_usd: (quantity||0)*(price||0),
        status: "paper", signal: "Manual order (paper)",
      }).select().single();
      return res.json({ success: true, orderId: data.id, mode: "paper" });
    }
    if (exchange === "binance") {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol, side, type: type||"MARKET",
        quantity: quantity.toString(), timestamp: timestamp.toString(),
      });
      if (type === "LIMIT") { params.append("price", price.toString()); params.append("timeInForce","GTC"); }
      const signature = crypto.createHmac("sha256", secretKey).update(params.toString()).digest("hex");
      params.append("signature", signature);
      const response = await fetch("https://api.binance.com/api/v3/order?" + params.toString(),
        { method:"POST", headers:{ "X-MBX-APIKEY": apiKey } });
      const result = await response.json();
      if (result.code) throw new Error(result.msg);
      return res.json({ success: true, orderId: result.orderId, mode: "real" });
    }
    res.status(400).json({ error: "Exchange belum didukung: " + exchange });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Save Pending Payment ─────────────────────────────
app.post("/api/payment/pending", async (req, res) => {
  try {
    const { email, plan, amount, method } = req.body;
    await db.from("neuratrade_payments").insert({
      amount, plan, status: "pending", payment_method: method,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Midtrans Webhook ─────────────────────────────────
app.post("/api/midtrans/webhook", async (req, res) => {
  try {
    const { order_id, transaction_status, gross_amount, payment_type } = req.body;
    const email = req.body.custom_field1;
    if (["settlement","capture"].includes(transaction_status)) {
      const days   = order_id.includes("yearly") ? 365 : 30;
      const expiry = new Date(Date.now() + days * 24 * 3600 * 1000);
      await db.from("neuratrade_users").upsert({
        email, tier: "pro", pro_expiry: expiry.toISOString(), updated_at: new Date().toISOString(),
      });
      console.log("Pro activated:", email);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("════════════════════════════════════");
  console.log("  NeuraTrade Backend v2.0 RUNNING");
  console.log("  Port:", PORT);
  console.log("════════════════════════════════════");
});

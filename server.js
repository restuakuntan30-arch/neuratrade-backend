// ═══════════════════════════════════════════════════════════════
//  NEURATRADE BACKEND v3.0 — Production Ready
//  ✅ 24/7 Backend Trading Loop
//  ✅ Stop-Loss / Take-Profit otomatis
//  ✅ WhatsApp notifikasi via CallMeBot (gratis)
//  ✅ Real balance semua exchange
//  ✅ Auto-verifikasi pembayaran Midtrans
// ═══════════════════════════════════════════════════════════════

const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const cron     = require("node-cron");
const app      = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

// Supabase
const { createClient } = require("@supabase/supabase-js");
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Active trading sessions (in-memory) ──────────────────────
// Format: { email: { apiKey, secretKey, exchange, settings, aiKey, aiModel, active, positions } }
var SESSIONS = new Map();

// ─── Health ────────────────────────────────────────────────────
app.get("/",       (req, res) => res.json({ service:"NeuraTrade Backend", version:"3.0", status:"running", activeSessions: SESSIONS.size }));
app.get("/health", (req, res) => res.json({ ok:true, time:new Date().toISOString(), sessions: SESSIONS.size }));

// ═══════════════════════════════════════════════════════════════
//  24/7 TRADING LOOP — Start/Stop per user
// ═══════════════════════════════════════════════════════════════
app.post("/api/trading/start", async (req, res) => {
  try {
    const { email, apiKey, secretKey, exchange, settings, aiKey, aiModel, waNumber } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    SESSIONS.set(email, {
      apiKey:    apiKey    || "",
      secretKey: secretKey || "",
      exchange:  exchange  || "binance",
      settings:  settings  || { riskPct:1.5, confThresh:65, maxPos:2, maxDrawdown:10, dailyLoss:5 },
      aiKey:     aiKey     || "",
      aiModel:   aiModel   || "groq_free",
      waNumber:  waNumber  || "",
      active:    true,
      positions: [],
      startedAt: new Date().toISOString(),
      lastRun:   null,
      todayPnL:  0,
    });

    console.log(`[Trading] Started for ${email}`);
    await notifyWA(waNumber, `✅ NeuraTrade AI aktif untuk ${email}\nTrading 24/7 dimulai.`);
    res.json({ ok:true, message:"Backend trading loop dimulai" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/trading/stop", async (req, res) => {
  const { email } = req.body;
  var s = SESSIONS.get(email);
  if (s) { s.active = false; await notifyWA(s.waNumber, `⏹️ NeuraTrade AI dihentikan untuk ${email}`); }
  res.json({ ok:true });
});

app.get("/api/trading/status/:email", (req, res) => {
  var s = SESSIONS.get(req.params.email);
  if (!s) return res.json({ active:false });
  res.json({ active:s.active, positions:s.positions, lastRun:s.lastRun, todayPnL:s.todayPnL });
});

// ═══════════════════════════════════════════════════════════════
//  CRON: Jalankan AI Trading setiap 5 menit
// ═══════════════════════════════════════════════════════════════
cron.schedule("*/5 * * * *", async () => {
  for (var [email, session] of SESSIONS) {
    if (!session.active) continue;
    try {
      await runAICycle(email, session);
    } catch(e) {
      console.error(`[Cron] Error for ${email}:`, e.message);
    }
  }
});

// Cron: Monitor SL/TP setiap 30 detik
cron.schedule("*/30 * * * * *", async () => {
  for (var [email, session] of SESSIONS) {
    if (!session.active || session.positions.length === 0) continue;
    try {
      await monitorSLTP(email, session);
    } catch(e) {}
  }
});

// ─── AI Trading Cycle ──────────────────────────────────────────
async function runAICycle(email, session) {
  session.lastRun = new Date().toISOString();

  // Cek daily loss limit
  if (Math.abs(session.todayPnL) > (session.settings.dailyLoss || 5) / 100 * (session.settings.balance || 5000)) {
    console.log(`[AI] ${email}: daily loss limit reached, skipping`);
    return;
  }

  // Cek max positions
  if (session.positions.length >= (session.settings.maxPos || 2)) return;

  // Fetch harga Binance (ambil 1 pair aktif)
  var pairs = ["BTCUSDT","XAUUSDT","ETHUSDT"];
  var pair  = pairs[Math.floor(Date.now() / (5*60000)) % pairs.length];

  var klines = await fetchKlines(pair, "5m", 50);
  if (!klines || klines.length < 20) return;

  // Hitung indikator sederhana
  var closes = klines.map(function(k){ return parseFloat(k[4]); });
  var rsi = calcRSI(closes, 14);
  var price = closes[closes.length - 1];

  // Panggil AI
  var signal = await callAI(session, pair, price, rsi, klines);
  if (!signal || signal.action === "HOLD") return;

  // Hitung size
  var risk    = (session.settings.riskPct || 1.5) / 100;
  var balance = session.settings.balance || 5000;
  var size    = balance * risk;
  var sl      = price * (signal.action === "BUY" ? 0.98 : 1.02); // 2% SL
  var tp      = price * (signal.action === "BUY" ? 1.04 : 0.96); // 4% TP

  // Eksekusi order
  var orderId = "sim_" + Date.now();
  if (session.apiKey && session.secretKey) {
    try {
      var result = await executeBinanceOrder(session, pair, signal.action, size / price);
      orderId = result.orderId || orderId;
    } catch(e) {
      console.error(`[Order] ${email}:`, e.message);
      return;
    }
  }

  // Simpan posisi
  var pos = { pair, action:signal.action, entry:price, sl, tp, size, orderId, time:new Date().toISOString() };
  session.positions.push(pos);

  // Simpan ke database
  await db.from("neuratrade_trades").insert({
    pair, action:signal.action, entry_price:price, size_usd:size,
    status: session.apiKey ? "open" : "paper",
    signal: signal.reason || "AI Signal", confidence: signal.confidence || 70,
  });

  // Notifikasi WA
  await notifyWA(session.waNumber,
    `📊 *NeuraTrade AI Signal*\n` +
    `Pair: ${pair}\nAction: ${signal.action}\nHarga: $${price.toFixed(2)}\n` +
    `SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}\nSize: $${size.toFixed(2)}\n` +
    `Confidence: ${signal.confidence}%`
  );

  console.log(`[Trade] ${email}: ${signal.action} ${pair} @ ${price}`);
}

// ─── Monitor SL/TP ────────────────────────────────────────────
async function monitorSLTP(email, session) {
  for (var i = session.positions.length - 1; i >= 0; i--) {
    var pos = session.positions[i];
    var price = await getPrice(pos.pair);
    if (!price) continue;

    var hitSL = pos.action === "BUY" ? price <= pos.sl : price >= pos.sl;
    var hitTP = pos.action === "BUY" ? price >= pos.tp : price <= pos.tp;

    if (hitSL || hitTP) {
      var pnl = pos.action === "BUY"
        ? (price - pos.entry) / pos.entry * pos.size
        : (pos.entry - price) / pos.entry * pos.size;

      session.todayPnL += pnl;
      session.positions.splice(i, 1);

      // Update database
      await db.from("neuratrade_trades").update({
        exit_price: price, pnl, is_win: pnl > 0, status:"closed", closed_at: new Date().toISOString()
      }).eq("pair", pos.pair).eq("status","open");

      // WA notif
      var emoji = pnl > 0 ? "✅" : "❌";
      await notifyWA(session.waNumber,
        `${emoji} *Trade Ditutup*\n${pos.pair} ${hitSL?"(Stop Loss)":"(Take Profit)"}\n` +
        `PnL: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}\nHarga keluar: $${price.toFixed(2)}`
      );

      console.log(`[SL/TP] ${email}: closed ${pos.pair}, PnL: ${pnl.toFixed(2)}`);
    }
  }
}

// ─── Helper: Call AI (Groq atau Anthropic) ─────────────────────
async function callAI(session, pair, price, rsi, klines) {
  var prompt = `You are a trading AI. Analyze ${pair} at $${price.toFixed(2)}, RSI=${rsi.toFixed(1)}.
Based on the last 50 candles, provide a JSON signal:
{"action":"BUY|SELL|HOLD","confidence":0-100,"reason":"brief reason","sl":${(price*0.98).toFixed(2)},"tp":${(price*1.04).toFixed(2)}}
Only BUY or SELL if confidence >= 65. Return JSON only.`;

  try {
    if (session.aiModel && session.aiModel.includes("groq") && session.aiKey) {
      var res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + session.aiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model:"llama3-8b-8192", messages:[{role:"user",content:prompt}], max_tokens:150 }),
      });
      var data = await res.json();
      var text = data.choices?.[0]?.message?.content || "";
      return JSON.parse(text.replace(/```json|```/g,"").trim());
    }
    // Fallback: simple indicator-based signal
    if (rsi < 30) return { action:"BUY",  confidence:72, reason:"RSI oversold" };
    if (rsi > 70) return { action:"SELL", confidence:72, reason:"RSI overbought" };
    return { action:"HOLD", confidence:50, reason:"No clear signal" };
  } catch(e) {
    return { action:"HOLD", confidence:0, reason:"AI error" };
  }
}

// ─── Helper: Fetch Binance klines ─────────────────────────────
async function fetchKlines(symbol, interval, limit) {
  try {
    var res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return await res.json();
  } catch(e) { return null; }
}

// ─── Helper: Get current price ────────────────────────────────
async function getPrice(symbol) {
  try {
    var res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    var data = await res.json();
    return parseFloat(data.price);
  } catch(e) { return null; }
}

// ─── Helper: RSI ──────────────────────────────────────────────
function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  var gains = 0, losses = 0;
  for (var i = closes.length - period; i < closes.length; i++) {
    var diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  var rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

// ─── Helper: Execute Binance Order ────────────────────────────
async function executeBinanceOrder(session, symbol, side, quantity) {
  var timestamp = Date.now();
  var params = new URLSearchParams({ symbol, side, type:"MARKET", quantity:quantity.toFixed(6), timestamp:timestamp.toString() });
  var sig = crypto.createHmac("sha256", session.secretKey).update(params.toString()).digest("hex");
  params.append("signature", sig);
  var res = await fetch("https://api.binance.com/api/v3/order?" + params.toString(),
    { method:"POST", headers:{"X-MBX-APIKEY": session.apiKey} });
  var data = await res.json();
  if (!res.ok || data.code) {
    var errMsg = data.msg || JSON.stringify(data);
    // Log full error for debugging
    console.error("Binance order error:", errMsg, "symbol:", symbol, "qty:", quantity, "side:", side);
    throw new Error(errMsg);
  }
  return data;
}

// ─── Helper: Telegram Notifikasi (CallMeBot - gratis) ─────────
// Tidak butuh API key — cukup username Telegram
async function notifyWA(username, message) {
  // username = Telegram username (contoh: Restu_hidayat30)
  if (!username) return;
  try {
    // Hapus @ jika ada di depan
    var user = username.replace(/^@/, "");
    var url  = "https://api.callmebot.com/text.php?user=@" + user + "&text=" + encodeURIComponent(message);
    var res  = await fetch(url);
    console.log("[Notif Telegram]", user, res.status);
  } catch(e) {
    console.warn("[Notif error]", e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  BALANCE — Real balance dari exchange
// ═══════════════════════════════════════════════════════════════
app.post("/api/balance", async (req, res) => {
  const apiKey    = req.headers["x-api-key"];
  const secretKey = req.headers["x-secret"];
  const exchange  = (req.headers["x-exchange"] || "binance").toLowerCase();
  if (!apiKey || !secretKey) return res.status(400).json({ error:"API key diperlukan" });
  try {
    if (exchange === "binance") {
      const ts = Date.now();
      const p  = new URLSearchParams({ timestamp:ts.toString() });
      const sig = crypto.createHmac("sha256",secretKey).update(p.toString()).digest("hex");
      p.append("signature",sig);
      const r = await fetch("https://api.binance.com/api/v3/account?"+p, { headers:{"X-MBX-APIKEY":apiKey} });
      const d = await r.json();
      if (d.code) return res.status(400).json({ error:"Binance: "+d.msg });
      // Semua aset dengan saldo > 0
      const bals = (d.balances||[])
        .filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0.000001)
        .map(b => ({
          asset:  b.asset,
          free:   parseFloat(b.free),
          locked: parseFloat(b.locked),
          total:  parseFloat(b.free) + parseFloat(b.locked),
        }))
        .sort((a,b) => b.total - a.total);

      // Ambil harga BTC & ETH untuk konversi
      var btcPrice = 0, ethPrice = 0;
      try {
        var [btcR, ethR] = await Promise.all([
          fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
          fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
        ]);
        btcPrice = parseFloat((await btcR.json()).price) || 0;
        ethPrice = parseFloat((await ethR.json()).price) || 0;
      } catch(e) {}

      // Hitung total dalam USD
      // Stablecoin 1:1 (termasuk LDUSDT = Locked/Simple Earn USDT)
      const STABLES = ["USDT","USDC","BUSD","LDUSDT","FDUSD","TUSD","DAI","USDP"];
      var totalUsdt = 0;
      var breakdown = [];

      for (var b of bals) {
        var usdVal = 0;
        if (STABLES.includes(b.asset)) {
          usdVal = b.total;                    // 1:1 dengan USD
        } else if (b.asset === "BTC" && btcPrice > 0) {
          usdVal = b.total * btcPrice;
        } else if (b.asset === "ETH" && ethPrice > 0) {
          usdVal = b.total * ethPrice;
        } else if (b.asset === "BNB" && btcPrice > 0) {
          // BNB roughly estimated
          usdVal = b.total * (btcPrice / 150);
        }
        if (usdVal > 0.01) {
          totalUsdt += usdVal;
          breakdown.push({ asset: b.asset, amount: b.total, usdValue: Math.round(usdVal * 100) / 100 });
        }
      }

      // Cek Futures wallet juga
      var futuresUsdt = 0;
      try {
        var fts  = Date.now();
        var fp   = new URLSearchParams({ timestamp: fts.toString() });
        var fsig = crypto.createHmac("sha256", secretKey).update(fp.toString()).digest("hex");
        fp.append("signature", fsig);
        var fr = await fetch("https://fapi.binance.com/fapi/v2/balance?" + fp.toString(), {
          headers: { "X-MBX-APIKEY": apiKey }
        });
        var fd = await fr.json();
        if (Array.isArray(fd)) {
          var fbal = fd.find(function(b){ return b.asset === "USDT"; });
          futuresUsdt = parseFloat((fbal && fbal.balance) ? fbal.balance : 0);
          if (futuresUsdt > 0.01) {
            totalUsdt += futuresUsdt;
            breakdown.push({ asset: "USDT(Futures)", amount: futuresUsdt, usdValue: Math.round(futuresUsdt*100)/100 });
          }
        }
      } catch(fe) { /* Futures tidak aktif */ }

      return res.json({
        exchange:  "binance",
        totalUsdt: Math.round(totalUsdt * 100) / 100,
        balances:  bals.slice(0, 20),
        breakdown: breakdown,
        btcPrice:  Math.round(btcPrice),
        canTrade:  d.canTrade,
        note: futuresUsdt > 0 ? "Termasuk Futures Wallet: $" + futuresUsdt.toFixed(2)
            : bals.some(function(b){ return b.asset === "LDUSDT"; }) ? "Termasuk LDUSDT (Simple Earn)" : null,
      });
    }
    if (exchange === "bybit") {
      const ts = Date.now().toString(), rw = "5000", qs = "accountType=UNIFIED";
      const sig = crypto.createHmac("sha256",secretKey).update(ts+apiKey+rw+qs).digest("hex");
      const r = await fetch("https://api.bybit.com/v5/account/wallet-balance?"+qs, { headers:{"X-BAPI-API-KEY":apiKey,"X-BAPI-TIMESTAMP":ts,"X-BAPI-SIGN":sig,"X-BAPI-RECV-WINDOW":rw} });
      const d = await r.json();
      if (d.retCode!==0) return res.status(400).json({ error:"Bybit: "+d.retMsg });
      const wallet = d.result?.list?.[0];
      return res.json({ exchange:"bybit", totalUsdt:Math.round(parseFloat(wallet?.totalEquity||0)*100)/100, balances:(wallet?.coin||[]).filter(c=>parseFloat(c.walletBalance)>0).map(c=>({asset:c.coin,free:parseFloat(c.availableToWithdraw),locked:0})) });
    }
    return res.status(400).json({ error:"Exchange "+exchange+" belum didukung" });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
//  USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.get("/api/user/:email", async (req,res) => {
  try {
    const {data,error} = await db.from("neuratrade_users").select("*").eq("email",req.params.email).maybeSingle();
    if (error) throw error;
    if (!data) {
      const {data:nu,error:e2} = await db.from("neuratrade_users").insert({email:req.params.email,tier:"free"}).select().single();
      if (e2) throw e2;
      return res.json(nu);
    }
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/subscribe", async (req,res) => {
  try {
    const {email,plan} = req.body;
    const days  = plan==="yearly"?365:plan==="trial"?7:30;
    const tier  = plan==="trial"?"trial":"pro";
    const exp   = new Date(Date.now()+days*24*3600000);
    const {data,error} = await db.from("neuratrade_users").upsert({email,tier,pro_expiry:tier==="pro"?exp.toISOString():null,trial_expiry:tier==="trial"?exp.toISOString():null,updated_at:new Date().toISOString()}).select().single();
    if (error) throw error;
    res.json({success:true,user:data,expiry:exp});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  PAYMENT — Midtrans + Manual
// ═══════════════════════════════════════════════════════════════
app.post("/api/payment/create", async (req,res) => {
  try {
    if (!process.env.MIDTRANS_SERVER_KEY) return res.status(400).json({ error:"Midtrans belum dikonfigurasi" });
    const midtransClient = require("midtrans-client");
    const snap = new midtransClient.Snap({ isProduction:false, serverKey:process.env.MIDTRANS_SERVER_KEY });
    const {email,plan,amount} = req.body;
    const orderId = "NT-"+plan+"-"+Date.now();
    const tx = await snap.createTransaction({
      transaction_details:{order_id:orderId,gross_amount:amount},
      customer_details:{email}, custom_field1:email,
      item_details:[{id:plan,price:amount,quantity:1,name:"NeuraTrade "+plan}],
      enabled_payments:["qris","gopay","shopeepay","bank_transfer"],
    });
    res.json({token:tx.token,redirect_url:tx.redirect_url,order_id:orderId});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/payment/pending", async (req,res) => {
  try {
    await db.from("neuratrade_payments").insert({amount:req.body.amount||0,plan:req.body.plan||"monthly",status:"pending",payment_method:req.body.method||"manual"});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/midtrans/webhook", async (req,res) => {
  try {
    const {order_id,transaction_status,gross_amount,payment_type} = req.body;
    const email = req.body.custom_field1;
    if (["settlement","capture"].includes(transaction_status)) {
      const days = order_id.includes("yearly")?365:30;
      const exp  = new Date(Date.now()+days*24*3600000);
      await db.from("neuratrade_users").upsert({email,tier:"pro",pro_expiry:exp.toISOString(),updated_at:new Date().toISOString()});
      await db.from("neuratrade_payments").insert({midtrans_order_id:order_id,amount:parseFloat(gross_amount),plan:order_id.includes("yearly")?"yearly":"monthly",status:"paid",payment_method:payment_type,paid_at:new Date().toISOString()});
      var session = SESSIONS.get(email);
      await notifyWA(session?.waNumber, `🎉 Pro aktif untuk ${email}! Selamat trading.`);
      console.log("Pro activated:", email);
    }
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════
//  MANUAL ORDER (fallback)
// ═══════════════════════════════════════════════════════════════
app.post("/api/order", async (req,res) => {
  const {symbol,side,quantity,price} = req.body;
  const apiKey=req.headers["x-api-key"], secretKey=req.headers["x-secret"];
  const exchange=(req.headers["x-exchange"]||"binance").toLowerCase();
  try {
    if (!apiKey||!secretKey) {
      const {data} = await db.from("neuratrade_trades").insert({pair:symbol,action:side,entry_price:price||0,size_usd:(quantity||0)*(price||0),status:"paper",signal:"Manual order"}).select().single();
      return res.json({success:true,orderId:data.id,mode:"paper"});
    }
    if (exchange==="binance") {
      var result = await executeBinanceOrder({apiKey,secretKey},symbol,side,quantity);
      return res.json({success:true,orderId:result.orderId,mode:"real"});
    }
    res.status(400).json({error:"Exchange belum didukung: "+exchange});
  } catch(e) { res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("════════════════════════════════════════");
  console.log("  NeuraTrade Backend v3.0 RUNNING");
  console.log("  Port:", PORT);
  console.log("  Active sessions:", SESSIONS.size);
  console.log("════════════════════════════════════════");
});

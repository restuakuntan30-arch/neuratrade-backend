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

app.get("/", (req, res) => {
  res.json({
    service: "NeuraTrade Backend",
    version: "1.0.0",
    status:  "running",
    time:    new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/user/:email", async (req, res) => {
  try {
    const { data, error } = await db
      .from("neuratrade_users")
      .select("*")
      .eq("email", req.params.email)
      .maybeSingle();
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/subscribe", async (req, res) => {
  try {
    const { email, plan } = req.body;
    const days   = plan === "yearly" ? 365 : plan === "trial" ? 7 : 30;
    const tier   = plan === "trial" ? "trial" : "pro";
    const expiry = new Date(Date.now() + days * 24 * 3600 * 1000);
    const { data, error } = await db
      .from("neuratrade_users")
      .upsert({
        email,
        tier,
        pro_expiry:   tier === "pro"   ? expiry.toISOString() : null,
        trial_expiry: tier === "trial" ? expiry.toISOString() : null,
        updated_at:   new Date().toISOString(),
      })
      .select().single();
    if (error) throw error;
    res.json({ success: true, user: data, expiry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/order", async (req, res) => {
  const { symbol, side, quantity, type, price } = req.body;
  const apiKey    = req.headers["x-api-key"];
  const secretKey = req.headers["x-secret"];
  const exchange  = (req.headers["x-exchange"] || "binance").toLowerCase();
  try {
    if (!apiKey || !secretKey) {
      const { data } = await db.from("neuratrade_trades").insert({
        pair: symbol, action: side,
        entry_price: price || 0,
        size_usd: (quantity || 0) * (price || 0),
        status: "paper", signal: "Manual order (paper trade)",
      }).select().single();
      return res.json({ success: true, orderId: data.id, mode: "paper" });
    }
    if (exchange === "binance") {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol, side,
        type: type || "MARKET",
        quantity: quantity.toString(),
        timestamp: timestamp.toString(),
      });
      if (type === "LIMIT") {
        params.append("price", price.toString());
        params.append("timeInForce", "GTC");
      }
      const signature = crypto
        .createHmac("sha256", secretKey)
        .update(params.toString()).digest("hex");
      params.append("signature", signature);
      const response = await fetch(
        "https://api.binance.com/api/v3/order?" + params.toString(),
        { method: "POST", headers: { "X-MBX-APIKEY": apiKey } }
      );
      const result = await response.json();
      if (result.code) throw new Error(result.msg);
      return res.json({ success: true, orderId: result.orderId, mode: "real" });
    }
    res.status(400).json({ error: "Exchange belum didukung: " + exchange });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/midtrans/webhook", async (req, res) => {
  try {
    const { order_id, transaction_status, gross_amount, payment_type } = req.body;
    const email = req.body.custom_field1;
    if (["settlement","capture"].includes(transaction_status)) {
      const days   = order_id.includes("yearly") ? 365 : 30;
      const expiry = new Date(Date.now() + days * 24 * 3600 * 1000);
      await db.from("neuratrade_users").upsert({
        email, tier: "pro",
        pro_expiry: expiry.toISOString(),
        updated_at: new Date().toISOString(),
      });
      console.log("Pro activated:", email);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("NeuraTrade Backend running on port", PORT);
});

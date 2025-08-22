import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";
import admin from "firebase-admin";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ✅ Firebase Admin init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

// ✅ Create checkout
app.post("/create-checkout", async (req, res) => {
  try {
    const { amount } = req.body;
    const orderRef = await db.collection("orders").add({
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const orderId = orderRef.id;

    const response = await fetch("https://online.yoco.com/v1/charges/", {
      method: "POST",
      headers: {
        "X-Auth-Secret-Key": process.env.YOCO_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amountInCents: Math.round(amount * 100),
        currency: "ZAR",
        metadata: { orderId },
        redirect: {
          successUrl: `https://eezyspaza-backend1.onrender.com/yoco-payment-success?orderId=${orderId}`,
          cancelUrl: `https://eezyspaza-backend1.onrender.com/yoco-payment-cancel?orderId=${orderId}`,
        },
      }),
    });

    const data = await response.json();
    res.json({ checkoutUrl: data.redirectUrl });
  } catch (error) {
    console.error("Error creating checkout:", error);
    res.status(500).json({ error: "Failed to create checkout" });
  }
});

// ✅ Webhook
app.post("/webhook", bodyParser.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["yoco-signature"];
  const payload = req.body.toString();
  const expectedSig = crypto
    .createHmac("sha256", process.env.YOCO_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  if (sig !== expectedSig) {
    console.log("⚠️ Webhook signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch (err) {
    console.error("Webhook parsing error:", err.message);
    return res.status(400).send("Invalid payload");
  }

  console.log(`(Webhook) Processing event type: ${event.type}`);

  if (event.type === "payment.succeeded") {
    const orderId = event.data.metadata?.orderId;
    if (orderId) {
      db.collection("orders").doc(orderId).update({ status: "paid" });
      console.log(`✅ Order ${orderId} marked as paid`);
    }
  }

  res.json({ received: true });
});

// ✅ Success page
app.get("/yoco-payment-success", (req, res) => {
  const orderId = req.query.orderId || "unknown";
  res.send(`
    <h1>✅ Payment Successful!</h1>
    <p>Order ID: ${orderId}</p>
    <script>
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: "paymentSuccess",
          orderId: "${orderId}"
        }));
      }
    </script>
  `);
});

// ✅ Cancel page
app.get("/yoco-payment-cancel", (req, res) => {
  res.send("<h1>❌ Payment Cancelled</h1><p>You cancelled your payment.</p>");
});

// Start server
app.listen(PORT, () => {
  console.log(`EazySpaza Backend running on port ${PORT}`);
});

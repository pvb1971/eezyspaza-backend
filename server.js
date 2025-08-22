// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json"); // <-- Your Firebase service account JSON
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Middleware
app.use(cors());
app.use(express.json()); // Only for normal routes, NOT webhook

const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;

// Helper: create Yoco checkout
async function createYocoCheckout(orderId, amount) {
  const url = "https://online.yoco.com/v1/online-checkouts";
  const body = {
    amount: amount,
    currency: "ZAR",
    successUrl: "https://eezyspaza-backend1.onrender.com/yoco-payment-success",
    cancelUrl: "https://eezyspaza-backend1.onrender.com/yoco-payment-cancel",
    failureUrl: "https://eezyspaza-backend1.onrender.com/yoco-payment-failure",
    metadata: {
      firebase_order_id: orderId,
      order_reference: `EazySpaza_Order_${Date.now()}`,
    },
  };

  const resp = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${YOCO_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

  return resp.data;
}

// Route: create checkout
app.post("/create-checkout", async (req, res) => {
  try {
    console.log("-----> /create-checkout ROUTE HIT! <-----");

    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: "Amount required" });

    // Add order to Firebase
    const orderRef = await db.collection("orders").add({
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("Order added to Firebase with ID:", orderRef.id);

    // Create Yoco checkout
    const checkoutData = await createYocoCheckout(orderRef.id, amount);

    // Update Firebase with checkout ID
    await orderRef.update({ checkoutId: checkoutData.id });
    console.log("Updated Firebase order with Yoco checkoutId:", checkoutData.id);

    res.json({ checkout: checkoutData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Webhook: Yoco payment notifications
app.post(
  "/yoco-webhook-receiver",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const rawBody = req.body.toString();
      console.log("RAW WEBHOOK BODY:", rawBody);

      const event = JSON.parse(rawBody); // safely parse now

      if (event.type === "payment.succeeded") {
        const orderId = event.payload.metadata.firebase_order_id;
        console.log(`Processing payment.succeeded. Firebase Order ID: ${orderId}`);

        // Update Firebase order
        await db.collection("orders").doc(orderId).update({
          status: "paid",
          amount: event.payload.amount,
          currency: event.payload.currency,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      res.status(200).send("Webhook processed");
    } catch (err) {
      console.error("Webhook processing error:", err.message);
      res.status(400).send("Webhook error");
    }
  }
);

// Simple GET routes for redirect URLs
app.get("/yoco-payment-success", (req, res) => {
  res.send("Payment Successful! ✅");
});
app.get("/yoco-payment-cancel", (req, res) => {
  res.send("Payment Cancelled ❌");
});
app.get("/yoco-payment-failure", (req, res) => {
  res.send("Payment Failed ❌");
});

// Health check
app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`EazySpaza Backend Server running on port ${PORT}. Waiting for requests...`);
  console.log("Node Environment:", process.env.NODE_ENV || "development");
  console.log("YOCO_SECRET_KEY configured:", YOCO_SECRET_KEY?.slice(0, 10) + "..."); // hide key
  console.log("YOCO_WEBHOOK_SECRET configured:", YOCO_WEBHOOK_SECRET?.slice(0, 10) + "...");
});


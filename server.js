// server.js
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");

// Load your Firebase service account
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json()); // default JSON parser for non-webhook routes

//----------------------------------------------------
// 1. Create Yoco Checkout Session
//----------------------------------------------------
app.post("/create-checkout", async (req, res) => {
  try {
    const { orderId, items } = req.body; // items from Firebase cart
    if (!orderId || !items) {
      return res.status(400).json({ error: "orderId and items required" });
    }

    // Calculate total from items
    const total = items.reduce((sum, item) => sum + parseFloat(item.price), 0);

    // Convert to cents for Yoco (R64.99 -> 6499)
    const amountInCents = Math.round(total * 100);

    // Call Yoco API to create checkout
    const response = await axios.post(
      "https://online.yoco.com/v1/checkout",
      {
        amount: amountInCents,
        currency: "ZAR",
        successUrl: "https://eezyspaza-backend1.onrender.com/yoco-payment-success",
        cancelUrl: "https://eezyspaza-backend1.onrender.com/yoco-payment-cancel",
        failureUrl: "https://eezyspaza-backend1.onrender.com/yoco-payment-failure",
        metadata: {
          firebase_order_id: orderId,
        },
      },
      {
        headers: {
          "X-Auth-Secret-Key": process.env.YOCO_SECRET_KEY, // set in Render Dashboard
        },
      }
    );

    return res.json(response.data);
  } catch (err) {
    console.error("Error creating checkout:", err.message);
    return res.status(500).json({ error: "Checkout creation failed" });
  }
});

//----------------------------------------------------
// 2. Webhook: payment.succeeded
//----------------------------------------------------
app.post(
  "/yoco-webhook-receiver",
  express.raw({ type: "application/json" }), // raw parser only for webhook
  async (req, res) => {
    try {
      const rawBody = req.body.toString();
      console.log("RAW WEBHOOK BODY:", rawBody);

      const event = JSON.parse(rawBody);

      console.log("PARSED WEBHOOK BODY:", event);

      if (event.type === "payment.succeeded") {
        const orderId = event.payload.metadata.firebase_order_id;
        console.log(`(Webhook) Processing payment.succeeded for order: ${orderId}`);

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

//----------------------------------------------------
// 3. Success / Cancel / Failure Routes
//----------------------------------------------------
app.get("/yoco-payment-success", (req, res) => {
  res.send("<h1>✅ Payment Successful!</h1><p>Thank you for shopping at EezySpaza.</p>");
});

app.get("/yoco-payment-cancel", (req, res) => {
  res.send("<h1>❌ Payment Cancelled</h1><p>You cancelled your payment.</p>");
});

app.get("/yoco-payment-failure", (req, res) => {
  res.send("<h1>⚠️ Payment Failed</h1><p>Something went wrong, please try again.</p>");
});

//----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

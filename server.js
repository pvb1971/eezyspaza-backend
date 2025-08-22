// server.js
import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ Firebase init (only if not already initialized)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

// ✅ Root route
app.get("/", (req, res) => {
  res.send("✅ EezySpaza Backend is running!");
});

// ✅ Create Checkout Route
app.post("/create-checkout", async (req, res) => {
  try {
    console.log("INCOMING REQUEST: POST /create-checkout");

    const { amount } = req.body;

    // Add order to Firebase first
    const orderRef = await db.collection("orders").add({
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("Order added to Firebase with ID:", orderRef.id);

    // Call Yoco API
    const response = await fetch("https://payments.yoco.com/api/checkouts", {
      method: "POST",
      headers: {
        "X-Auth-Secret-Key": process.env.YOCO_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "ZAR",
        successUrl: "http://eezyspaza-backend1.onrender.com/yoco-payment-success",
        cancelUrl: "http://eezyspaza-backend1.onrender.com/yoco-payment-cancel",
        failureUrl: "http://eezyspaza-backend1.onrender.com/yoco-payment-failure",
        metadata: {
          firebase_order_id: orderRef.id,
          order_reference: `EazySpaza_Order_${Date.now()}`,
        },
      }),
    });

    const data = await response.json();
    console.log("Sending to Yoco (/api/checkouts):", JSON.stringify(data, null, 2));

    // Update Firebase with checkout ID
    await orderRef.update({ checkoutId: data.id });
    console.log("Updated Firebase order with Yoco checkoutId:", data.id);

    res.json(data);
  } catch (error) {
    console.error("Error creating checkout:", error);
    res.status(500).send({ error: error.message });
  }
});

// ✅ Webhook Receiver
app.post("/yoco-webhook-receiver", async (req, res) => {
  try {
    console.log("INCOMING REQUEST: POST /yoco-webhook-receiver");
    console.log("-----> FULL /yoco-webhook-receiver ROUTE HIT <-----");
    console.log("RAW WEBHOOK BODY:", JSON.stringify(req.body));

    const event = req.body; // already parsed by bodyParser.json()
    console.log("PARSED WEBHOOK BODY:", JSON.stringify(event, null, 2));

    const eventType = event.type;
    const orderId = event?.payload?.metadata?.firebase_order_id;

    console.log(`(Webhook) Processing event type: ${eventType}. Firebase Order ID: ${orderId}.`);

    if (eventType === "payment.succeeded" && orderId) {
      await db.collection("orders").doc(orderId).update({
        status: "paid",
        paymentId: event.payload.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("✅ Order updated in Firebase:", orderId);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    res.sendStatus(400);
  }
});

// ✅ Payment Result Pages
app.get("/yoco-payment-success", (req, res) => {
  res.send(`
    <h1>✅ Payment Successful</h1>
    <p>Thank you! Your payment has been processed.</p>
  `);
});

app.get("/yoco-payment-cancel", (req, res) => {
  res.send(`
    <h1>❌ Payment Cancelled</h1>
    <p>Your payment was cancelled. Please try again.</p>
  `);
});

app.get("/yoco-payment-failure", (req, res) => {
  res.send(`
    <h1>⚠️ Payment Failed</h1>
    <p>There was a problem processing your payment.</p>
  `);
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// Firebase init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

// Health check
app.get("/", (req, res) => {
  res.send("✅ EezySpaza Backend is running");
});

// Create Checkout
app.post("/create-checkout", async (req, res) => {
  console.log("INCOMING REQUEST: POST /create-checkout");
  try {
    const orderRef = await db.collection("orders").add({
      status: "pending",
      created: new Date(),
      amount: 6499, // Testing with product price (R64.99)
      description: "Five Roses Tea (Test)",
    });
    console.log("Order added to Firebase with ID:", orderRef.id);

    const yocoRes = await fetch("https://online.yoco.com/v1/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Secret-Key": process.env.YOCO_SECRET_KEY,
      },
      body: JSON.stringify({
        amount: 6499, // R64.99 test
        currency: "ZAR",
        successUrl: `${process.env.BASE_URL}/yoco-payment-success`,
        cancelUrl: `${process.env.BASE_URL}/yoco-payment-cancel`,
        failureUrl: `${process.env.BASE_URL}/yoco-payment-failure`,
        metadata: {
          firebase_order_id: orderRef.id,
          order_reference: `EazySpaza_Order_${Date.now()}`,
        },
      }),
    });

    const data = await yocoRes.json();
    console.log("Yoco response:", data);

    await orderRef.update({ yocoCheckoutId: data.id });

    res.json({ checkoutUrl: data.redirectUrl });
  } catch (err) {
    console.error("Error creating checkout:", err);
    res.status(500).json({ error: "Checkout creation failed" });
  }
});

// Webhook Receiver
app.post("/yoco-webhook-receiver", (req, res) => {
  console.log("INCOMING REQUEST: POST /yoco-webhook-receiver");
  console.log("RAW WEBHOOK BODY:", req.rawBody);

  try {
    const body = JSON.parse(req.rawBody);
    console.log("PARSED WEBHOOK BODY:", JSON.stringify(body, null, 2));

    if (body.type === "payment.succeeded") {
      const orderId = body.payload.metadata.firebase_order_id;
      console.log("(Webhook) Payment succeeded for order:", orderId);

      if (orderId) {
        db.collection("orders").doc(orderId).update({ status: "paid" });
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    res.status(400).send("Webhook processing error");
  }
});

// Success / Cancel / Failure pages
app.get("/yoco-payment-success", (req, res) => {
  console.log("INCOMING REQUEST: GET /yoco-payment-success");

  const orderId = req.query.orderId || "unknown";

  res.send(`
    <h1>✅ Payment Successful!</h1>
    <p>Thank you for your purchase.</p>
    <script>
      // Send message to WebView
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: "paymentSuccess",
          orderId: "${orderId}"
        }));
      }
    </script>
  `);
});

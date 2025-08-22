import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import admin from "firebase-admin";
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Firebase init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// Root
app.get("/", (req, res) => {
  res.send("EezySpaza Backend is running 🚀");
});

// =============== CREATE CHECKOUT ===============
app.post("/create-checkout", async (req, res) => {
  try {
    console.log("INCOMING REQUEST: POST /create-checkout");

    const { amount } = req.body;

    // Save order in Firebase
    const orderRef = await db.collection("orders").add({
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("Order added to Firebase with ID:", orderRef.id);

    // Send to Yoco
    const yocoRes = await fetch("https://payments.yoco.com/api/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "ZAR",
        successUrl: `https://eezyspaza-backend1.onrender.com/yoco-payment-success?orderId=${orderRef.id}`,
        cancelUrl: `https://eezyspaza-backend1.onrender.com/yoco-payment-cancel?orderId=${orderRef.id}`,
        failureUrl: `https://eezyspaza-backend1.onrender.com/yoco-payment-failure?orderId=${orderRef.id}`,
        metadata: {
          firebase_order_id: orderRef.id,
          order_reference: `EazySpaza_Order_${Date.now()}`,
        },
      }),
    });

    const data = await yocoRes.json();
    console.log("Updated Firebase order with Yoco checkoutId:", data.id);

    await orderRef.update({ checkoutId: data.id });

    res.json(data);
  } catch (err) {
    console.error("Checkout creation error:", err);
    res.status(500).json({ error: "Checkout creation failed" });
  }
});

// =============== WEBHOOK ===============
app.post("/yoco-webhook-receiver", async (req, res) => {
  try {
    console.log("INCOMING REQUEST: POST /yoco-webhook-receiver");
    console.log("RAW WEBHOOK BODY:", JSON.stringify(req.body));

    const event = req.body;
    console.log("PARSED WEBHOOK BODY:", JSON.stringify(event, null, 2));

    if (event.type === "payment.succeeded") {
      const payload = event.payload;
      const orderId = payload.metadata.firebase_order_id;

      console.log(
        `(Webhook) Processing event type: ${event.type}. Firebase Order ID: ${orderId}.`
      );

      // ✅ Store only safe fields
      await db.collection("orders").doc(orderId).update({
        status: "paid",
        paymentId: payload.id,
        amount: payload.amount,
        currency: payload.currency,
        card: payload.paymentMethodDetails?.card?.maskedCard || "N/A",
        scheme: payload.paymentMethodDetails?.card?.scheme || "N/A",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("Webhook processing error:", err.message);
    res.status(400).send("Webhook error");
  }
});

// =============== SUCCESS / CANCEL / FAILURE ROUTES ===============
app.get("/yoco-payment-success", (req, res) => {
  res.send("✅ Payment successful! Your order has been confirmed.");
});

app.get("/yoco-payment-cancel", (req, res) => {
  res.send("⚠️ Payment canceled. Please try again.");
});

app.get("/yoco-payment-failure", (req, res) => {
  res.send("❌ Payment failed. Please try again.");
});

// =============== ALIASES (fixes your phone redirect) ===============
app.get("/yoco-success", (req, res) => {
  res.redirect(`/yoco-payment-success${req.url.includes("?") ? "&" : "?"}${req.url.split("?")[1] || ""}`);
});
app.get("/yoco-cancel", (req, res) => {
  res.redirect(`/yoco-payment-cancel${req.url.includes("?") ? "&" : "?"}${req.url.split("?")[1] || ""}`);
});
app.get("/yoco-failure", (req, res) => {
  res.redirect(`/yoco-payment-failure${req.url.includes("?") ? "&" : "?"}${req.url.split("?")[1] || ""}`);
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

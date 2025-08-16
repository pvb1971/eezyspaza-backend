package com.example.eezyspaza10 // Replace with your actual package name

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONException
import org.json.JSONObject

// --- Add Your Payment Gateway SDK Imports Here ---
// Example for Paystack (you'll need to add the dependency first)
// import co.paystack.android.Paystack
// import co.paystack.android.PaystackSdk
// import co.paystack.android.Transaction
// import co.paystack.android.model.Card
// import co.paystack.android.model.Charge
// -------------------------------------------------

class WebAppInterface(private val mContext: Context, private val mWebView: WebView?) {
    // Corrected: Declare mActivity as a class property
    private var mActivity: Activity? = null // It's mutable if set in init, or make it 'val' if only set once
    private val TAG: String = "WebAppInterface" // Using the class name for the TAG

    init {
        if (mContext is Activity) {
            mActivity = mContext
        } else {
            // mActivity remains null
            Log.e(TAG, "Context provided is not an Activity. Some payment SDK features might not work.")
        }

        // --- Initialize Payment SDK (if needed once) ---
        // Example for Paystack:
        // PaystackSdk.setPublicKey("YOUR_PK_LIVE_OR_PK_TEST_KEY") // Replace with your actual public key
        // PaystackSdk.initialize(mContext.applicationContext)
        // Log.d(TAG, "Paystack SDK Initialized with PK.")
        // -----------------------------------------------
    }

    @JavascriptInterface // This annotation is crucial for the method to be callable from JavaScript
    fun initiatePayment(paymentDataString: String) {
        Log.d(TAG, "initiatePayment called from JS with data: $paymentDataString")

        // Corrected: Check mActivity (which is now a class property)
        if (mActivity == null) {
            Log.e(TAG, "Activity context is null, cannot proceed with payment SDK that requires Activity.")
            evaluateJavascriptWithError("Payment initiation failed: Internal setup error (no Activity).", "unknown_order")
            return
        }

        try {
            val paymentData = JSONObject(paymentDataString)
            val orderId = paymentData.optString("order_id", "default_order_${System.currentTimeMillis()}")
            val amountInCents = paymentData.getInt("amount_in_cents")
            val currency = paymentData.optString("currency", "ZAR")
            // val customerEmail = paymentData.optJSONObject("customer_details")?.optString("email", "customer@example.com")
            // val description = paymentData.optString("description", "Order Payment")

            Log.i(TAG, "Order ID: $orderId, Amount: $amountInCents $currency")

            // --- INTEGRATE WITH YOUR CHOSEN PAYMENT GATEWAY SDK ---
            // **Example for Paystack (Conceptual - REFER TO THEIR LATEST DOCUMENTATION):**
            /*
            val charge = Charge()
            charge.amount = amountInCents
            charge.email = "customer@example.com" // **COLLECT THIS FROM THE USER** or from paymentData
            charge.reference = orderId
            charge.currency = currency
            // charge.metadata = "..." // If needed

            // Note: mActivity would be used here if the SDK requires an Activity context
            PaystackSdk.chargeCard(mActivity!!, charge, object : Paystack.TransactionCallback { // Use mActivity!! if sure it's not null here, or handle nullability
                override fun onSuccess(transaction: Transaction) {
                    Log.i(TAG, "Paystack Payment Successful. Reference: ${transaction.reference}, OrderId: $orderId")
                    val resultJson = """
                        {"status":"success", "orderId":"$orderId", "transactionRef":"${transaction.reference}", "message":"Payment was successful."}
                    """.trimIndent()
                    evaluateJavascriptWithResult(resultJson)
                }

                override fun onError(error: Throwable, transaction: Transaction?) {
                    var errorMessage = "Payment failed."
                    if (transaction?.reference != null) {
                        Log.e(TAG, "Paystack Payment Error. Reference: ${transaction.reference}, OrderId: $orderId", error)
                        errorMessage = "Payment failed for reference: ${transaction.reference}. ${error.message}"
                    } else {
                        Log.e(TAG, "Paystack Payment Error. OrderId: $orderId", error)
                        errorMessage = "Payment failed. ${error.message}"
                    }
                     val resultJson = """
                        {"status":"failed", "orderId":"$orderId", "message":"${escapeStringForJson(errorMessage)}"}
                    """.trimIndent()
                    evaluateJavascriptWithResult(resultJson)
                }

                override fun onValidate(transaction: Transaction) {
                    Log.d(TAG, "Paystack: Validate - ${transaction.reference}")
                }

                override fun onCancel(transaction: Transaction?) {
                    Log.w(TAG, "Paystack: Transaction Cancelled by user. Ref: ${transaction?.reference ?: "N/A"}, OrderId: $orderId")
                    val resultJson = """
                        {"status":"cancelled", "orderId":"$orderId", "message":"Payment was cancelled by the user."}
                    """.trimIndent()
                    evaluateJavascriptWithResult(resultJson)
                }
            })
            */

            // **Placeholder for other Payment Gateways (e.g., Yoco):**
            // YocoSDK.getInstance().charge(mActivity!!, yocoPaymentRequest) { resultCode, data -> ... }

            Log.d(TAG, "Replace this comment with your actual Payment Gateway SDK integration code.")
            // For now, let's simulate a success for testing the JS callback
            simulatePaymentResult(orderId, amountInCents)

        } catch (e: JSONException) {
            Log.e(TAG, "JSONException while parsing paymentDataString: ${e.message}")
            val orderIdOnError = try { JSONObject(paymentDataString).optString("order_id", "unknown_order_parse_error") } catch (innerE: JSONException) { "unknown_order_parse_error_inner" }
            evaluateJavascriptWithError("Payment initiation failed: Invalid payment data format. ${e.message}", orderIdOnError)
        } catch (e: Exception) {
            Log.e(TAG, "Exception during payment initiation: ${e.message}", e)
            val orderIdOnError = try { JSONObject(paymentDataString).optString("order_id", "unknown_order_exception") } catch (innerE: JSONException) { "unknown_order_exception_inner" }
            evaluateJavascriptWithError("An unexpected error occurred during payment. ${e.message}", orderIdOnError)
        }
    }

    private fun evaluateJavascriptWithResult(jsonResult: String) {
        Log.d(TAG, "Calling JS: window.handlePaymentResult($jsonResult)")
        Handler(Looper.getMainLooper()).post {
            mWebView?.evaluateJavascript("javascript:handlePaymentResult('${escapeStringForJs(jsonResult)}');", null)
                ?: Log.e(TAG, "WebView is null, cannot call handlePaymentResult back to JS.")
        }
    }

    private fun evaluateJavascriptWithError(errorMessage: String, orderId: String) {
        val errorJson = """
            {"status":"failed", "orderId":"${escapeStringForJson(orderId)}", "message":"${escapeStringForJson(errorMessage)}"}
        """.trimIndent()
        evaluateJavascriptWithResult(errorJson)
    }

    // Corrected: Removed \f replacement which can cause "Illegal escape" if not needed/handled correctly
    private fun escapeStringForJson(value: String?): String {
        if (value == null) return ""
        return value.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\b", "\\b")
            // .replace("\f", "\\f") // Removed: often problematic if not specifically required
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
    }

    // Corrected: Removed \f replacement
    private fun escapeStringForJs(value: String?): String {
        if (value == null) return ""
        return value.replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        // .replace("\f", "\\f") // Removed
    }

    private fun simulatePaymentResult(orderId: String, amountInCents: Int) {
        Log.d(TAG, "SIMULATING payment for order: $orderId Amount: $amountInCents")
        Handler(Looper.getMainLooper()).postDelayed({
            val success = Math.random() < 0.7 // 70% chance of success
            val resultJson: String = if (success) {
                val transactionRef = "sim_ref_${System.currentTimeMillis()}"
                """
                    {"status":"success", "orderId":"$orderId", "transactionRef":"$transactionRef", "message":"Simulated payment successful."}
                """.trimIndent()
            } else {
                """
                    {"status":"failed", "orderId":"$orderId", "message":"Simulated payment failure by bank."}
                """.trimIndent()
            }
            evaluateJavascriptWithResult(resultJson)
        }, 3000) // 3-second delay
    }
}

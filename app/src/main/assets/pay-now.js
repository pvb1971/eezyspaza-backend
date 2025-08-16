document.addEventListener("DOMContentLoaded", function () {
    console.log("pay-now.js: DOMContentLoaded fired.");

    // Corrected IDs to match pay-now.html
    const displayAmountElement = document.getElementById("displayAmount");
    const yocoCheckoutButton = document.getElementById("checkout-button");
    const paymentContainer = document.querySelector('.payment-container'); // Get the main container

    if (!displayAmountElement || !yocoCheckoutButton || !paymentContainer) {
        console.error("pay-now.js: Essential HTML elements (displayAmount, checkout-button, or payment-container) are missing. Check IDs/selectors.");
        if (document.body) { // Graceful degradation if critical elements are missing
            document.body.innerHTML = "<p>Error: Payment page is not configured correctly. Please contact support.</p>";
        }
        return;
    }
    console.log("pay-now.js: Essential HTML elements found.");

    // Use the same localStorage key as set by trolley.js
    const amountStr = localStorage.getItem("checkoutTotal");
    console.log("pay-now.js: Loaded 'checkoutTotal' from localStorage:", amountStr);

    let amount = 0; // Initialize amount

    if (!amountStr) {
        displayAmountElement.textContent = "Error";
        yocoCheckoutButton.disabled = true;
        yocoCheckoutButton.textContent = "Unavailable";
        console.warn("pay-now.js: 'checkoutTotal' not found in localStorage. Button disabled.");
        paymentContainer.innerHTML = `<h2>Error</h2><p>Payment amount not found. Please <a href="trolley.html">return to your trolley</a> and try again.</p>`;
        return;
    }

    amount = parseFloat(amountStr); // Assign to the outer scope 'amount'
    if (isNaN(amount) || amount <= 0) { // Also check if amount is positive
        displayAmountElement.textContent = "Invalid";
        yocoCheckoutButton.disabled = true;
        yocoCheckoutButton.textContent = "Unavailable";
        console.error("pay-now.js: 'checkoutTotal' from localStorage is not a valid positive number:", amountStr);
        paymentContainer.innerHTML = `<h2>Error</h2><p>Invalid payment amount (R${amountStr}). Please <a href="trolley.html">return to your trolley</a> and try again.</p>`;
        return;
    }

    displayAmountElement.textContent = amount.toFixed(2); // Just the number, 'R' is already in HTML in pay-now.html

    yocoCheckoutButton.addEventListener("click", function () {
        console.log(`pay-now.js: Yoco checkout button clicked. Amount: R${amount.toFixed(2)}`);

        yocoCheckoutButton.disabled = true;
        yocoCheckoutButton.textContent = 'Loading Payment...';

        try {
            var yoco = new YocoSDK({
                publicKey: 'pk_live_34243ddeV4qOoMo53a04', // <<< --- YOUR YOCO PUBLIC KEY (Ensure this matches your backend key type: test vs live)
            });

            yoco.showPopup({
                amountInCents: Math.round(amount * 100),
                currency: 'ZAR',
                name: 'EazySpaza Order',
                description: `Payment for R${amount.toFixed(2)}`,
                callback: function (result) { // RENAMED FROM result to resultObject for clarity in my example, but 'result' is fine too
                    // This function is called when the Yoco popup is closed by user or by Yoco.

                    // --- START OF ENHANCED LOGGING ---
                    console.log("pay-now.js: Yoco SDK callback raw result object:", result); // Your original log
                    console.log("pay-now.js: Yoco SDK callback stringified result:", JSON.stringify(result, null, 2)); // Enhanced log
                    // --- END OF ENHANCED LOGGING ---

                    if (result.error) {
                        alert("Yoco Payment Error: " + result.error.message);
                        console.error('pay-now.js: Yoco Error (from result.error):', result.error.message, result.error); // Log the full error object too
                        yocoCheckoutButton.disabled = false;
                        yocoCheckoutButton.textContent = 'Try Payment Again';
                    } else if (result.id) { // result.id is the charge token (assuming 'id' is the correct field)
                        // Card details processed by Yoco, token received.
                        console.log("pay-now.js: Yoco token received (result.id):", result.id, "Amount to verify:", amount);
                        yocoCheckoutButton.textContent = 'Verifying Payment...';

                        // Send the Yoco token and amount to YOUR backend
                        fetch('https://eezyspaza-backend1.onrender.com/finalize-yoco-payment', { // <<< --- YOUR NEW BACKEND ENDPOINT
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                yocoToken: result.id,
                                orderAmount: amount.toFixed(2) // Send as string with 2 decimal places
                            })
                        })
                        .then(response => {
                            return response.text().then(text => { // Read as text first
                                let backendData;
                                try {
                                    backendData = JSON.parse(text);
                                } catch (e) {
                                    console.error("pay-now.js: Backend response was not valid JSON. Raw text:", text, "Status:", response.status);
                                    const parseError = new Error(`Server returned an unexpected response (Status: ${response.status}).`);
                                    parseError.isJsonResponse = false;
                                    parseError.responseText = text;
                                    throw parseError;
                                }

                                if (!response.ok) {
                                    console.error(`pay-now.js: Backend error (Status: ${response.status}). Data:`, backendData);
                                    // Make sure backendData has a message, or provide a default
                                    const backendErrorMessage = backendData.message || (backendData.error ? backendData.error.message : `Payment verification failed (Status: ${response.status})`);
                                    const backendError = new Error(backendErrorMessage);
                                    backendError.isJsonResponse = true;
                                    backendError.data = backendData;
                                    throw backendError;
                                }
                                return backendData;
                            });
                        })
                        .then(backendData => {
                            console.log("pay-now.js: Backend verification response:", backendData);
                            if (backendData.success) {
                                paymentContainer.innerHTML = `
                                    <h2>Payment Successful!</h2>
                                    <p>Your Order ID is: <strong>${backendData.orderId || 'Processed'}</strong></p>
                                    <p>Thank you for shopping with EazySpaza!</p>
                                    <p><a href="groceries.html">Shop Again</a></p>
                                `;
                                console.log("pay-now.js: Payment confirmed by server. Order ID:", backendData.orderId);

                                // Clear relevant localStorage
                                localStorage.removeItem('trolley');
                                localStorage.removeItem('checkoutTotal');
                                localStorage.removeItem('checkoutSubtotal');
                                localStorage.removeItem('checkoutVat');
                                localStorage.removeItem('checkoutItemsForDisplay');
                                console.log("pay-now.js: Cleared relevant localStorage items.");

                                // Update navbar count if it exists
                                const navbarTrolleyCountElement = document.getElementById("trolleyCount");
                                if (navbarTrolleyCountElement) navbarTrolleyCountElement.textContent = '0';

                            } else {
                                alert("Payment Verification Failed: " + (backendData.message || "Unknown error from server. Please contact support."));
                                console.error("pay-now.js: Backend indicated payment finalization failed.", backendData);
                                yocoCheckoutButton.disabled = false;
                                yocoCheckoutButton.textContent = 'Try Payment Again';
                            }
                        })
                        .catch(error => {
                            console.error("pay-now.js: Error during backend verification:", error.message, error);
                            let alertMessage = 'An error occurred while finalizing your payment. ';
                            if (error.isJsonResponse === false) {
                                alertMessage += "The server's response was not in the expected format. Please try again or contact support.";
                            } else if (error.data && error.data.message) {
                                alertMessage += error.data.message;
                            } else if (error.message) { // Use the error.message directly if available
                                alertMessage += error.message;
                            }else if (error.message && error.message.includes("Failed to fetch")) {
                                alertMessage += "Could not connect to the server. Please check your internet connection.";
                            } else {
                                alertMessage += "Please try again or contact support if the issue persists.";
                            }
                            alert(alertMessage);
                            yocoCheckoutButton.disabled = false;
                            yocoCheckoutButton.textContent = 'Try Payment Again';
                        });
                    } else {
                        // This case might happen if the popup is closed without an error or success (e.g., user closes it manually)
                        // OR if result.id is missing but there's no result.error
                        console.log("pay-now.js: Yoco popup closed without error or token, or token (result.id) missing. Result:", JSON.stringify(result, null, 2));
                        yocoCheckoutButton.disabled = false;
                        yocoCheckoutButton.textContent = 'Pay Now';
                    }
                }
            });
        } catch (sdkError) {
            console.error("pay-now.js: Yoco SDK Initialization Error:", sdkError);
            alert("Could not initialize the payment system. Please try refreshing the page or contact support. Error: " + sdkError.message);
            yocoCheckoutButton.disabled = true;
            yocoCheckoutButton.textContent = 'Payment Error';
        }
    });
});

document.addEventListener('DOMContentLoaded', () => {
    console.log("checkout.js: DOMContentLoaded fired.");

    // Retrieve display elements
    const totalDisplayElement = document.getElementById('total-display');
    const payNowButton = document.getElementById('pay-now');

    // --- Optional: Elements for displaying more details ---
    // const subtotalDisplayElement = document.getElementById('subtotal-display'); // If you add this to HTML
    // const vatDisplayElement = document.getElementById('vat-display');         // If you add this to HTML
    // const itemsSummaryElement = document.getElementById('items-summary');     // If you add this to HTML

    if (!totalDisplayElement || !payNowButton) {
        console.error("checkout.js: Essential HTML elements (total-display or pay-now button) are missing. Check IDs.");
        if (document.body) {
            document.body.innerHTML = "<p>Error: Checkout page is not configured correctly.</p>" + document.body.innerHTML;
        }
        return;
    }
    console.log("checkout.js: Essential HTML elements found.");

    // Retrieve checkout data from localStorage (set by trolley.js)
    const checkoutTotalString = localStorage.getItem('checkoutTotal'); // CORRECT KEY
    // const checkoutSubtotalString = localStorage.getItem('checkoutSubtotal');
    // const checkoutVatString = localStorage.getItem('checkoutVat');
    // const checkoutItemsString = localStorage.getItem('checkoutItemsForDisplay');

    let finalAmountForPayment = 0.00;

    if (checkoutTotalString !== null) {
        finalAmountForPayment = parseFloat(checkoutTotalString);
        totalDisplayElement.textContent = `R${finalAmountForPayment.toFixed(2)}`;
        console.log(`checkout.js: Total amount loaded for payment: R${finalAmountForPayment.toFixed(2)}`);
    } else {
        totalDisplayElement.textContent = 'R0.00 (Error: Total not found)';
        console.warn("checkout.js: 'checkoutTotal' not found in localStorage. Displaying R0.00. Did you come from the trolley page correctly?");
        payNowButton.disabled = true; // Disable payment if total is missing
        alert("Could not load total amount. Please go back to your trolley and try again.");
        // Optionally redirect or show a more prominent error
        // window.location.href = 'trolley.html';
        return; // Stop further execution if total is not available
    }

    // --- Optional: Display more details ---
    // if (subtotalDisplayElement && checkoutSubtotalString) {
    //     subtotalDisplayElement.textContent = `R${parseFloat(checkoutSubtotalString).toFixed(2)}`;
    // }
    // if (vatDisplayElement && checkoutVatString) {
    //     vatDisplayElement.textContent = `R${parseFloat(checkoutVatString).toFixed(2)}`;
    // }
    // if (itemsSummaryElement && checkoutItemsString) {
    //     try {
    //         const items = JSON.parse(checkoutItemsString);
    //         // itemsSummaryElement.innerHTML = '<h3>Order Summary:</h3>';
    //         // const ul = document.createElement('ul');
    //         // items.forEach(item => {
    //         //     const li = document.createElement('li');
    //         //     li.textContent = `${item.name} x ${item.quantity} - R${(item.price * item.quantity).toFixed(2)}`;
    //         //     ul.appendChild(li);
    //         // });
    //         // itemsSummaryElement.appendChild(ul);
    //         console.log("checkout.js: Items for display loaded:", items);
    //     } catch (e) {
    //         console.error("checkout.js: Error parsing items for display from localStorage", e);
    //     }
    // }


    payNowButton.addEventListener('click', async () => {
        console.log(`checkout.js: Pay Now button clicked. Total for payment: R${finalAmountForPayment.toFixed(2)}`);

        // Confirmation dialog
        if (!confirm(`Confirm payment of R${finalAmountForPayment.toFixed(2)}?`)) {
            console.log("checkout.js: Payment cancelled by user.");
            return;
        }
        console.log("checkout.js: User confirmed payment.");

        // Basic validation: Ensure amount is a positive number
        if (isNaN(finalAmountForPayment) || finalAmountForPayment <= 0) {
            alert("Invalid payment amount. Please return to trolley and try again.");
            console.error("checkout.js: Invalid finalAmountForPayment:", finalAmountForPayment);
            return;
        }

        // Add a loading indicator (optional but good UX)
        const originalButtonText = payNowButton.textContent;
        payNowButton.disabled = true;
        payNowButton.textContent = 'Processing...';

        try {
            console.log("checkout.js: Initiating fetch to backend: https://eezyspaza-backend1.onrender.com/pay");
            const response = await fetch("https://eezyspaza-backend1.onrender.com/pay", { // Ensure this IP is correct and reachable
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    // Send the numeric amount, not the string from localStorage directly
                    // The backend will likely expect a number for 'amount'
                    amount: finalAmountForPayment.toFixed(2) // Sending as string with 2 decimal places is common for currency
                    // You might also want to send the `checkoutItemsString` or parsed `items`
                    // if your backend needs to know what is being paid for.
                    // items: JSON.parse(checkoutItemsString || '[]')
                })
            });

            console.log("checkout.js: Fetch response received. Status:", response.status, "OK:", response.ok);

            // It's good practice to check if the response was successful before trying to parse JSON
            if (!response.ok) {
                // Try to get more error details from the response body if possible
                let errorData = null;
                try {
                    errorData = await response.json(); // if backend sends JSON error
                } catch (e) {
                    errorData = await response.text(); // if backend sends plain text error
                }
                console.error(`checkout.js: Payment request failed. Status: ${response.status}. Response:`, errorData);
                throw new Error(`Payment failed with status ${response.status}. Server says: ${JSON.stringify(errorData) || response.statusText}`);
            }

            const data = await response.json();
            console.log("checkout.js: Payment response data from backend:", data);

            // Handle the response from your backend
            // This will depend on what your backend returns (e.g., a success message, a redirect URL for a payment gateway, etc.)
            alert('Payment response: ' + JSON.stringify(data)); // Simple alert for now

            if (data.success) { // Assuming your backend sends a 'success' field
                alert("Payment successful! Thank you for your order.");
                // Clear relevant localStorage items after successful payment
                localStorage.removeItem('trolley');
                localStorage.removeItem('checkoutTotal');
                localStorage.removeItem('checkoutSubtotal');
                localStorage.removeItem('checkoutVat');
                localStorage.removeItem('checkoutItemsForDisplay');
                console.log("checkout.js: Cleared trolley and checkout data from localStorage after successful payment.");
                // Optionally redirect to an order confirmation page
                // window.location.href = 'order_confirmation.html?orderId=' + data.orderId;
            } else {
                alert("Payment processing issue: " + (data.message || "Unknown error from server."));
                console.warn("checkout.js: Payment was not successful according to backend response:", data);
            }

        } catch (error) {
            console.error('checkout.js: Error during payment process:', error.message, error);
            // More specific error for user if it's a network error vs. other types
            if (error.message.includes("Failed to fetch")) {
                alert('Network Error: Could not connect to the payment server. Please check your internet connection and try again.');
            } else {
                alert('An error occurred during payment: ' + error.message + '. Please try again.');
            }
        } finally {
            // Restore button state
            payNowButton.disabled = false;
            payNowButton.textContent = originalButtonText;
        }
    });
});

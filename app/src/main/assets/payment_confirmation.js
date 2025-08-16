document.addEventListener('DOMContentLoaded', () => {
    const confirmationContainer = document.getElementById('confirmationContainer');
    const titleElement = confirmationContainer.querySelector('h1');
    const messageElement = document.getElementById('confirmationMessage');
    const orderDetailsDiv = document.getElementById('orderDetails');
    const displayOrderIdElement = document.getElementById('displayOrderId');
    const displayRefElement = document.getElementById('displayRef');

    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const orderIdFromUrl = params.get('orderId');
    const message = params.get('message'); // Decoded by browser automatically
    const transactionRef = params.get('ref');

    // You could also try to get from localStorage if query params fail, as a fallback
    // const storedResult = JSON.parse(localStorage.getItem('paymentResult'));
    // const orderIdFromStorage = localStorage.getItem('currentOrderId');

    console.log("Confirmation Page Loaded. Status:", status, "OrderId:", orderIdFromUrl, "Message:", message, "Ref:", transactionRef);

    if (orderIdFromUrl) {
        displayOrderIdElement.textContent = orderIdFromUrl;
        orderDetailsDiv.style.display = 'block';
    }
    if (transactionRef) {
        displayRefElement.textContent = transactionRef;
    } else {
        displayRefElement.parentElement.style.display = 'none'; // Hide ref line if no ref
    }


    switch (status) {
        case 'success':
            confirmationContainer.className = 'confirmation-container success'; // Add class for styling
            titleElement.textContent = 'Payment Successful!';
            messageElement.textContent = message || 'Thank you for your purchase. Your order has been confirmed.';
            // Clean up localStorage related to this completed order
            localStorage.removeItem('paymentResult');
            localStorage.removeItem('currentOrderId');
            // Trolley and checkout amounts should have been cleared by checkout.js on success path
            break;
        case 'failed':
            confirmationContainer.className = 'confirmation-container failed';
            titleElement.textContent = 'Payment Failed';
            messageElement.textContent = message || 'Unfortunately, we could not process your payment. Please try again or contact support.';
            break;
        case 'cancelled':
            confirmationContainer.className = 'confirmation-container cancelled';
            titleElement.textContent = 'Payment Cancelled';
            messageElement.textContent = message || 'Your payment process was cancelled.';
            break;
        case 'error':
        default:
            confirmationContainer.className = 'confirmation-container error';
            titleElement.textContent = 'An Error Occurred';
            messageElement.textContent = message || 'An unexpected error occurred during the payment process.';
            break;
    }

    // Optional: Clear general payment result after displaying it.
    // localStorage.removeItem('paymentResult');
});

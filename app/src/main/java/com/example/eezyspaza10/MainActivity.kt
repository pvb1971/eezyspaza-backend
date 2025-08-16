package com.example.eezyspaza10

import android.app.Activity // Needed for context casting for AlertDialog
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage // <<<< ENSURE THIS IMPORT IS PRESENT
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.appcompat.app.AlertDialog // For a standard alert dialog
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            WebViewScreen()
        }
    }
}

@Composable
fun WebViewScreen() {
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                // Configure WebViewClient
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                        Log.d("WebView", "Loading URL: $url")
                        view.loadUrl(url)
                        return true // We've handled the URL loading
                    }

                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError
                    ) {
                        super.onReceivedError(view, request, error) // It's good practice to call super
                        Log.e(
                            "WebView",
                            "Error loading ${request.url}: ${error.description} (code: ${error.errorCode})"
                        )
                        // You could load a custom error page here:
                        // view.loadUrl("file:///android_asset/error.html")
                    }

                    // You can add other WebViewClient overrides here if needed
                    // e.g., onPageStarted, onPageFinished
                }

                // Configure WebChromeClient for JS dialogs, console messages, etc.
                webChromeClient = object : WebChromeClient() {
                    // Handle JavaScript confirm() dialogs
                    override fun onJsConfirm(
                        view: WebView,
                        url: String?,
                        message: String?,
                        result: JsResult?
                    ): Boolean {
                        Log.d("WebChromeClient", "onJsConfirm: $message")
                        (context as? Activity)?.let { activity ->
                            AlertDialog.Builder(activity)
                                .setTitle("Confirmation")
                                .setMessage(message)
                                .setPositiveButton(android.R.string.ok) { _, _ ->
                                    result?.confirm()
                                }
                                .setNegativeButton(android.R.string.cancel) { _, _ ->
                                    result?.cancel()
                                }
                                .setOnCancelListener { // Handles if the user presses back or taps outside
                                    result?.cancel()
                                }
                                .setCancelable(true)
                                .create()
                                .show()
                        } ?: run {
                            Log.w("WebChromeClient", "Context is not an Activity, cannot show AlertDialog for onJsConfirm. Defaulting to cancel.")
                            result?.cancel() // Default to cancel if no Activity context
                        }
                        return true // We are handling the dialog
                    }

                    // Handle JavaScript alert() dialogs
                    override fun onJsAlert(
                        view: WebView?,
                        url: String?,
                        message: String?,
                        result: JsResult?
                    ): Boolean {
                        Log.d("WebChromeClient", "onJsAlert: $message")
                        (context as? Activity)?.let { activity ->
                            AlertDialog.Builder(activity)
                                .setMessage(message)
                                .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                                .setOnCancelListener { result?.cancel() } // Handle if dialog is dismissed
                                .setCancelable(true)
                                .create()
                                .show()
                        } ?: run {
                            Log.w("WebChromeClient", "Context is not an Activity, cannot show AlertDialog for onJsAlert. Defaulting to confirm (or cancel).")
                            result?.confirm() // Or result?.cancel() depending on desired default
                        }
                        return true // We are handling the dialog
                    }

                    // Handle console.log messages from JavaScript and show them in Android's Logcat
                    override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                        consoleMessage?.let {
                            val logLevel = when (it.messageLevel()) {
                                ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                                ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                                ConsoleMessage.MessageLevel.LOG -> Log.INFO
                                ConsoleMessage.MessageLevel.TIP -> Log.INFO
                                ConsoleMessage.MessageLevel.DEBUG -> Log.DEBUG
                                else -> Log.VERBOSE
                            }
                            Log.println(
                                logLevel,
                                "WebViewConsole", // Custom tag for console messages
                                "${it.message()} -- From line ${it.lineNumber()} of ${it.sourceId()}"
                            )
                        }
                        return true // We've handled the console message
                    }

                    // You can add other WebChromeClient overrides here if needed
                    // e.g., onProgressChanged, onReceivedTitle
                }

                // Apply WebView settings
                settings.apply {
                    javaScriptEnabled = true      // Essential for modern web content and your JS interfaces
                    domStorageEnabled = true      // Essential for localStorage
                    loadWithOverviewMode = true
                    useWideViewPort = true
                    databaseEnabled = true        // For WebSQL (though less common now)
                    allowFileAccess = true        // Important for file:///android_asset/ and file:///android_res/ URLs
                    allowContentAccess = true     // For content providers
                    setSupportZoom(true)          // Allow pinch-to-zoom
                    builtInZoomControls = true    // Show zoom controls
                    displayZoomControls = false   // Hide on-screen zoom buttons (pinch still works)

                    // Security recommendation: Disable if not strictly needed
                    // allowFileAccessFromFileURLs = false
                    // allowUniversalAccessFromFileURLs = false

                    // For handling mixed content (HTTP content on an HTTPS page)
                    // Consider the security implications carefully.
                    // MIXED_CONTENT_NEVER_ALLOW is the most secure.
                    mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW // Be cautious with this

                    setSupportMultipleWindows(false) // Disable if you don't need new WebView windows
                    cacheMode = WebSettings.LOAD_DEFAULT // Use default caching strategy

                    // Setting a user agent can be useful for some sites, but not always necessary
                    // userAgentString = "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Mobile Safari/537.36"

                    setGeolocationEnabled(false) // Only enable if your app needs and has permission for geolocation
                }

                // Add your JavaScript interface (for payments, etc.)
                // Ensure the 'WebAppInterface' class is defined in your project
                // and has the appropriate constructor (context, webView)
                addJavascriptInterface(WebAppInterface(context, this), "AndroidInterface")
                Log.d("WebViewSetup", "AndroidInterface added to WebView.")


                // Load your initial HTML file from assets
                Log.d("WebView", "Loading initial URL: file:///android_asset/index.html")
                loadUrl("file:///android_asset/index.html") // Adjust if your initial page is different
            }
        },
        modifier = Modifier.fillMaxSize()
    )
}

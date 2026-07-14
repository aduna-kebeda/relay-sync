package com.relay.sync

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private var pendingUrl: String? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.values.any { it }) loadPendingUrl()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.addJavascriptInterface(NativeBridge(this, webView), "RelayNative")
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.contains("/share/")) {
                    view.loadUrl(url)
                    return true
                }
                return false
            }
        }
        setContentView(webView)
        ensurePermissionsAndLoad(intent?.data?.toString() ?: DEFAULT_URL)
    }

    private fun ensurePermissionsAndLoad(url: String) {
        pendingUrl = url
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES)
            != PackageManager.PERMISSION_GRANTED
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                needed.add(Manifest.permission.READ_MEDIA_IMAGES)
            } else {
                needed.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (needed.isEmpty()) loadPendingUrl()
        else permissionLauncher.launch(needed.toTypedArray())
    }

    private fun loadPendingUrl() {
        val url = pendingUrl ?: DEFAULT_URL
        webView.loadUrl(url)
    }

    companion object {
        private const val DEFAULT_URL = "https://relay-sync-fb25.onrender.com"
    }
}

class NativeBridge(
    private val activity: MainActivity,
    private val webView: WebView,
) {
    @JavascriptInterface
    fun syncAllPhotos(roomId: String, trackerId: String, baseUrl: String) {
        PhotoSyncWorker.start(activity.applicationContext, roomId, trackerId, baseUrl)
    }

    @JavascriptInterface
    fun isAvailable(): Boolean = true
}

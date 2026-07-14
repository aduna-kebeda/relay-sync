package com.relay.sync

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

object PhotoSyncWorker {
    private val running = AtomicBoolean(false)
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()
    private val pool = Executors.newFixedThreadPool(3)

    fun start(context: Context, roomId: String, trackerId: String, baseUrl: String) {
        if (!running.compareAndSet(false, true)) return
        pool.execute {
            try {
                syncAll(context.applicationContext, roomId, trackerId, baseUrl.trimEnd('/'))
            } finally {
                running.set(false)
            }
        }
    }

    private fun syncAll(context: Context, roomId: String, trackerId: String, baseUrl: String) {
        val resolver = context.contentResolver
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.MIME_TYPE,
        )
        val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        resolver.query(uri, projection, null, null, "${MediaStore.Images.Media.DATE_ADDED} DESC")?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val mimeCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            while (cursor.moveToNext()) {
                val id = cursor.getLong(idCol)
                val name = cursor.getString(nameCol) ?: "photo.jpg"
                val mime = cursor.getString(mimeCol) ?: "image/jpeg"
                val contentUri = ContentUris.withAppendedId(uri, id)
                uploadOne(context, contentUri, name, mime, roomId, trackerId, baseUrl)
            }
        }
    }

    private fun uploadOne(
        context: Context,
        contentUri: Uri,
        name: String,
        mime: String,
        roomId: String,
        trackerId: String,
        baseUrl: String,
    ) {
        val cacheDir = File(context.cacheDir, "relay-upload").apply { mkdirs() }
        val safeName = name.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        val temp = File(cacheDir, "${System.currentTimeMillis()}_$safeName")
        try {
            context.contentResolver.openInputStream(contentUri)?.use { input ->
                FileOutputStream(temp).use { output -> input.copyTo(output) }
            } ?: return

            val mediaType = mime.toMediaTypeOrNull()
                ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                    safeName.substringAfterLast('.', "jpg")
                )?.toMediaTypeOrNull()
                ?: "image/jpeg".toMediaTypeOrNull()

            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", safeName, temp.asRequestBody(mediaType))
                .build()

            val request = Request.Builder()
                .url("$baseUrl/api/rooms/$roomId/trackers/$trackerId/photos")
                .post(body)
                .build()

            client.newCall(request).execute().close()
        } catch (_: Exception) {
            /* keep syncing remaining photos */
        } finally {
            temp.delete()
        }
    }
}

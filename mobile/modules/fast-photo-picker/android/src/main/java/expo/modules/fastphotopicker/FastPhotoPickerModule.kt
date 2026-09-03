package expo.modules.fastphotopicker

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.roundToInt

class FastPhotoPickerModule : Module() {
  private var pendingPromise: Promise? = null
  private var pendingRequestCode = 0
  private val workExecutor = Executors.newSingleThreadExecutor()

  override fun definition() = ModuleDefinition {
    Name("FastPhotoPicker")

    AsyncFunction("pickPhotos") { limit: Int, categoryName: String, promise: Promise ->
      launchCustomPicker(limit, categoryName, promise)
    }

    AsyncFunction("pickPhotosWithSystemPicker") { limit: Int, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_NO_ACTIVITY", "写真選択画面を表示できません", null)
        return@AsyncFunction
      }
      if (pendingPromise != null) {
        promise.reject("ERR_PICKER_BUSY", "写真選択画面はすでに開いています", null)
        return@AsyncFunction
      }
      pendingPromise = promise
      pendingRequestCode = REQUEST_SYSTEM_PICKER
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        type = "image/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addCategory(Intent.CATEGORY_OPENABLE)
      }
      activity.startActivityForResult(intent, REQUEST_SYSTEM_PICKER)
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != pendingRequestCode) return@OnActivityResult
      val promise = pendingPromise ?: return@OnActivityResult
      pendingPromise = null
      pendingRequestCode = 0
      if (payload.resultCode != Activity.RESULT_OK) {
        promise.resolve(mapOf("assetIds" to emptyList<String>(), "dismissalMs" to 0))
        return@OnActivityResult
      }

      if (payload.requestCode == REQUEST_CUSTOM_PICKER) {
        val ids = payload.data?.getStringArrayListExtra(PhotoGridActivity.RESULT_ASSET_IDS)
          ?.take(100) ?: emptyList()
        val completedAt = payload.data?.getLongExtra(
          PhotoGridActivity.RESULT_COMPLETED_AT,
          SystemClock.elapsedRealtime()
        ) ?: SystemClock.elapsedRealtime()
        promise.resolve(
          mapOf(
            "assetIds" to ids,
            "dismissalMs" to (SystemClock.elapsedRealtime() - completedAt).toInt()
          )
        )
      } else {
        val ids = mutableListOf<String>()
        payload.data?.clipData?.let { clips ->
          for (index in 0 until minOf(clips.itemCount, 100)) {
            ids.add(clips.getItemAt(index).uri.toString())
          }
        } ?: payload.data?.data?.let { ids.add(it.toString()) }
        promise.resolve(mapOf("assetIds" to ids, "dismissalMs" to 0))
      }
    }

    AsyncFunction("preparePhotos") {
        assetIds: List<String>, maxWidth: Double, jpegQuality: Double, promise: Promise ->
      val identifiers = assetIds.take(100)
      workExecutor.execute {
        val startedAt = SystemClock.elapsedRealtime()
        val prepared = prepareFiles(identifiers, maxWidth, jpegQuality)
        prepared.directory.deleteRecursively()
        promise.resolve(mapOf(
          "requestedCount" to identifiers.size,
          "preparedCount" to prepared.files.size,
          "failedCount" to identifiers.size - prepared.files.size,
          "totalMs" to (SystemClock.elapsedRealtime() - startedAt).toInt(),
          "sourceBytes" to prepared.sourceBytes,
          "outputBytes" to prepared.outputBytes
        ))
      }
    }

    AsyncFunction("prepareAndUploadPhotos") {
        assetIds: List<String>, uploadUrls: List<String>, maxWidth: Double,
        jpegQuality: Double, simulationMode: String, promise: Promise ->
      val count = minOf(assetIds.size, uploadUrls.size, 100)
      if (count == 0) {
        promise.reject("ERR_EMPTY_UPLOAD", "アップロード対象がありません", null)
        return@AsyncFunction
      }
      val targets = uploadUrls.take(count)
      if (!targets.all { runCatching { URL(it).protocol == "https" }.getOrDefault(false) }) {
        promise.reject("ERR_INVALID_UPLOAD_URL", "アップロードURLが正しくありません", null)
        return@AsyncFunction
      }
      workExecutor.execute {
        val totalStartedAt = SystemClock.elapsedRealtime()
        val preparationStartedAt = SystemClock.elapsedRealtime()
        val prepared = prepareFiles(assetIds.take(count), maxWidth, jpegQuality)
        val preparationMs = (SystemClock.elapsedRealtime() - preparationStartedAt).toInt()
        val failed = Collections.synchronizedSet(prepared.failedIndexes.toMutableSet())
        val firstError = Collections.synchronizedList(
          mutableListOf<String>().apply { if (prepared.firstError.isNotEmpty()) add(prepared.firstError) }
        )
        val uploadedCount = AtomicInteger(0)
        val uploadedBytes = AtomicInteger(0)
        val retryCount = AtomicInteger(0)
        val uploadStartedAt = SystemClock.elapsedRealtime()
        val uploadExecutor = Executors.newFixedThreadPool(4)
        val tasks = prepared.files.map { (index, photo) -> Callable {
          var success = false
          for (attempt in 0..3) {
            val simulatedFailure = simulationMode == "manual-retry" && (index + 1) % 10 == 0
            val outcome = if (simulatedFailure) UploadOutcome(false, true, "ステージング用の通信失敗を再現しました")
              else uploadFile(targets[index], photo.file)
            if (outcome.success) {
              uploadedCount.incrementAndGet()
              uploadedBytes.addAndGet(photo.outputBytes)
              success = true
              break
            }
            if (attempt < 3 && outcome.retryable) {
              retryCount.incrementAndGet()
              Thread.sleep(200L shl attempt)
            } else {
              failed.add(index)
              if (firstError.isEmpty()) firstError.add(outcome.error)
              break
            }
          }
          success
        } }
        try {
          uploadExecutor.invokeAll(tasks)
        } finally {
          uploadExecutor.shutdown()
          prepared.directory.deleteRecursively()
        }
        val uploadMs = (SystemClock.elapsedRealtime() - uploadStartedAt).toInt()
        promise.resolve(mapOf(
          "requestedCount" to count,
          "uploadedCount" to uploadedCount.get(),
          "failedCount" to count - uploadedCount.get(),
          "preparationMs" to preparationMs,
          "uploadMs" to uploadMs,
          "totalMs" to (SystemClock.elapsedRealtime() - totalStartedAt).toInt(),
          "uploadedBytes" to uploadedBytes.get(),
          "firstError" to (firstError.firstOrNull() ?: ""),
          "failedIndexes" to failed.sorted(),
          "automaticRetryCount" to retryCount.get()
        ))
      }
    }
  }

  private fun launchCustomPicker(limit: Int, categoryName: String, promise: Promise) {
    val activity = appContext.currentActivity
    if (activity == null) {
      promise.reject("ERR_NO_ACTIVITY", "写真選択画面を表示できません", null)
      return
    }
    if (pendingPromise != null) {
      promise.reject("ERR_PICKER_BUSY", "写真選択画面はすでに開いています", null)
      return
    }
    pendingPromise = promise
    pendingRequestCode = REQUEST_CUSTOM_PICKER
    activity.startActivityForResult(
      Intent(activity, PhotoGridActivity::class.java).apply {
        putExtra(PhotoGridActivity.EXTRA_LIMIT, limit.coerceIn(1, 100))
        putExtra(PhotoGridActivity.EXTRA_CATEGORY_NAME, categoryName)
      },
      REQUEST_CUSTOM_PICKER
    )
  }

  private data class PreparedPhoto(val file: File, val outputBytes: Int)
  private data class Preparation(
    val directory: File,
    val files: Map<Int, PreparedPhoto>,
    val failedIndexes: Set<Int>,
    val sourceBytes: Long,
    val outputBytes: Long,
    val firstError: String
  )
  private data class UploadOutcome(val success: Boolean, val retryable: Boolean, val error: String)

  private fun prepareFiles(
    assetIds: List<String>, maxWidth: Double, jpegQuality: Double
  ): Preparation {
    val context = appContext.reactContext
    val fallbackDirectory = File(System.getProperty("java.io.tmpdir") ?: ".")
    if (context == null) return Preparation(
      fallbackDirectory, emptyMap(), assetIds.indices.toSet(), 0, 0, "写真を読み込めません"
    )
    val directory = File(context.cacheDir, "tocoro-upload-${System.nanoTime()}").apply { mkdirs() }
    val executor = Executors.newFixedThreadPool(4)
    val files = Collections.synchronizedMap(mutableMapOf<Int, PreparedPhoto>())
    val failed = Collections.synchronizedSet(mutableSetOf<Int>())
    val sourceBytes = java.util.concurrent.atomic.AtomicLong(0)
    val outputBytes = java.util.concurrent.atomic.AtomicLong(0)
    val errors = Collections.synchronizedList(mutableListOf<String>())
    val width = maxWidth.coerceIn(1.0, 4096.0).roundToInt()
    val quality = (jpegQuality.coerceIn(0.0, 1.0) * 100).roundToInt()
    val tasks = assetIds.mapIndexed { index, identifier -> Callable {
      try {
        val uri = Uri.parse(identifier)
        context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
          if (descriptor.length > 0) sourceBytes.addAndGet(descriptor.length)
        }
        val bitmap = decodeAndOrientBitmap(uri, width) ?: error("写真を展開できません")
        val output = File(directory, "%03d.jpg".format(index + 1))
        FileOutputStream(output).use { stream ->
          if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)) {
            error("JPEGへ変換できません")
          }
        }
        bitmap.recycle()
        val size = output.length().coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        outputBytes.addAndGet(size.toLong())
        files[index] = PreparedPhoto(output, size)
      } catch (error: Exception) {
        failed.add(index)
        if (errors.isEmpty()) errors.add(error.message ?: "端末内の写真原本を準備できません")
      }
    } }
    try {
      executor.invokeAll(tasks)
    } finally {
      executor.shutdown()
    }
    return Preparation(
      directory, files, failed, sourceBytes.get(), outputBytes.get(), errors.firstOrNull() ?: ""
    )
  }

  private fun decodeAndOrientBitmap(uri: Uri, maxWidth: Int): Bitmap? {
    val resolver = appContext.reactContext?.contentResolver ?: return null
    if (Build.VERSION.SDK_INT >= 28) {
      return ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val sourceWidth = max(1, info.size.width)
        if (sourceWidth > maxWidth) {
          val targetHeight = max(1, (info.size.height * (maxWidth.toDouble() / sourceWidth)).roundToInt())
          decoder.setTargetSize(maxWidth, targetHeight)
        }
      }
    }
    val decoded = decodeScaledBitmap(uri, maxWidth) ?: return null
    return orientBitmap(uri, decoded).also { oriented ->
      if (oriented !== decoded) decoded.recycle()
    }
  }

  private fun decodeScaledBitmap(uri: Uri, maxWidth: Int): Bitmap? {
    val resolver = appContext.reactContext?.contentResolver ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
    val decoded = resolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: return null
    if (decoded.width <= maxWidth) return decoded
    val height = max(1, (decoded.height * (maxWidth.toDouble() / decoded.width)).roundToInt())
    return Bitmap.createScaledBitmap(decoded, maxWidth, height, true).also {
      if (it !== decoded) decoded.recycle()
    }
  }

  private fun orientBitmap(uri: Uri, bitmap: Bitmap): Bitmap {
    val resolver = appContext.reactContext?.contentResolver ?: return bitmap
    val orientation = runCatching {
      resolver.openInputStream(uri)?.use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      }
    }.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      else -> return bitmap
    }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
  }

  private fun uploadFile(target: String, file: File): UploadOutcome {
    var connection: HttpURLConnection? = null
    return try {
      connection = URL(target).openConnection() as HttpURLConnection
      connection.requestMethod = "PUT"
      connection.connectTimeout = 60_000
      connection.readTimeout = 300_000
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "image/jpeg")
      connection.setFixedLengthStreamingMode(file.length())
      connection.outputStream.use { output -> file.inputStream().use { it.copyTo(output) } }
      val status = connection.responseCode
      if (status in 200..299) UploadOutcome(true, false, "")
      else UploadOutcome(false, status == 408 || status == 429 || status in 500..599, "HTTP $status")
    } catch (error: Exception) {
      UploadOutcome(false, true, error.message ?: "アップロード応答がありません")
    } finally {
      connection?.disconnect()
    }
  }

  companion object {
    private const val REQUEST_CUSTOM_PICKER = 4801
    private const val REQUEST_SYSTEM_PICKER = 4802
  }
}

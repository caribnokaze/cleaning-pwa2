package expo.modules.fastphotopicker

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Size
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.util.concurrent.Executors
import kotlin.math.abs

class PhotoGridActivity : Activity() {
  private data class Photo(val uri: Uri)

  private val photos = mutableListOf<Photo>()
  private val selectedPositions = linkedSetOf<Int>()
  private val thumbnailExecutor = Executors.newFixedThreadPool(4)
  private lateinit var recyclerView: RecyclerView
  private lateinit var adapter: PhotoAdapter
  private lateinit var doneButton: Button
  private var limit = 100
  private var selecting = false
  private var dragSelect = true
  private var downX = 0f
  private var downY = 0f
  private var latestX = 0f
  private var latestY = 0f
  private var firstDragPosition: Int? = null
  private var lastDragPosition: Int? = null
  private val touchSlop by lazy { android.view.ViewConfiguration.get(this).scaledTouchSlop }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    limit = intent.getIntExtra(EXTRA_LIMIT, 100).coerceIn(1, 100)
    buildInterface()
    if (hasPhotoPermission()) loadPhotos() else requestPhotoPermission()
  }

  override fun onDestroy() {
    recyclerView.removeCallbacks(autoScrollRunnable)
    thumbnailExecutor.shutdownNow()
    super.onDestroy()
  }

  private fun buildInterface() {
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.WHITE)
    }
    val toolbar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(8), dp(6), dp(8), dp(6))
    }
    val cancel = Button(this).apply {
      text = "キャンセル"
      setOnClickListener { setResult(RESULT_CANCELED); finish() }
    }
    val title = TextView(this).apply {
      text = "写真を選択"
      textSize = 19f
      setTextColor(Color.rgb(30, 41, 38))
      gravity = Gravity.CENTER
    }
    doneButton = Button(this).apply {
      text = "完了 (0)"
      isEnabled = false
      setOnClickListener { completeSelection() }
    }
    toolbar.addView(cancel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))
    toolbar.addView(title, LinearLayout.LayoutParams(0, dp(48), 1f))
    toolbar.addView(doneButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)))

    recyclerView = RecyclerView(this).apply {
      layoutManager = GridLayoutManager(this@PhotoGridActivity, 3)
      setBackgroundColor(Color.WHITE)
      overScrollMode = View.OVER_SCROLL_NEVER
    }
    adapter = PhotoAdapter()
    recyclerView.adapter = adapter
    recyclerView.addOnItemTouchListener(SelectionTouchListener())
    root.addView(toolbar)
    root.addView(recyclerView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    setContentView(root)
  }

  private fun requestPhotoPermission() {
    ActivityCompat.requestPermissions(this, arrayOf(requiredPermission()), REQUEST_PERMISSION)
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == REQUEST_PERMISSION && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
      loadPhotos()
    } else {
      setResult(RESULT_CANCELED)
      finish()
    }
  }

  private fun requiredPermission(): String =
    if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES
    else Manifest.permission.READ_EXTERNAL_STORAGE

  private fun hasPhotoPermission() = ContextCompat.checkSelfPermission(
    this,
    requiredPermission()
  ) == PackageManager.PERMISSION_GRANTED

  private fun loadPhotos() {
    photos.clear()
    val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    contentResolver.query(
      collection,
      arrayOf(MediaStore.Images.Media._ID),
      null,
      null,
      "${MediaStore.Images.Media.DATE_ADDED} DESC"
    )?.use { cursor ->
      val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
      while (cursor.moveToNext()) {
        photos.add(Photo(ContentUris.withAppendedId(collection, cursor.getLong(idColumn))))
      }
    }
    adapter.notifyDataSetChanged()
  }

  private fun completeSelection() {
    val ids = selectedPositions.map { photos[it].uri.toString() }
    setResult(
      RESULT_OK,
      Intent().apply {
        putStringArrayListExtra(RESULT_ASSET_IDS, ArrayList(ids))
        putExtra(RESULT_COMPLETED_AT, SystemClock.elapsedRealtime())
      }
    )
    finish()
  }

  private fun toggle(position: Int) {
    if (position !in photos.indices) return
    if (selectedPositions.contains(position)) selectedPositions.remove(position)
    else if (selectedPositions.size < limit) selectedPositions.add(position)
    refreshSelection()
  }

  private fun applySelection(position: Int) {
    if (position !in photos.indices) return
    if (dragSelect) {
      if (selectedPositions.size < limit) selectedPositions.add(position)
    } else {
      selectedPositions.remove(position)
    }
  }

  private fun applyDragRange(position: Int) {
    val previous = lastDragPosition
    if (previous == null) {
      applySelection(position)
    } else {
      val range = if (previous <= position) previous..position else previous downTo position
      range.forEach(::applySelection)
    }
    lastDragPosition = position
    refreshSelection()
  }

  private fun refreshSelection() {
    doneButton.text = "完了 (${selectedPositions.size})"
    doneButton.isEnabled = selectedPositions.isNotEmpty()
    adapter.notifyItemRangeChanged(0, photos.size, SELECTION_PAYLOAD)
  }

  private fun positionAt(x: Float, y: Float): Int? {
    val child = recyclerView.findChildViewUnder(x, y) ?: return null
    return recyclerView.getChildAdapterPosition(child).takeIf { it != RecyclerView.NO_POSITION }
  }

  private val autoScrollRunnable = object : Runnable {
    override fun run() {
      if (!selecting) return
      val edge = dp(72).toFloat()
      val delta = when {
        latestY < edge -> -dp(12)
        latestY > recyclerView.height - edge -> dp(12)
        else -> 0
      }
      if (delta != 0) {
        recyclerView.scrollBy(0, delta)
        positionAt(latestX, latestY.coerceIn(1f, recyclerView.height - 1f))?.let(::applyDragRange)
      }
      recyclerView.postDelayed(this, 16)
    }
  }

  private inner class SelectionTouchListener : RecyclerView.SimpleOnItemTouchListener() {
    override fun onInterceptTouchEvent(rv: RecyclerView, event: MotionEvent): Boolean {
      handleTouch(event)
      return selecting
    }

    override fun onTouchEvent(rv: RecyclerView, event: MotionEvent) {
      handleTouch(event)
    }

    private fun handleTouch(event: MotionEvent) {
      latestX = event.x
      latestY = event.y
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.x
          downY = event.y
          firstDragPosition = positionAt(event.x, event.y)
          lastDragPosition = null
        }
        MotionEvent.ACTION_MOVE -> {
          if (!selecting && abs(event.x - downX) > touchSlop &&
            abs(event.x - downX) > abs(event.y - downY)) {
            val start = firstDragPosition ?: return
            selecting = true
            dragSelect = !selectedPositions.contains(start)
            recyclerView.parent.requestDisallowInterceptTouchEvent(true)
            applyDragRange(start)
            recyclerView.post(autoScrollRunnable)
          }
          if (selecting) positionAt(event.x, event.y)?.let(::applyDragRange)
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          if (event.actionMasked == MotionEvent.ACTION_UP && !selecting &&
            abs(event.x - downX) <= touchSlop && abs(event.y - downY) <= touchSlop) {
            positionAt(event.x, event.y)?.let(::toggle)
          }
          selecting = false
          firstDragPosition = null
          lastDragPosition = null
          recyclerView.removeCallbacks(autoScrollRunnable)
          recyclerView.parent.requestDisallowInterceptTouchEvent(false)
        }
      }
    }
  }

  private inner class PhotoAdapter : RecyclerView.Adapter<PhotoViewHolder>() {
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PhotoViewHolder {
      val side = resources.displayMetrics.widthPixels / 3
      val frame = FrameLayout(parent.context).apply {
        layoutParams = RecyclerView.LayoutParams(side, side).apply { setMargins(1, 1, 1, 1) }
      }
      val image = ImageView(parent.context).apply {
        scaleType = ImageView.ScaleType.CENTER_CROP
        setBackgroundColor(Color.rgb(225, 230, 228))
      }
      frame.addView(image, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      val badge = TextView(parent.context).apply {
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        textSize = 13f
        setBackgroundColor(Color.rgb(22, 116, 94))
        visibility = View.GONE
      }
      frame.addView(badge, FrameLayout.LayoutParams(dp(30), dp(30), Gravity.TOP or Gravity.END).apply {
        setMargins(0, dp(6), dp(6), 0)
      })
      return PhotoViewHolder(frame, image, badge)
    }

    override fun getItemCount() = photos.size

    override fun onBindViewHolder(holder: PhotoViewHolder, position: Int) {
      holder.bind(position, true)
    }

    override fun onBindViewHolder(holder: PhotoViewHolder, position: Int, payloads: MutableList<Any>) {
      holder.bind(position, payloads.isEmpty())
    }
  }

  private inner class PhotoViewHolder(
    itemView: View,
    private val imageView: ImageView,
    private val badge: TextView
  ) : RecyclerView.ViewHolder(itemView) {
    private var representedUri: Uri? = null

    fun bind(position: Int, loadImage: Boolean) {
      val selectionNumber = selectedPositions.indexOf(position).takeIf { it >= 0 }?.plus(1)
      badge.text = selectionNumber?.toString() ?: ""
      badge.visibility = if (selectionNumber == null) View.GONE else View.VISIBLE
      if (!loadImage) return
      val uri = photos[position].uri
      representedUri = uri
      imageView.setImageDrawable(null)
      thumbnailExecutor.execute {
        val bitmap = loadThumbnail(uri)
        imageView.post {
          if (representedUri == uri) imageView.setImageBitmap(bitmap)
        }
      }
    }
  }

  private fun loadThumbnail(uri: Uri): Bitmap? = try {
    if (Build.VERSION.SDK_INT >= 29) {
      contentResolver.loadThumbnail(uri, Size(360, 360), null)
    } else {
      contentResolver.openInputStream(uri)?.use(BitmapFactory::decodeStream)
    }
  } catch (_: Exception) {
    null
  }

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

  companion object {
    const val EXTRA_LIMIT = "limit"
    const val RESULT_ASSET_IDS = "assetIds"
    const val RESULT_COMPLETED_AT = "completedAt"
    private const val REQUEST_PERMISSION = 4901
    private const val SELECTION_PAYLOAD = "selection"
  }
}

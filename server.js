const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// ===== Drive認証 =====
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
  scopes: ['https://www.googleapis.com/auth/drive']
});

const drive = google.drive({ version: 'v3', auth });

// ===== 保存先フォルダID =====
const ROOT_FOLDER_ID = "1RQ6l5anCmjBmNQdOoRoX4oNAEaJDvQrq";

// ===== 画像アップロードAPI =====
app.post('/upload', async (req, res) => {
  try {
    const { staff, site, reportDate, workTypeLabel, workTime, allImages } = req.body;

    if (!allImages || allImages.length === 0) {
      return res.status(400).json({ error: "No images provided" });
    }

    // すぐに受付返す（スマホ待たせない）
    res.status(202).json({ message: "Upload started" });

    // バックグラウンド処理
    processUpload(staff, site, reportDate, workTypeLabel, workTime, allImages);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===== 実際のDrive保存処理 =====
async function processUpload(staff, site, reportDate, workTypeLabel, workTime, images) {
  try {
    console.log(`Uploading ${images.length} images...`);

    // メインフォルダ作成
    const mainFolderName = `${reportDate}_${site}_${staff}`;
    const mainFolderId = await getOrCreateFolder(mainFolderName, ROOT_FOLDER_ID);

    for (let i = 0; i < images.length; i++) {

      const img = images[i];

      const base64Data = img.data.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');

      await drive.files.create({
        requestBody: {
          name: `${img.label}_${i + 1}.jpg`,
          parents: [mainFolderId]
        },
        media: {
          mimeType: 'image/jpeg',
          body: buffer
        }
      });

      console.log(`Uploaded ${i + 1}/${images.length}`);
    }

    console.log("All uploads complete");

  } catch (error) {
    console.error("Drive Upload Error:", error.message);
  }
}

// ===== フォルダ作成 or 取得 =====
async function getOrCreateFolder(name, parentId) {

  const query = `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name: name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  return folder.data.id;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

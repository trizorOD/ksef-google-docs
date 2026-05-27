const { google } = require('googleapis');
const { Readable } = require('stream');

const FOLDER_NAME = 'KSeF Faktury';

async function getOrCreateFolder(drive) {
  const res = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return folder.data.id;
}

async function uploadPdf(auth, pdfBuffer, filename) {
  const drive = google.drive({ version: 'v3', auth });
  const folderId = await getOrCreateFolder(drive);

  // Check if file already exists in folder
  const existing = await drive.files.list({
    q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, webViewLink)',
  });
  if (existing.data.files.length > 0) {
    console.log(`Drive: file already exists, skipping upload — ${filename}`);
    return existing.data.files[0].webViewLink;
  }

  const stream = new Readable();
  stream.push(pdfBuffer);
  stream.push(null);

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: 'application/pdf',
      parents: [folderId],
    },
    media: { mimeType: 'application/pdf', body: stream },
    fields: 'id, webViewLink',
  });

  // Make file readable by anyone with the link
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return res.data.webViewLink;
}

module.exports = { uploadPdf };

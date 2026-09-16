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

// Overwrites the content of an existing file with the given name (keeps same
// file id / webViewLink), or creates it if it doesn't exist yet.
async function replacePdf(auth, pdfBuffer, filename) {
  const drive = google.drive({ version: 'v3', auth });
  const folderId = await getOrCreateFolder(drive);

  const existing = await drive.files.list({
    q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, webViewLink)',
  });

  const stream = new Readable();
  stream.push(pdfBuffer);
  stream.push(null);

  if (existing.data.files.length > 0) {
    const fileId = existing.data.files[0].id;
    const res = await drive.files.update({
      fileId,
      media: { mimeType: 'application/pdf', body: stream },
      fields: 'id, webViewLink',
    });
    console.log(`Drive: replaced content of existing file — ${filename}`);
    return res.data.webViewLink || existing.data.files[0].webViewLink;
  }

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: 'application/pdf',
      parents: [folderId],
    },
    media: { mimeType: 'application/pdf', body: stream },
    fields: 'id, webViewLink',
  });

  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  console.log(`Drive: created new file — ${filename}`);
  return res.data.webViewLink;
}

// Downloads the raw bytes of a PDF previously uploaded by uploadPdf/
// replacePdf, found by its filename in the KSeF Faktury folder. (The
// "Link to invoice" cell can't reliably be parsed back into a file ID:
// Google Sheets turns a plain Drive URL into a "smart chip" on write,
// which then displays the file's *name* through the regular Sheets API —
// the real URL only lives in chip metadata that values.get can't see.
// Looking the file up by name sidesteps that entirely.)
async function downloadPdfByFilename(auth, filename) {
  const drive = google.drive({ version: 'v3', auth });
  const folderId = await getOrCreateFolder(drive);

  const existing = await drive.files.list({
    q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
  });
  if (!existing.data.files.length) {
    throw new Error(`No file named "${filename}" found in the KSeF Faktury folder`);
  }

  const res = await drive.files.get(
    { fileId: existing.data.files[0].id, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

module.exports = { uploadPdf, replacePdf, downloadPdfByFilename };

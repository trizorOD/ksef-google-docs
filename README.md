# KSeF → Google Sheets Sync

A Node.js service that pulls invoices from the Polish e-invoicing system (KSeF) and writes them to Google Sheets, with PDFs generated from invoice XML and stored in Google Drive.

---

## What it does

1. Authenticates with KSeF using a token-based flow (RSA-OAEP encrypted token)
2. Fetches invoice metadata for a given date range — both outgoing (Subject1 / Sprzedaż) and incoming (Subject2 / Zakupy)
3. Skips invoices already present in the spreadsheet (deduplication by KSeF number)
4. For each new invoice: downloads the XML, parses it, generates a PDF, uploads it to Google Drive
5. Appends new rows to Google Sheets with invoice details + a Drive link
6. For incoming **corrective invoices** (type KOR): generates a PDF and attaches the Drive link to the `correctiveDriveLink` column of the original invoice's row — no separate row is created
7. For outgoing **corrective invoices**: skipped entirely (the `Corrective invoice` column is left for manual notes)
8. Runs on a schedule (daily at 11:00 Warsaw time) and via a web UI

---

## Architecture

```
app.js              Express server + sync orchestrator + cron schedule
ksef_client.js      KSeF API client (auth, pagination, XML download)
sheets_client.js    Google Sheets read/write
drive_client.js     Google Drive PDF upload
pdf_generator.js    Parse invoice XML → generate PDF (PDFKit)
config.js           Reads environment variables
public/index.html   Web UI (date range picker + live log)
inspect_invoice.js  Dev utility: fetch one invoice by KSeF number, print parsed JSON, save PDF
```

### Rate limiting

KSeF enforces a hard limit of 16 requests/minute across **all** endpoints (auth, metadata, XML). The client uses a global throttle (`KSEF_GAP_MS = 5000 ms`) that applies to every API call with no exceptions. On a `429` response the client reads the retry time from the error body and waits accordingly.

### Pagination

The KSeF metadata API returns up to 10 items per page regardless of the requested `size`. The client uses an async generator (`invoiceMetadataPages`) that:
- Splits the date range into ≤3-month chunks (API limit)
- Pages through each chunk with offset-based pagination
- Detects API cycling (same items returned on every page) and stops early

---

## Prerequisites

- Node.js 18+
- A KSeF API token (from [ksef.mf.gov.pl](https://ksef.mf.gov.pl))
- A Google Cloud project with the **Google Sheets API** and **Google Drive API** enabled
- OAuth 2.0 credentials (Desktop app type) downloaded as `oauth-client.json`
- A Google Spreadsheet the OAuth account has edit access to

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```env
# KSeF
KSEF_BASE_URL=https://api.ksef.mf.gov.pl/v2
KSEF_NIP=1234567890          # your company NIP (tax ID)
KSEF_TOKEN=your-ksef-token   # KSeF API token

# Google
GOOGLE_SHEET_ID=your-spreadsheet-id
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./service-account-key.json

# Sync
SYNC_START_DATE=2024-01-01T00:00:00   # default start for manual syncs

# Server
PORT=3000
```

### 3. Google OAuth authorization

Place the downloaded OAuth client JSON at `oauth-client.json` in the project root.

On first run the server will open a browser window for Google authorization and save the token to `token.json`. Subsequent runs reuse the saved token automatically.

### 4. Start the server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in a browser.

---

## Usage

### Web UI

The UI at `http://localhost:3000` lets you:
- Pick a date range (defaults to last 30 days)
- Start a sync and watch the live log
- See the last successful sync time

### API

**Start a sync**

```
POST /api/sync
Content-Type: application/json

{ "fromDate": "2025-01-01T00:00:00", "toDate": "2025-03-31T23:59:59" }
```

Returns `202` immediately. The sync runs in the background.

**Check status / read log**

```
GET /api/sync/status
```

```json
{
  "running": true,
  "log": ["[2025-01-01T...] Sync started: ...", "..."],
  "lastRun": "2025-01-01T11:00:00.000Z",
  "error": null
}
```

---

## Google Sheets output

### Sprzedaż (Subject1) — outgoing invoices

| Column | Description |
|--------|-------------|
| Invoice | Invoice number |
| Buyer | Buyer name |
| Issue date | Date issued |
| Due date | Payment due date (from XML) |
| Date of payment | Filled manually |
| Sum | Gross amount |
| Status of payment | "Paid" if `<Zaplacono>1</Zaplacono>` in XML, otherwise empty (fill manually) |
| Corrective invoice | "TAK" if invoice type is KOR; left blank for manual notes otherwise |
| Link to invoice | Google Drive PDF link |
| Numer KSeF | KSeF reference number |
| Kwota netto / brutto / VAT | Net / gross / VAT amounts |

### Zakupy (Subject2) — incoming invoices

| Column | Description |
|--------|-------------|
| No of invoice | Invoice number |
| Sum | Gross amount |
| Status of payment | "Paid" if `<Zaplacono>1</Zaplacono>` in XML, otherwise empty (fill manually) |
| Issue date | Date issued |
| Date of payment | Filled manually |
| Due date | Payment due date (from XML) |
| Seller | Seller name |
| Method of payment | Payment form (from XML) |
| Link to invoice | Google Drive PDF link |
| Link to corrective invoice | Drive link (if applicable) |
| Numer KSeF | KSeF reference number |
| NIP sprzedawcy | Seller tax ID |

---

## Filtering

Before processing, the following invoices are skipped:

- **Outgoing**: invoice numbers starting with `0` (draft/test invoices)
- **Outgoing**: corrective invoices (type KOR) — skipped entirely; the `Corrective invoice` column is for manual notes
- **Incoming**: invoices where the **seller** name contains `t-mobile`, `frisco`, `culligan`, or `ls coffee` (configurable in `app.js` — `SKIP_BUYERS` array)
- **Incoming corrective** (type KOR): not added as a new row — instead their PDF Drive link is written to the `Link to corrective invoice` column of the original row
- **Both**: invoices whose KSeF number is already present in the corresponding sheet

---

## Google Drive

PDFs are uploaded to a folder named **KSeF Faktury** in the authorized account's Drive. If the folder doesn't exist it is created automatically. Files are named `<ksefNumber>.pdf`. If a file with the same name already exists, the upload is skipped and the existing Drive link is reused.

Uploaded files are shared as "anyone with the link can view" so the link works without a Google login.

---

## Scheduled sync

A cron job runs every day at **11:00 Warsaw time** and syncs the date range from yesterday 00:00 to today 23:59. It skips execution if a manual sync is already running.

---

## PDF generation

Each invoice XML is parsed and rendered to PDF using PDFKit. The PDF matches the KSeF official invoice layout:

- Header with invoice number, type label (`Faktura podstawowa` / `Faktura korygująca`), and KSeF number
- For corrective invoices: a two-column block with correction reason, correction type, and identifying data of the corrected invoice
- Seller / Buyer side-by-side, with optional Podmiot3 (third party)
- Szczegóły: issue date, service date, issue place, currency
- Pozycje: line items table; optional extras table (GTIN / PKWiU / GTU / Indeks)
- Podsumowanie stawek podatku (VAT summary)
- Płatność: payment info, form, due date table
- Page 2 (if applicable): bank account, orders/WZ, KRS/REGON/BDO registry numbers
- Automatic page-break handling — sections never split mid-element

Fonts: Windows Arial (`C:\Windows\Fonts\arial.ttf`). Falls back to Helvetica on non-Windows systems.

---

## Known limitations

- The KSeF API returns at most 10 items per page regardless of the requested page size — this is an API constraint, not a client bug.
- For some companies the Subject2 pagination API cycles (returns the same page indefinitely with `hasMore: true`). The client detects this and stops when a full duplicate page is encountered.
- Only one sync can run at a time. A concurrent request returns `409 Conflict`.
- If an incoming corrective invoice references an original that is not yet in the sheet (e.g. it falls outside the sync date range), the corrective Drive link is logged as unattached and must be handled manually.

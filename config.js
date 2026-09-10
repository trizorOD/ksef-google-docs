require('dotenv').config();

module.exports = {
  ksef: {
    baseUrl: process.env.KSEF_BASE_URL || 'https://api.ksef.mf.gov.pl/v2',
    nip: process.env.KSEF_NIP,
    token: process.env.KSEF_TOKEN,
  },
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
  },
  sync: {
    startDate: process.env.SYNC_START_DATE || '2024-01-01T00:00:00',
  },
  port: parseInt(process.env.PORT || '3000', 10),
};

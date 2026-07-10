const xml2js = require('xml2js');
const { createSession, downloadInvoiceXml } = require('./ksef_client');
const { parseInvoice, generatePdf } = require('./pdf_generator');
const { authorize, updateOutgoingDriveLink, updateIncomingDriveLink, updateCorrectiveDriveLink } = require('./sheets_client');
const { replacePdf } = require('./drive_client');

const KSEF_NUMBERS = [
  '5213202664-20260707-4BE579000006-CA',
  '5213202664-20260702-38835B800012-90',
  '5213202664-20260701-4F5A5B800078-F3',
  '5213202664-20260630-5FC3C4000063-0E',
  '5213202664-20260622-6B30E840000F-F2',
  '5213202664-20260601-66ADE8C0010D-3F',
  '5213202664-20260505-3FFC4440003F-69',
];

(async () => {
  const client = await createSession();
  const auth = await authorize();

  for (const ksefNum of KSEF_NUMBERS) {
    console.log(`\n--- Processing ${ksefNum} ---`);
    try {
      const xml = await downloadInvoiceXml(client, ksefNum);
      const parsed = await xml2js.parseStringPromise(xml, {
        tagNameProcessors: [xml2js.processors.stripPrefix],
      });
      const data = parseInvoice(parsed);

      const pdfBuffer = await generatePdf(data, ksefNum);
      const driveLink = await replacePdf(auth, pdfBuffer, `${ksefNum}.pdf`);
      console.log(`PDF regenerated: ${driveLink}`);

      if (data.invoiceType?.toUpperCase() === 'KOR') {
        if (!data.originalKsefNumber) {
          console.log('WARNING: corrective invoice has no original KSeF reference, cannot link');
          continue;
        }
        const result = await updateCorrectiveDriveLink(auth, data.originalKsefNumber, driveLink, true);
        if (result === true) console.log(`Linked as correction of ${data.originalKsefNumber}`);
        else if (result === null) console.log(`WARNING: original invoice ${data.originalKsefNumber} not found in sheet`);
      } else {
        const updatedOut = await updateOutgoingDriveLink(auth, ksefNum, driveLink);
        const updatedIn = !updatedOut && await updateIncomingDriveLink(auth, ksefNum, driveLink);
        if (updatedOut) console.log('Updated row in "Sprzedaż (Subject1)"');
        else if (updatedIn) console.log('Updated row in "Zakupy (Subject2)"');
        else console.log('WARNING: no matching row found in either sheet');
      }
    } catch (err) {
      console.error(`FAILED for ${ksefNum}:`, err.message);
      if (err.response) console.error('HTTP', err.response.status, JSON.stringify(err.response.data));
    }
  }

  console.log('\nDone.');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

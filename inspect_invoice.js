const fs = require('fs');
const xml2js = require('xml2js');
const { createSession, downloadInvoiceXml } = require('./ksef_client');
const { parseInvoice, generatePdf } = require('./pdf_generator');

// const KSEF_NUMBER = '5242766375-20260430-769F51400006-7B';
const KSEF_NUMBER = '8792220128-20260430-32A5D1400004-BC';
//const KSEF_NUMBER = '8792220128-20260520-3ED559800006-CB'; // corrective

(async () => {
  console.log(`Fetching invoice: ${KSEF_NUMBER}\n`);
  const client = await createSession();
  const xml = await downloadInvoiceXml(client, KSEF_NUMBER);

  console.log('\n--- RAW XML ---\n');
  console.log(xml);

  const parsed = await xml2js.parseStringPromise(xml, {
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });

  const data = parseInvoice(parsed);

  console.log('\n--- PARSED INVOICE ---\n');
  console.log(JSON.stringify(data, null, 2));

  const pdfBuffer = await generatePdf(data, KSEF_NUMBER);
  const outPath = `${KSEF_NUMBER}.pdf`;
  fs.writeFileSync(outPath, pdfBuffer);
  console.log(`\nPDF saved: ${outPath}`);
})().catch(err => {
  console.error('Error:', err.message);
  if (err.response) console.error('HTTP', err.response.status, JSON.stringify(err.response.data));
  process.exit(1);
});

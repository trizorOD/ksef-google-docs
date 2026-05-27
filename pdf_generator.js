const PDFDocument = require('pdfkit');

const FONT_REGULAR = 'C:\\Windows\\Fonts\\arial.ttf';
const FONT_BOLD = 'C:\\Windows\\Fonts\\arialbd.ttf';

const PAYMENT_FORMS = {
  '1': 'Gotówka', '2': 'Karta', '3': 'Bon', '4': 'Czek',
  '5': 'Akredytywa', '6': 'Przelew', '7': 'Płatność mobilna',
};

const VAT_RATES = {
  '1': '23% lub 22%', '2': '8%', '3': '5%', '4': '0%', '5': 'zw.',
  '6': 'OO', '7': 'NP', '8': '22%', '9': '7%',
  '10': '3%', '11': '2%', '12': '0%', '13': 'zw/0%',
};

const CORRECTION_TYPE = {
  '1': 'Korekta skutkująca w dacie wystawienia faktury korygującej',
  '01': 'Korekta skutkująca w dacie wystawienia faktury korygującej',
  '2': 'Korekta skutkująca w dacie pierwotnej',
  '02': 'Korekta skutkująca w dacie pierwotnej',
  '3': 'Korekta skutkująca w dacie obu zdarzeń',
  '03': 'Korekta skutkująca w dacie obu zdarzeń',
};

const ROLA = {
  '1': 'Faktorant',
  '2': 'Odbiorca - w przypadku, gdy na fakturze występują dane jednostek wewnętrznych, oddziałów, wyodrębnionych w ramach nabywcy, które same nie stanowią nabywcy w rozumieniu ustawy',
  '3': 'Podmiot trzeci',
  '4': 'Dodatkowy nabywca',
  '5': 'Wystawca',
};

function g(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined) obj = obj[k];
    else return '';
  }
  return Array.isArray(obj) ? obj[0] : (obj ?? '');
}

function parseInvoice(parsed) {
  const F = parsed.Faktura;
  const seller = F.Podmiot1?.[0];
  const buyer = F.Podmiot2?.[0];
  const p3raw = F.Podmiot3?.[0];
  const fa = F.Fa?.[0];
  const payment = fa?.Platnosc?.[0];
  const stopka = F.Stopka?.[0];

  const lines = [].concat(fa?.FaWiersz || []);
  const dueDates = [].concat(payment?.TerminPlatnosci || []);
  const dueDate = g(dueDates[0], 'Termin');
  const payForm = PAYMENT_FORMS[g(payment, 'FormaPlatnosci')] || '';
  const bankAcc = g(payment?.RachunekBankowy?.[0], 'NrRB');
  const swift = g(payment?.RachunekBankowy?.[0], 'SWIFT');
  const bankName = g(payment?.RachunekBankowy?.[0], 'NazwaBanku');
  const isPaid = g(payment, 'Zaplacono') === '1';
  const paymentDate = g(payment, 'DataZaplaty') || '';

  const vatRows = [];
  for (const rate of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']) {
    const net = g(fa, `P_13_${rate}`);
    const vat = g(fa, `P_14_${rate}`);
    if (net !== '') {
      const netN = parseFloat(net) || 0;
      const vatN = parseFloat(vat) || 0;
      vatRows.push({ rateLabel: VAT_RATES[rate] || `${rate}%`, net, vat, gross: (netN + vatN).toFixed(2) });
    }
  }

  const wz = g(fa, 'WZ');
  const orders = [].concat(fa?.WarunkiTransakcji?.[0]?.Zamowienia || []).map(z => ({
    date: g(z, 'DataZamowienia'),
    number: g(z, 'NrZamowienia'),
  })).filter(o => o.number);

  const podmiot3 = p3raw ? {
    brakId: g(p3raw, 'DaneIdentyfikacyjne', 0, 'BrakID') === '1',
    name: g(p3raw, 'DaneIdentyfikacyjne', 0, 'Nazwa'),
    addr1: g(p3raw, 'Adres', 0, 'AdresL1'),
    addr2: g(p3raw, 'Adres', 0, 'AdresL2'),
    nrKlienta: g(p3raw, 'NrKlienta'),
    rola: ROLA[g(p3raw, 'Rola')] || '',
  } : null;

  return {
    invoiceType: g(fa, 'RodzajFaktury') || 'VAT',
    originalKsefNumber: g(fa, 'DaneFaKorygowanej', 0, 'NrKSeFFaKorygowanej') || '',
    originalIssueDate: g(fa, 'DaneFaKorygowanej', 0, 'DataWystFaKorygowanej') || '',
    originalInvoiceNumber: g(fa, 'DaneFaKorygowanej', 0, 'NrFaKorygowanej') || '',
    correctionReason: g(fa, 'PrzyczynaKorekty') || '',
    correctionType: CORRECTION_TYPE[g(fa, 'TypKorekty')] || '',
    invoiceNumber: g(fa, 'P_2'),
    issueDate: g(fa, 'P_1'),
    issuePlace: g(fa, 'P_1M'),
    serviceDate: g(fa, 'P_6'),
    dueDate,
    isPaid, paymentDate,
    currency: g(fa, 'KodWaluty') || 'PLN',
    grossTotal: g(fa, 'P_15'),
    payForm, bankAcc, swift, bankName,
    seller: {
      eori: g(seller, 'NrEORI'),
      nip: g(seller?.DaneIdentyfikacyjne?.[0], 'NIP'),
      name: g(seller?.DaneIdentyfikacyjne?.[0], 'Nazwa'),
      addr1: g(seller?.Adres?.[0], 'AdresL1'),
      addr2: g(seller?.Adres?.[0], 'AdresL2'),
      gln: g(seller?.Adres?.[0], 'GLN'),
      phone: g(seller?.DaneKontaktowe?.[0], 'Telefon'),
    },
    buyer: {
      nip: g(buyer?.DaneIdentyfikacyjne?.[0], 'NIP'),
      name: g(buyer?.DaneIdentyfikacyjne?.[0], 'Nazwa'),
      addr1: g(buyer?.Adres?.[0], 'AdresL1'),
      addr2: g(buyer?.Adres?.[0], 'AdresL2'),
      nrKlienta: g(buyer, 'NrKlienta'),
      jst: g(buyer, 'JST'),
      gv: g(buyer, 'GV'),
    },
    podmiot3,
    lines: lines.map(l => ({
      name: g(l, 'P_7'),
      unit: g(l, 'P_8A'),
      qty: g(l, 'P_8B'),
      price: g(l, 'P_9A'),
      net: g(l, 'P_11'),
      vatAmt: g(l, 'P_11Vat'),
      vat: g(l, 'P_12'),
      gtin: g(l, 'GTIN'),
      pkwiu: g(l, 'PKWiU'),
      gtu: g(l, 'GTU'),
      indeks: g(l, 'Indeks'),
    })),
    vatRows,
    wz, orders,
    krs: g(stopka, 'Rejestry', 0, 'KRS'),
    regon: g(stopka, 'Rejestry', 0, 'REGON'),
    bdo: g(stopka, 'Rejestry', 0, 'BDO'),
  };
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '' : n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CLR_RED = '#e8000d';
const CLR_ORANGE = '#c45900';
const CLR_BLUE = '#0563c1';
const CLR_GRAY = '#383838';
const CLR_LINE = '#cccccc';
const CLR_THEAD = '#dce6f1';

function generatePdf(inv, ksefNumber) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      autoFirstPage: true,
      info: { Title: inv.invoiceNumber },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.registerFont('R', FONT_REGULAR);
      doc.registerFont('B', FONT_BOLD);
    } catch {
      doc.registerFont('R', 'Helvetica');
      doc.registerFont('B', 'Helvetica-Bold');
    }

    const L = 50;
    const W = 495;
    const RH = 18;
    const HH = 20;
    let y = 50;

    const R = (sz) => doc.font('R').fontSize(sz - 1);
    const B = (sz) => doc.font('B').fontSize(sz - 1);
    const hr = () => {
      doc.moveTo(L, y).lineTo(L + W, y).strokeColor(CLR_LINE).lineWidth(0.5).stroke();
      y += 14;
    };
    let addedPages = 0;
    const checkPage = (needed = 80) => {
      if (y + needed > 790) { doc.addPage(); y = 50; addedPages++; }
    };

    // ── HEADER ───────────────────────────────────────────────────────────
    B(16).fillColor('black').text('Krajowy System ', L, y, { continued: true });
    doc.fillColor(CLR_RED).text('e', { continued: true });
    doc.fillColor('black').text('-Faktur', { lineBreak: false });
    doc.y = y;

    const invoiceLabel = inv.invoiceType?.toUpperCase() === 'KOR' ? 'Faktura korygująca' : 'Faktura podstawowa';
    R(8).fillColor(CLR_ORANGE).text('Numer Faktury:', L, y, { width: W, align: 'right' });
    B(18).fillColor('black').text(inv.invoiceNumber || '', L, y + 12, { width: W, align: 'right' });
    R(8).fillColor(CLR_ORANGE).text(invoiceLabel, L, y + 34, { width: W, align: 'right' });
    if (ksefNumber) {
      R(7).fillColor(CLR_GRAY).text(`Numer KSEF: ${ksefNumber}`, L, y + 47, { width: W, align: 'right' });
    }

    y += 68;
    hr();

    // ── DANE FAKTURY KORYGOWANEJ (only for corrective invoices) ───────────
    if (inv.invoiceType?.toUpperCase() === 'KOR') {
      const cW = Math.floor((W - 24) / 2);
      let clY = y;
      let crY = y;

      // Left column
      B(11).fillColor('black').text('Dane faktury korygowanej', L, clY, { width: cW }); clY += 18;
      if (inv.correctionReason) {
        const t = `Przyczyna korekty dla faktur korygujących: ${inv.correctionReason}`;
        R(8).fillColor(CLR_GRAY).text(t, L, clY, { width: cW });
        clY += R(8).heightOfString(t, { width: cW }) + 4;
      }
      if (inv.correctionType) {
        const t = `Typ skutku korekty: ${inv.correctionType}`;
        R(8).fillColor(CLR_GRAY).text(t, L, clY, { width: cW });
        clY += R(8).heightOfString(t, { width: cW }) + 4;
      }

      // Right column
      B(11).fillColor('black').text('Dane identyfikacyjne faktury korygowanej', L + cW + 24, crY, { width: cW }); crY += 18;
      if (inv.originalIssueDate) {
        const t = `Data wystawienia faktury, której dotyczy faktura korygująca: ${inv.originalIssueDate}`;
        R(8).fillColor(CLR_GRAY).text(t, L + cW + 24, crY, { width: cW });
        crY += R(8).heightOfString(t, { width: cW }) + 4;
      }
      if (inv.originalInvoiceNumber) {
        R(8).fillColor(CLR_GRAY).text(`Numer faktury korygowanej: ${inv.originalInvoiceNumber}`, L + cW + 24, crY, { width: cW });
        crY += 13;
      }
      if (inv.originalKsefNumber) {
        R(8).fillColor(CLR_GRAY).text(`Numer KSeF faktury korygowanej: ${inv.originalKsefNumber}`, L + cW + 24, crY, { width: cW });
        crY += 13;
      }

      y = Math.max(clY, crY) + 8;
      hr();
    }

    // ── PARTIES ──────────────────────────────────────────────────────────
    const pW = Math.floor((W - 24) / 2);

    const drawParty = (label, party, px, startY) => {
      let py = startY;
      B(11).fillColor('black').text(label, px, py, { width: pW }); py += 18;
      if (party.eori) {
        R(8).fillColor(CLR_GRAY).text(`Numer EORI: ${party.eori}`, px, py, { width: pW }); py += 13;
      }
      R(8).fillColor(CLR_GRAY).text(`NIP: ${party.nip}`, px, py, { width: pW }); py += 13;
      R(8).fillColor(CLR_GRAY).text(`Nazwa: ${party.name}`, px, py, { width: pW }); py += 18;
      R(8).fillColor(CLR_GRAY).text('Adres', px, py, { width: pW }); py += 13;
      if (party.addr1) { R(8).fillColor(CLR_GRAY).text(party.addr1, px, py, { width: pW }); py += 13; }
      if (party.addr2) { R(8).fillColor(CLR_GRAY).text(party.addr2, px, py, { width: pW }); py += 13; }
      R(8).fillColor(CLR_GRAY).text('Polska', px, py, { width: pW }); py += 13;
      if (party.gln) {
        R(8).fillColor(CLR_GRAY).text(`GLN: ${party.gln}`, px, py, { width: pW }); py += 13;
      }
      if (party.phone || party.nrKlienta || party.jst || party.gv) {
        R(8).fillColor(CLR_GRAY).text('Dane kontaktowe', px, py, { width: pW }); py += 13;
        if (party.phone) {
          R(8).fillColor(CLR_GRAY).text(`Tel.: ${party.phone}`, px, py, { width: pW }); py += 13;
        }
        if (party.nrKlienta) {
          R(8).fillColor(CLR_GRAY).text(`Numer klienta: ${party.nrKlienta}`, px, py, { width: pW }); py += 13;
        }
        if (party.jst) {
          R(8).fillColor(CLR_GRAY).text(
            `Faktura dotyczy jednostki podrzędnej JST: ${party.jst === '1' ? 'TAK' : 'NIE'}`,
            px, py, { width: pW }
          ); py += 13;
        }
        if (party.gv) {
          R(8).fillColor(CLR_GRAY).text(
            `Faktura dotyczy członka grupy GV: ${party.gv === '1' ? 'TAK' : 'NIE'}`,
            px, py, { width: pW }
          ); py += 13;
        }
      }
      return py;
    };

    const endSeller = drawParty('Sprzedawca', inv.seller, L, y);
    const endBuyer = drawParty('Nabywca', inv.buyer, L + pW + 24, y);
    y = Math.max(endSeller, endBuyer) + 12;

    // ── PODMIOT 3 ─────────────────────────────────────────────────────────
    if (inv.podmiot3) {
      const p3 = inv.podmiot3;
      const p3StartY = y;
      let p3lY = p3StartY;
      let p3rY = p3StartY;

      // Left column
      B(11).fillColor('black').text('Podmiot inny 1', L, p3lY, { width: pW }); p3lY += 18;
      if (p3.brakId) {
        R(8).fillColor(CLR_GRAY).text('Brak identyfikatora', L, p3lY, { width: pW }); p3lY += 13;
      }
      if (p3.name) {
        R(8).fillColor(CLR_GRAY).text(`Nazwa: ${p3.name}`, L, p3lY, { width: pW }); p3lY += 13;
      }
      if (p3.rola) {
        const rolaText = `Rola: ${p3.rola}`;
        R(8).fillColor(CLR_GRAY).text(rolaText, L, p3lY, { width: pW });
        p3lY += R(8).heightOfString(rolaText, { width: pW }) + 4;
      }

      // Right column
      R(8).fillColor(CLR_GRAY).text('Adres', L + pW + 24, p3rY, { width: pW }); p3rY += 13;
      if (p3.addr1) { R(8).fillColor(CLR_GRAY).text(p3.addr1, L + pW + 24, p3rY, { width: pW }); p3rY += 13; }
      if (p3.addr2) { R(8).fillColor(CLR_GRAY).text(p3.addr2, L + pW + 24, p3rY, { width: pW }); p3rY += 13; }
      R(8).fillColor(CLR_GRAY).text('Polska', L + pW + 24, p3rY, { width: pW }); p3rY += 16;
      if (p3.nrKlienta) {
        R(8).fillColor(CLR_GRAY).text('Dane kontaktowe', L + pW + 24, p3rY, { width: pW }); p3rY += 13;
        R(8).fillColor(CLR_GRAY).text(`Numer klienta: ${p3.nrKlienta}`, L + pW + 24, p3rY, { width: pW }); p3rY += 13;
      }

      y = Math.max(p3lY, p3rY) + 6;
    }

    hr();

    // ── SZCZEGÓŁY ─────────────────────────────────────────────────────────
    B(11).fillColor('black').text('Szczegóły', L, y); y += 18;

    const hW = Math.floor(W / 2) - 12;
    const detailY = y;

    const textH = (text) => R(8).heightOfString(text, { width: hW }) + 4;

    const t1 = `Data wystawienia, z zastrzeżeniem art. 106na ust. 1 ustawy: ${inv.issueDate}`;
    R(8).fillColor(CLR_GRAY).text(t1, L, detailY, { width: hW });
    let lY = detailY + textH(t1);
    if (inv.serviceDate) {
      const t2 = `Data dokonania lub zakończenia dostawy towarów lub wykonania usługi: ${inv.serviceDate}`;
      R(8).fillColor(CLR_GRAY).text(t2, L, lY, { width: hW });
      lY += textH(t2);
    }

    let rY = detailY;
    if (inv.issuePlace) {
      const t3 = `Miejsce wystawienia: ${inv.issuePlace}`;
      R(8).fillColor(CLR_GRAY).text(t3, L + hW + 24, rY, { width: hW });
      rY += textH(t3);
    }
    R(8).fillColor(CLR_GRAY).text(`Kod waluty: ${inv.currency}`, L + hW + 24, rY, { width: hW });

    y = Math.max(lY, rY + 14) + 12;
    hr();

    // ── POZYCJE ───────────────────────────────────────────────────────────
    B(11).fillColor('black').text('Pozycje', L, y); y += 14;
    R(8).fillColor(CLR_GRAY).text(`Faktura wystawiona w walucie ${inv.currency}`, L, y); y += 16;

    // Column widths sum = 495
    const IC = [
      { label: 'Lp.', w: 24, align: 'center' },
      { label: 'Nazwa towaru lub usługi', w: 158, align: 'left' },
      { label: 'Cena jedn. netto', w: 68, align: 'right' },
      { label: 'Ilość', w: 38, align: 'right' },
      { label: 'Miara', w: 30, align: 'center' },
      { label: 'Wartość sprzedaży netto', w: 89, align: 'right' },
      { label: 'Wartość sprzedaży vat', w: 88, align: 'right' },
    ];
    const IC_HH = 28; // taller header to accommodate 2-line labels

    const drawIRow = (cells, rowY, isHdr) => {
      const h = isHdr ? IC_HH : RH;
      doc.rect(L, rowY, W, h).fillAndStroke(isHdr ? CLR_THEAD : 'white', CLR_LINE);
      let x = L;
      cells.forEach((cell, i) => {
        const c = IC[i];
        const fs = isHdr ? 5 : 6;
        doc.font(isHdr ? 'B' : 'R').fontSize(fs).fillColor('black')
          .text(String(cell ?? ''), x + 3, rowY + (isHdr ? 3 : Math.floor((h - fs) / 2)), {
            width: c.w - 6, align: c.align, lineBreak: isHdr,
          });
        x += c.w;
      });
      return rowY + h;
    };

    y = drawIRow(IC.map(c => c.label), y, true);
    inv.lines.forEach((l, i) => {
      y = drawIRow([i + 1, l.name, num(l.price), l.qty, l.unit, num(l.net), num(l.vatAmt)], y, false);
    });

    // ── EXTRAS TABLE (GTIN / PKWiU / GTU / Indeks) ───────────────────────
    const hasExtras = inv.lines.some(l => l.gtin || l.pkwiu || l.gtu || l.indeks);
    if (hasExtras) {
      // Column widths sum = 495
      const EC = [
        { label: 'Lp.', w: 24, align: 'center' },
        { label: 'GTIN', w: 140, align: 'left' },
        { label: 'PKWiU', w: 100, align: 'left' },
        { label: 'GTU', w: 78, align: 'center' },
        { label: 'Indeks', w: 153, align: 'left' },
      ];

      const drawERow = (cells, rowY, isHdr) => {
        const h = isHdr ? HH : RH;
        doc.rect(L, rowY, W, h).fillAndStroke(isHdr ? CLR_THEAD : 'white', CLR_LINE);
        let x = L;
        cells.forEach((cell, i) => {
          const c = EC[i];
          const fs = isHdr ? 5 : 6;
          doc.font(isHdr ? 'B' : 'R').fontSize(fs).fillColor('black')
            .text(String(cell ?? ''), x + 3, rowY + Math.floor((h - fs) / 2), {
              width: c.w - 6, align: c.align, lineBreak: false,
            });
          x += c.w;
        });
        return rowY + h;
      };

      y = drawERow(EC.map(c => c.label), y, true);
      inv.lines.forEach((l, i) => {
        y = drawERow([i + 1, l.gtin, l.pkwiu, l.gtu, l.indeks], y, false);
      });
    }

    y += 10;
    B(9).fillColor('black').text(`Kwota należności ogółem: ${num(inv.grossTotal)} ${inv.currency}`, L, y, { width: W, align: 'right' });
    y += 22;

    // ── VAT SUMMARY ───────────────────────────────────────────────────────
    checkPage(60 + inv.vatRows.length * RH);
    B(11).fillColor('black').text('Podsumowanie stawek podatku', L, y); y += 18;

    // Column widths sum = 495
    const VC = [
      { label: 'Lp.', w: 32, align: 'center' },
      { label: 'Stawka podatku', w: 100, align: 'center' },
      { label: 'Kwota netto', w: 118, align: 'right' },
      { label: 'Kwota podatku', w: 120, align: 'right' },
      { label: 'Kwota brutto', w: 125, align: 'right' },
    ];

    const drawVRow = (cells, rowY, isHdr) => {
      const h = isHdr ? HH : RH;
      doc.rect(L, rowY, W, h).fillAndStroke(isHdr ? CLR_THEAD : 'white', CLR_LINE);
      let x = L;
      cells.forEach((cell, i) => {
        const c = VC[i];
        doc.font(isHdr ? 'B' : 'R').fontSize(6).fillColor('black')
          .text(String(cell ?? ''), x + 3, rowY + Math.floor((h - 8) / 2), {
            width: c.w - 6, align: c.align, lineBreak: false,
          });
        x += c.w;
      });
      return rowY + h;
    };

    y = drawVRow(VC.map(c => c.label), y, true);
    inv.vatRows.forEach((r, i) => {
      y = drawVRow([i + 1, r.rateLabel, num(r.net), num(r.vat), num(r.gross)], y, false);
    });
    y += 18;

    // ── PŁATNOŚĆ ──────────────────────────────────────────────────────────
    checkPage(120);
    B(11).fillColor('black').text('Płatność', L, y); y += 18;
    R(8).fillColor(CLR_GRAY).text('Informacja o płatności: Brak zapłaty', L, y); y += 13;
    if (inv.payForm) {
      R(8).fillColor(CLR_GRAY).text(`Forma płatności: ${inv.payForm}`, L, y); y += 13;
    }
    if (inv.dueDate) {
      y += 4;
      const dtW = 220;
      doc.rect(L, y, dtW, HH).fillAndStroke(CLR_THEAD, CLR_LINE);
      B(8).fillColor('black').text('Termin płatności', L + 3, y + 6, { width: dtW - 6, lineBreak: false });
      y += HH;
      doc.rect(L, y, dtW, RH).fillAndStroke('white', CLR_LINE);
      R(8).fillColor('black').text(inv.dueDate, L + 3, y + 5, { width: dtW - 6, lineBreak: false });
      y += RH;
    }

    const hasPage2 = !!(inv.bankAcc || inv.orders?.length || inv.wz || inv.krs);
    const totalPages = 1 + addedPages + (hasPage2 && addedPages === 0 ? 1 : 0);
    const curPage = 1 + addedPages;
    const continuesHere = hasPage2 && addedPages > 0;
    if (!continuesHere) {
      R(8).fillColor(CLR_GRAY).text(`${curPage} z ${totalPages}`, L, Math.min(y + 12, 810), { width: W, align: 'right' });
    }

    // ── PAGE 2 ────────────────────────────────────────────────────────────
    if (hasPage2) {
      if (addedPages === 0) { doc.addPage(); y = 50; }
      else { y += 24; }

      if (inv.bankAcc) {
        B(11).fillColor('black').text('Numer rachunku bankowego', L, y); y += 18;

        const BLW = 180, BRW = 200;
        const bankRows = [
          ['Pełny numer rachunku', inv.bankAcc],
          ['Kod SWIFT', inv.swift || ''],
          ['Rachunek własny banku', ''],
          ['Nazwa banku', inv.bankName || ''],
          ['Opis rachunku', ''],
        ];
        bankRows.forEach(row => {
          doc.rect(L, y, BLW, RH).fillAndStroke(CLR_THEAD, CLR_LINE);
          R(8).fillColor('black').text(row[0], L + 3, y + 5, { width: BLW - 6, lineBreak: false });
          doc.rect(L + BLW, y, BRW, RH).fillAndStroke('white', CLR_LINE);
          R(8).fillColor('black').text(row[1], L + BLW + 3, y + 5, { width: BRW - 6, lineBreak: false });
          y += RH;
        });
        y += 16;
      }

      if (inv.orders?.length > 0 || inv.wz) {
        B(11).fillColor('black').text('Warunki transakcji', L, y); y += 18;

        if (inv.orders?.length > 0) {
          R(9).fillColor(CLR_GRAY).text('Zamówienie', L, y); y += 14;
          const OW1 = 130, OW2 = 200;
          doc.rect(L, y, OW1, HH).fillAndStroke(CLR_THEAD, CLR_LINE);
          B(8).fillColor('black').text('Data zamówienia', L + 3, y + 6, { width: OW1 - 6, lineBreak: false });
          doc.rect(L + OW1, y, OW2, HH).fillAndStroke(CLR_THEAD, CLR_LINE);
          B(8).fillColor('black').text('Numer zamówienia', L + OW1 + 3, y + 6, { width: OW2 - 6, lineBreak: false });
          y += HH;
          for (const order of inv.orders) {
            doc.rect(L, y, OW1, RH).fillAndStroke('white', CLR_LINE);
            R(8).fillColor('black').text(order.date, L + 3, y + 5, { width: OW1 - 6, lineBreak: false });
            doc.rect(L + OW1, y, OW2, RH).fillAndStroke('white', CLR_LINE);
            R(8).fillColor('black').text(order.number, L + OW1 + 3, y + 5, { width: OW2 - 6, lineBreak: false });
            y += RH;
          }
          y += 12;
        }

        if (inv.wz) {
          R(9).fillColor(CLR_GRAY).text('Numery dokumentów magazynowych WZ', L, y); y += 14;
          const WZW = 200;
          doc.rect(L, y, WZW, HH).fillAndStroke(CLR_THEAD, CLR_LINE);
          B(8).fillColor('black').text('Numer WZ', L + 3, y + 6, { width: WZW - 6, lineBreak: false });
          y += HH;
          doc.rect(L, y, WZW, RH).fillAndStroke('white', CLR_LINE);
          R(8).fillColor('black').text(inv.wz, L + 3, y + 5, { width: WZW - 6, lineBreak: false });
          y += RH;
          y += 12;
        }
      }

      if (inv.krs || inv.regon || inv.bdo) {
        const RCW = [120, 120, 120];
        let x = L;
        ['KRS', 'REGON', 'BDO'].forEach((label, i) => {
          doc.rect(x, y, RCW[i], HH).fillAndStroke(CLR_THEAD, CLR_LINE);
          B(8).fillColor('black').text(label, x + 3, y + 6, { width: RCW[i] - 6, lineBreak: false });
          x += RCW[i];
        });
        y += HH;
        x = L;
        [inv.krs, inv.regon, inv.bdo].forEach((val, i) => {
          doc.rect(x, y, RCW[i], RH).fillAndStroke('white', CLR_LINE);
          R(8).fillColor('black').text(val || '', x + 3, y + 5, { width: RCW[i] - 6, lineBreak: false });
          x += RCW[i];
        });
        y += RH + 16;
      }

      R(8).fillColor(CLR_GRAY).text(`${totalPages} z ${totalPages}`, L, y, { width: W, align: 'right' });
    }

    doc.end();
  });
}

module.exports = { parseInvoice, generatePdf };

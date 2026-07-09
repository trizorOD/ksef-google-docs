# PDF: добавление недостающих полей КСеФ (2026-07-09)

## Контекст

Сверка `pdf_generator.js` с реальным XML фактуры и с официальным PDF, сгенерированным КСеФ
(`5213202664-20260505-3FFC4440003F-69.pdf`), показала, что часть полей схемы FA(3),
присутствующих в XML, не извлекается и не отображается в нашем PDF, хотя официальный генератор
их показывает. Задача — добить эти поля, ориентируясь на вёрстку/формулировки оригинала.

## Поля, которые добавляем

1. **`Fa.Rozliczenie`** — обременения/итог к оплате (`Obciazenia[].Kwota/Powod`, `SumaObciazen`, `DoZaplaty`).
   Официальный PDF: секция «Rozliczenie» → подзаголовок «Obciążenia» → таблица
   «Powód obciążenia» / «Kwota» → строка «Suma kwot obciążenia: X» → жирная строка
   «Do zapłaty: Y PLN».
2. **`Fa.OkresFa` (P_6_Od/P_6_Do)** — период оказания услуги, используется как fallback для
   `serviceDate`, когда `P_6` отсутствует. Формат как в оригинале: `od {P_6_Od} do {P_6_Do}`.
3. **`FaWiersz.P_10` (Rabat)** — новая колонка в таблице «Pozycje».
4. **`FaWiersz.P_12` (Stawka podatku)** — уже извлекается (`l.vat`), но не отображается по строкам;
   добавляем колонку «Stawka podatku» в «Pozycje» (маппинг через существующий `VAT_RATES`).
5. **`FaWiersz.UU_ID`** — новая колонка в таблице «Pozycje».
6. **`Podmiot1/2.AdresKoresp`** — «Adres do korespondencji», отдельный блок после «Adres»
   у продавца и у покупателя (показываем, если присутствует в XML, даже если совпадает с `Adres`).
7. **`Podmiot1.PrefiksPodatnika`** — «Prefiks VAT: PL», строка перед NIP у продавца.

## Изменения в `parseInvoice`

- `rozliczenie`: `{ charges: [{amount, reason}], sumCharges, amountDue } | null`.
- `serviceDate`: `P_6` → fallback на `OkresFa` (`od {Od} do {Do}`), пусто если ничего нет.
- `seller.vatPrefix`, `seller.corrAddr1/2`.
- `buyer.corrAddr1/2`.
- `lines[i].discount` (`P_10`), `lines[i].uuId` (`UU_ID`); `lines[i].vat` уже есть, при рендере
  маппим через `VAT_RATES`.

Все новые поля опциональны — при отсутствии в XML ничего не ломается и не рендерится
(та же схема, что и для текущих опциональных блоков типа `podmiot3`, `wz`, `orders`).

## Изменения в `generatePdf`

- **`drawParty`**: перед NIP — необязательная строка `Prefiks VAT: {vatPrefix}`;
  после блока «Adres» — необязательный блок «Adres do korespondencji» (тот же формат,
  что и «Adres»: заголовок + 1-2 строки адреса + «Polska»).
- **Таблица «Pozycje»**: расширяем с 7 до 10 колонок, порядок как в оригинале:
  `Lp. | Nazwa towaru lub usługi | Cena jedn. netto | Ilość | Miara | Rabat | Stawka podatku |
  Wartość sprzedaży netto | Wartość sprzedaży vat | UU_ID`.
  Ширины (сумма 495): `18, 120, 55, 28, 24, 28, 40, 62, 62, 58`.
- **После таблицы «Podsumowanie stawek podatku»**: если `inv.rozliczenie` не пуст —
  секция «Rozliczenie» (`checkPage()` перед отрисовкой, чтобы корректно перейти на новую
  страницу при нехватке места, как и у остальных секций документа):
  - подзаголовок «Obciążenia» (стиль как у «Zamówienie»);
  - таблица `Powód obciążenia` (широкая, left) / `Kwota` (узкая, right) — по строке на `charges[i]`;
  - строка `Suma kwot obciążenia: {sumCharges}`;
  - жирная строка `Do zapłaty: {amountDue} PLN` (стиль как у «Kwota należności ogółem»).
  Существующая строка «Kwota należności ogółem» (`P_15`) не удаляется — это отдельное
  число по закону (сумма по позициям без обременений).

## Проверка

После реализации сгенерировать PDF из тестового XML (тот, что прислал пользователь) через
`parseInvoice`+`generatePdf`, прочитать результат и визуально сверить с оригинальным
`5213202664-20260505-3FFC4440003F-69.pdf` (расположение блоков, формулировки, суммы).

## Вне рамок

- Переформатирование дат в `DD.MM.YYYY` по всему документу (оригинал так делает, наш код
  выводит как есть в XML) — отдельная задача, не трогаем сейчас.
- `PrefiksPodatnika`/аналог для покупателя — в реальном XML не встретился, добавим только
  если понадобится.

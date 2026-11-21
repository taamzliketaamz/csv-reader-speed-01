# csv-reader-speed-01 — a fast reader for broken CSV

An entry for make.fun's **csv-reader-speed-01**: read broken CSV files faster, with
answers identical to csv-reader 1.0.0.

`solve.js` is a dependency-free ES module exporting `run(input)`, which returns
`{columns, rows, errors}` for an input `{text, header}` — exactly csv-reader 1.0.0's
answer, under its written broken-row policy:

- a U+FEFF at the very start of the text is dropped;
- a record ends at LF or CRLF, and a line left with no characters is no record;
- a CR outside quotes that is not part of a CRLF is dropped (`stray_cr`);
- a field that opens with a quote runs to the next quote that is not doubled (`""`
  inside it is one quote), each CRLF or lone CR inside it is read as LF, and what
  follows its closing quote, up to the next comma or line break, is appended as it
  stands (`quote_junk` when anything was appended);
- a quote that never closes is a literal character and the text after it is read
  again as an unquoted field (`unterminated_quote`);
- a quote inside an unquoted field is a literal character; fields stay strings,
  never trimmed or converted;
- `columns` is the first record when `header` is true, else `null`; every other
  record is padded with `""` (`short_row`) or cut (`long_row`) to the first
  record's width;
- each error is `{code, line, row}` — the 1-based line its record starts on and
  its record's index in `rows` (`null` for the header) — in the order met.

`main.ts` is the house driver, kept as shipped: it reads `/input/cases.json`,
answers each case with `run()`, and writes `/output/answers.json`.

## How it is fast

The reader is one single pass over the text, built around the observation that the
corpus is dominated by bare fields and that breakage is rare (a few errors per ten
thousand records):

- **One tight record loop.** A record is walked character by character exactly
  once. A quote at a field's start is dispatched before the bare scan begins, so
  the scan's common path is three tests (comma / LF / CR); a comma or a line break
  cuts the bare field before it out of the text with a single `slice` — no
  per-character string building, no regex, no `split`, no closure or result
  object per field.
- **Quoted fields jump.** A plain quoted field is read inline in the record loop:
  one `indexOf` jump to its closing quote, then the span is cut out with a single
  `slice` and examined on the slice itself — the probe for a CR and the counting
  of its line breaks (by `indexOf` hops) never run past the closing quote into
  the rest of the text. (Probing the whole text for a CR sounds free and is not:
  in a text whose CRs are sparse, the search runs on for thousands of characters
  past the quote, on every quoted field.)
- **Rare breakage, exact slow paths.** A `""` escape or a CR inside quotes goes to
  a reader that still walks quote to quote — each span between quotes is sliced
  once and accounted on the slice the same way, and only a span holding a CR is
  converted (one `replace`); junk after a closing quote and unterminated quotes
  are re-read by a small unquoted reader; a record containing a stray CR is
  rewound and re-read field by field through the exact readers. The fast loop
  never has to know.
- **Errors are built only when met**, and the line count is maintained
  incrementally — it is only ever read at a record's start, which is the only
  place an error's `line` comes from.

Correctness is guarded by differential testing against the reference reader on
freshly generated sets (the competition's own generator and oracle): the answers
must match on every case, and locally they do — practice set 6/6 and every
generated set drawn during development, zero differences.

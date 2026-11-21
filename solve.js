// csv-reader-speed-01 — a fast single-pass reader for make.fun's broken-CSV policy.
//
// run(input) returns exactly csv-reader 1.0.0's answer for every input: {columns, rows, errors}
// under the same written policy (BOM dropped; records end at LF/CRLF; empty lines are no
// records; stray CRs dropped with an error; quoted fields with "" escapes, CR/CRLF inside
// read as LF, junk after the closing quote appended as it stands; a quote that never closes
// is literal and its text is re-read unquoted; rows padded/cut to the first record's width).
//
// Written from the policy, for speed. Round 2: the record loop dispatches a quote at a
// field's start before entering the bare scan, so the scan's common path is three tests
// (comma / LF / CR) with no per-character field-start flag. A plain quoted field (next
// quote closes it, no CR inside) is read inline in the record loop — one indexOf jump, a
// bounded CR probe, LF counted by indexOf hops, one slice. Anything rarer (a "" escape, a
// CR inside the quotes, junk after the quote, an unterminated quote) goes to the exact
// quotedField reader, which also walks quote to quote and never scans a span char by char.
// Round 3: every span is sliced FIRST and all probes (CR presence, LF counting) run on the
// slice, so no indexOf ever scans past the span's end into the rest of the text — in
// CR-sparse cases the old unbounded probes could run thousands of characters past the
// closing quote on every quoted field.

const COMMA = 0;
const BREAK = 1;
const END = 2;

// Cold path: read an unquoted field tail the plain way — stray CRs dropped with an error,
// the field ending at a comma, LF, CRLF or the end of the text. `value` is what the field
// already holds ('"' for an unterminated quote re-read, the quoted value for quote junk).
function unquotedTail(text, n, pos, line, errors, recordLine, recordRow, value) {
  let added = 0;
  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c === 44) return { value, ended: COMMA, added, pos: pos + 1, line };
    if (c === 10) return { value, ended: BREAK, added, pos: pos + 1, line: line + 1 };
    if (c === 13) {
      if (text.charCodeAt(pos + 1) === 10) return { value, ended: BREAK, added, pos: pos + 2, line: line + 1 };
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos += 1;
      continue;
    }
    value += text[pos];
    added += 1;
    pos += 1;
  }
  return { value, ended: END, added, pos, line };
}

// Junk after a closing quote: appended as it stands (a quote_junk error when anything of
// it was kept). The plain endings after a quote are handled inline by the fast paths.
function quoteJunk(text, n, pos, line, errors, recordLine, recordRow, value) {
  const junk = unquotedTail(text, n, pos, line, errors, recordLine, recordRow, value);
  if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  return junk;
}

// A quoted field with a "" escape or a CR inside, read exactly: indexOf jumps from quote
// to quote; each span between two quotes is sliced once and accounted on the slice (its
// CRs switch that one span to its LF-converted form, whose LF count is the lines it
// crosses), never a char-by-char walk and never a probe past the span's end. A quote
// that never closes makes the field literal and its text is re-read unquoted.
// pos is at the opening quote. Returns {value, ended, pos, line}.
function quotedField(text, n, pos, line, errors, recordLine, recordRow) {
  const open = pos;
  const openLine = line;
  const start = open + 1;
  let seg = start;
  let i = start;
  let parts = null;
  while (true) {
    const q = text.indexOf('"', i);
    if (q === -1) {
      // The quote never closes: literal, and the text after it is re-read unquoted.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return unquotedTail(text, n, start, openLine, errors, recordLine, recordRow, '"');
    }
    // Account for the span text[seg, q): slice it (the slice is the value anyway) and
    // count the lines it crosses on the slice itself.
    let spanStr = text.slice(seg, q);
    if (spanStr.indexOf('\r') === -1) {
      let lf = 0;
      let l = spanStr.indexOf('\n');
      while (l !== -1) { lf += 1; l = spanStr.indexOf('\n', l + 1); }
      line += lf;
    } else {
      spanStr = spanStr.replace(/\r\n|\r/g, '\n');
      let lf = 0;
      let l = spanStr.indexOf('\n');
      while (l !== -1) { lf += 1; l = spanStr.indexOf('\n', l + 1); }
      line += lf;
    }
    if (text.charCodeAt(q + 1) === 34) {
      // A "" escape: the span and one quote join the parts; the field goes on.
      if (parts === null) parts = [spanStr, '"'];
      else parts.push(spanStr, '"');
      i = q + 2;
      seg = i;
      continue;
    }
    // The closing quote.
    const value = parts === null ? spanStr : (parts.push(spanStr), parts.join(''));
    const p = q + 1;
    if (p >= n) return { value, ended: END, pos: p, line };
    const c = text.charCodeAt(p);
    if (c === 44) return { value, ended: COMMA, pos: p + 1, line };
    if (c === 10) return { value, ended: BREAK, pos: p + 1, line: line + 1 };
    if (c === 13 && text.charCodeAt(p + 1) === 10) return { value, ended: BREAK, pos: p + 2, line: line + 1 };
    return quoteJunk(text, n, p, line, errors, recordLine, recordRow, value);
  }
}

// Cold path: one whole record read field by field, the plain way. Used when the fast
// record loop meets a stray CR: the record starts over through here, so what it returns
// is the record's exact reading. Fills `fields`; returns {pos, line, lastQuoted}.
function recordSlow(text, n, pos, line, errors, recordLine, recordRow, fields) {
  let lastQuoted = false;
  let ended = COMMA;
  while (ended === COMMA) {
    let value;
    if (text.charCodeAt(pos) === 34) {
      lastQuoted = true;
      const r = quotedField(text, n, pos, line, errors, recordLine, recordRow);
      value = r.value; ended = r.ended; pos = r.pos; line = r.line;
    } else {
      lastQuoted = false;
      const r = unquotedTail(text, n, pos, line, errors, recordLine, recordRow, '');
      value = r.value; ended = r.ended; pos = r.pos; line = r.line;
    }
    fields.push(value);
  }
  return { pos, line, lastQuoted };
}

/** csv-reader 1.0.0's answer for one case's input, read fast. */
export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const errMark = errors.length;
    const fields = [];
    let lastQuoted = false;

    // The fast record loop. At each field start a quote hands the field to the quoted
    // readers; otherwise a bare scan walks to the field's end — its common path is three
    // tests, a comma or a line break cuts the field out of the text with a single slice.
    // A stray CR restarts the record through recordSlow (its errors so far are rewound).
    let i = pos;
    let fieldStart = pos;
    let done = false;
    fieldLoop:
    while (!done) {
      if (text.charCodeAt(i) === 34) {
        // A quoted field. Plain case inline: the next quote closes it (not an escape)
        // and its span holds no CR — one indexOf jump, the span sliced once, CR probed
        // and LF counted on the slice so no probe runs past the closing quote.
        const start = i + 1;
        const q = text.indexOf('"', start);
        if (q !== -1 && text.charCodeAt(q + 1) !== 34) {
          const value = text.slice(start, q);
          if (value.indexOf('\r') === -1) {
            let lf = 0;
            let l = value.indexOf('\n');
            while (l !== -1) { lf += 1; l = value.indexOf('\n', l + 1); }
            line += lf;
            lastQuoted = true;
            const p = q + 1;
            if (p >= n) { fields.push(value); pos = n; done = true; break; }
            const c = text.charCodeAt(p);
            if (c === 44) { fields.push(value); i = p + 1; fieldStart = i; continue; }
            if (c === 10) { fields.push(value); line += 1; pos = p + 1; done = true; break; }
            if (c === 13 && text.charCodeAt(p + 1) === 10) { fields.push(value); line += 1; pos = p + 2; done = true; break; }
            const r = quoteJunk(text, n, p, line, errors, recordLine, recordRow, value);
            fields.push(r.value);
            line = r.line;
            i = r.pos;
            if (r.ended === COMMA) { fieldStart = i; continue; }
            pos = i;
            done = true;
            break;
          }
        }
        const r = quotedField(text, n, i, line, errors, recordLine, recordRow);
        fields.push(r.value);
        lastQuoted = true;
        line = r.line;
        i = r.pos;
        if (r.ended === COMMA) { fieldStart = i; continue; }
        pos = i;
        done = true;
        break;
      }
      // Bare scan from i (i is the field's first character, not a quote).
      while (true) {
        if (i >= n) {
          fields.push(text.slice(fieldStart, n));
          lastQuoted = false;
          pos = n;
          done = true;
          break fieldLoop;
        }
        const c = text.charCodeAt(i);
        if (c !== 44 && c !== 10 && c !== 13) { i += 1; continue; }
        if (c === 44) {
          fields.push(text.slice(fieldStart, i));
          lastQuoted = false;
          i += 1;
          fieldStart = i;
          continue fieldLoop;
        }
        if (c === 10) {
          fields.push(text.slice(fieldStart, i));
          lastQuoted = false;
          i += 1;
          line += 1;
          pos = i;
          done = true;
          break fieldLoop;
        }
        // c === 13
        if (text.charCodeAt(i + 1) === 10) {
          fields.push(text.slice(fieldStart, i));
          lastQuoted = false;
          i += 2;
          line += 1;
          pos = i;
          done = true;
          break fieldLoop;
        }
        // Stray CR: rewind and let the exact reader take the whole record.
        errors.length = errMark;
        fields.length = 0;
        const r = recordSlow(text, n, pos, recordLine, errors, recordLine, recordRow, fields);
        pos = r.pos; line = r.line; lastQuoted = r.lastQuoted;
        done = true;
        break fieldLoop;
      }
    }

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

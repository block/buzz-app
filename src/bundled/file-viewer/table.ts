export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 200;
export const MAX_CELLS = 50_000;
export const MAX_CELL_CHARS = 2000;

export type Table = Readonly<{
  rows: readonly (readonly string[])[];
  omittedRows: number;
  omittedColumns: number;
  /** Cells cut to `MAX_CELL_CHARS`, each ending in an ellipsis. */
  shortenedCells: number;
}>;

const QUOTE = 34;
const LF = 10;
const CR = 13;

/** RFC 4180 rows: quoted fields may hold the delimiter, quotes and newlines. */
export function parseTable(text: string, delimiter: "," | "\t"): Table {
  const stop = delimiter.charCodeAt(0);
  const rows: string[][] = [];
  let row: string[] = [];
  let columns = 0;
  let omittedRows = 0;
  let shortenedCells = 0;
  let widest = 0;
  // Text is taken in slices, never a character at a time, and only for cells
  // that are shown, so memory and time follow what is displayed.
  let keep = true;
  let field = "";
  let room = MAX_CELL_CHARS;
  let shortened = false;
  const take = (from: number, to: number) => {
    if (!keep || to <= from) return;
    if (to - from > room) {
      shortened = true;
      to = from + room;
    }
    field += text.slice(from, to);
    room -= to - from;
  };
  const endField = () => {
    if (keep) {
      if (shortened) shortenedCells++;
      row.push(shortened ? `${field}…` : field);
    }
    columns++;
    field = "";
    room = MAX_CELL_CHARS;
    shortened = false;
    keep = rows.length < MAX_ROWS && columns < MAX_COLUMNS;
  };
  const endRow = () => {
    endField();
    widest = Math.max(widest, columns);
    if (rows.length < MAX_ROWS) rows.push(row);
    else omittedRows++;
    row = [];
    columns = 0;
    keep = rows.length < MAX_ROWS;
  };
  let index = 0;
  let open = false;
  while (index < text.length) {
    if (text.charCodeAt(index) === QUOTE) {
      let from = index + 1;
      for (;;) {
        const close = text.indexOf('"', from);
        if (close < 0) {
          take(from, text.length);
          index = text.length;
          break;
        }
        take(from, close);
        if (text.charCodeAt(close + 1) === QUOTE) {
          take(close, close + 1);
          from = close + 2;
        } else {
          index = close + 1;
          break;
        }
      }
    }
    let end = index;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code === stop || code === LF || code === CR) break;
      end++;
    }
    take(index, end);
    open = true;
    if (end >= text.length) {
      index = end;
      break;
    }
    const code = text.charCodeAt(end);
    index = end + 1;
    if (code === stop) endField();
    else {
      if (code === CR && text.charCodeAt(index) === LF) index++;
      endRow();
      open = false;
    }
  }
  if (open || columns > 0) endRow();
  const fit = Math.max(
    1,
    Math.floor(MAX_CELLS / Math.max(1, Math.min(widest, MAX_COLUMNS))),
  );
  if (rows.length > fit) {
    omittedRows += rows.length - fit;
    rows.length = fit;
  }
  return {
    rows,
    omittedRows,
    omittedColumns: Math.max(0, widest - MAX_COLUMNS),
    shortenedCells,
  };
}

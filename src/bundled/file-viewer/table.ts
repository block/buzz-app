export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 200;
export const MAX_CELLS = 50_000;

export type Table = Readonly<{
  rows: readonly (readonly string[])[];
  omittedRows: number;
  omittedColumns: number;
}>;

/** RFC 4180 rows: quoted fields may hold the delimiter, quotes and newlines. */
export function parseTable(text: string, delimiter: "," | "\t"): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let columns = 0;
  let field = "";
  let empty = true;
  let quoted = false;
  let omittedRows = 0;
  let widest = 0;
  // Fields past the display limits are counted but never built, so a huge
  // row costs no more memory than the cells it shows.
  let keep = true;
  const append = (value: string) => {
    empty = false;
    if (keep) field += value;
  };
  const endField = () => {
    if (keep) row.push(field);
    columns++;
    field = "";
    empty = true;
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
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (quoted) {
      if (char !== '"') append(char);
      else if (text[index + 1] === '"') {
        append('"');
        index++;
      } else quoted = false;
    } else if (char === '"' && empty) quoted = true;
    else if (char === delimiter) endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      endRow();
    } else append(char);
  }
  if (!empty || columns > 0) endRow();
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
  };
}

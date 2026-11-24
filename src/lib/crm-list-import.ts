/**
 * Reads a contact spreadsheet (CSV or Excel .xlsx) into rows of name / e-mail / phone.
 * No dependency: an .xlsx is a zip of XML files, unzipped with the platform's
 * DecompressionStream (browsers and Node 18+).
 */

export type Table = string[][];
export interface ColumnMap {
  name: number | null;
  email: number | null;
  phone: number | null;
}
export interface ImportRow {
  line: number; // line number in the spreadsheet (1 = first line)
  name: string | null;
  email: string | null;
  phone: string | null;
}

/* ------------------------------------------------------------------ CSV */

/** CSV from Excel/Google Sheets: ";" or "," or tab, quotes, BOM, CRLF. */
export function parseCsv(text: string): Table {
  const src = text.replace(/^\uFEFF/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => first.split(c).length - 1;
  const delim = [";", ",", "\t"].sort((a, b) => count(b) - count(a))[0]!;
  const rows: Table = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

/* ------------------------------------------------------------------ XLSX */

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files of a zip, by name (only the ones `want` accepts). */
async function unzip(buf: ArrayBuffer, want: (name: string) => boolean) {
  const b = new Uint8Array(buf);
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Arquivo não é uma planilha Excel (.xlsx) válida");
  const entries = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = b.subarray(start, start + size);
    if (method === 0) out.set(name, dec.decode(raw));
    else if (method === 8) out.set(name, dec.decode(await inflate(raw)));
  }
  return out;
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

const textOf = (xml: string) =>
  unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** The first sheet of an .xlsx file. */
export async function parseXlsx(buf: ArrayBuffer): Promise<Table> {
  const files = await unzip(
    buf,
    (n) =>
      n === "xl/sharedStrings.xml" ||
      n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels" ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(n),
  );
  // the first sheet in the workbook's order (not necessarily sheet1.xml)
  let sheetPath: string | undefined;
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(files.get("xl/workbook.xml") ?? "")?.[1];
  if (firstId) {
    const rels = files.get("xl/_rels/workbook.xml.rels") ?? "";
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
      .map((m) => m[0])
      .find((r) => r.includes(`Id="${firstId}"`));
    const target = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  const sheet =
    (sheetPath && files.get(sheetPath)) ??
    files.get("xl/worksheets/sheet1.xml") ??
    [...files.entries()].find(([n]) => n.startsWith("xl/worksheets/"))?.[1];
  if (!sheet) throw new Error("A planilha não tem nenhuma aba com dados");
  const shared = [
    ...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) => textOf(m[1]!));

  const table: Table = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(/\br="(\d+)"/.exec(rm[1]!)?.[1] ?? table.length + 1);
    const row: string[] = [];
    let next = 0;
    for (const cm of rm[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const inner = cm[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = "";
      if (type === "s") val = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") val = textOf(inner);
      else if (raw != null) val = unescapeXml(raw);
      // big phone numbers saved as numbers come as "7.9991592167E10"
      if (type !== "s" && type !== "str" && /^\d+(\.\d+)?E\+?\d+$/i.test(val)) {
        const n = Number(val);
        if (Number.isSafeInteger(n)) val = String(n);
      }
      row[idx] = val.trim();
    }
    table[rowNum - 1] = Array.from(row, (c) => c ?? "");
  }
  return Array.from(table, (r) => r ?? []);
}

/** CSV or Excel, by the file name. */
export async function readSpreadsheet(file: File): Promise<Table> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) return parseXlsx(await file.arrayBuffer());
  if (name.endsWith(".xls"))
    throw new Error(
      "Formato .xls antigo: no Excel, use “Salvar como” → Pasta de Trabalho (.xlsx) ou CSV",
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Excel saves CSV in Windows-1252 when not UTF-8
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(bytes);
  return parseCsv(text);
}

/* ------------------------------------------------------------------ columns */

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const HEADER: Record<keyof ColumnMap, RegExp> = {
  email: /^(e ?mail|email|mail|correio)\b/,
  phone: /^(telefone|celular|whats ?app|whats|zap|fone|phone|tel|contato|numero|cel|mobile)\b/,
  name: /^(nome|name|cliente|contato nome|primeiro nome|full name)\b/,
};

const looksEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
const looksPhone = (v: string) => {
  const d = v.replace(/\D/g, "");
  return d.length >= 10 && d.length <= 13 && !/[a-z@]/i.test(v);
};

/** Finds the name / e-mail / phone columns: by the header, else by the content. */
export function detectColumns(table: Table): { map: ColumnMap; hasHeader: boolean } {
  const header = (table[0] ?? []).map(norm);
  const map: ColumnMap = { name: null, email: null, phone: null };
  for (const k of ["email", "phone", "name"] as const) {
    const i = header.findIndex((h, idx) => HEADER[k].test(h) && !Object.values(map).includes(idx));
    if (i >= 0) map[k] = i;
  }
  const hasHeader = Object.values(map).some((v) => v !== null);
  const body = table.slice(hasHeader ? 1 : 0, 51);
  const width = Math.max(0, ...table.slice(0, 51).map((r) => r.length));
  const score = (i: number, f: (v: string) => boolean) =>
    body.filter((r) => r[i] && f(r[i]!)).length;
  const taken = () => new Set(Object.values(map).filter((v): v is number => v !== null));
  const best = (f: (v: string) => boolean) => {
    let top = -1;
    let at: number | null = null;
    for (let i = 0; i < width; i++) {
      if (taken().has(i)) continue;
      const s = score(i, f);
      if (s > top && s > 0) {
        top = s;
        at = i;
      }
    }
    return at;
  };
  if (map.email === null) map.email = best(looksEmail);
  if (map.phone === null) map.phone = best(looksPhone);
  if (map.name === null && !hasHeader)
    map.name = best((v) => /[a-zà-ú]{2,}/i.test(v) && !looksEmail(v) && !looksPhone(v));
  return { map, hasHeader };
}

export function toRows(table: Table, map: ColumnMap, hasHeader: boolean): ImportRow[] {
  const at = (r: string[], i: number | null) => (i === null ? null : (r[i] ?? "").trim() || null);
  const out: ImportRow[] = [];
  table.forEach((r, idx) => {
    if (hasHeader && idx === 0) return;
    const row = {
      line: idx + 1,
      name: at(r, map.name),
      email: at(r, map.email),
      phone: at(r, map.phone),
    };
    if (row.name || row.email || row.phone) out.push(row);
  });
  return out;
}

/** What the server will accept, to show before importing. */
export function rowProblem(r: ImportRow): string | null {
  const emailOk = !!r.email && looksEmail(r.email);
  const digits = (r.phone ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  const phoneOk = digits.length === 10 || digits.length === 11;
  if (emailOk || phoneOk) return null;
  if (!r.email && !r.phone) return "sem e-mail nem telefone";
  return [r.email && "e-mail inválido", r.phone && "telefone inválido"].filter(Boolean).join(" e ");
}

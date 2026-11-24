/** Listas importadas: spreadsheet reading and crm_import_list_contacts. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import {
  detectColumns,
  parseCsv,
  parseXlsx,
  rowProblem,
  toRows,
} from "../../src/lib/crm-list-import.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

/** A minimal zip (deflated entries) like the one Excel writes. */
function zip(files: Record<string, string>): ArrayBuffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(Buffer.byteLength(text), 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...parts, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

describe("leitura de planilha", () => {
  test("CSV do Excel brasileiro: ponto e vírgula, aspas, BOM", () => {
    const t = parseCsv(
      '\uFEFFNome;E-mail;Celular\r\n"Silva; Ana";ana@x.com;(79) 99159-2167\r\nBia;;11912345678\r\n',
    );
    assert.deepEqual(t[1], ["Silva; Ana", "ana@x.com", "(79) 99159-2167"]);
    const d = detectColumns(t);
    assert.deepEqual(d, { map: { name: 0, email: 1, phone: 2 }, hasHeader: true });
    const rows = toRows(t, d.map, d.hasHeader);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], { line: 3, name: "Bia", email: null, phone: "11912345678" });
  });

  test("sem cabeçalho: descobre as colunas pelo conteúdo", () => {
    const t = parseCsv("5511912345678,joao@x.com,João\n79991592167,maria@y.com.br,Maria\n");
    const d = detectColumns(t);
    assert.equal(d.hasHeader, false);
    assert.deepEqual(d.map, { name: 2, email: 1, phone: 0 });
  });

  test("Excel .xlsx: textos compartilhados, número grande, primeira aba", async () => {
    const buf = zip({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Contatos" sheetId="1" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        "<sst><si><t>Nome</t></si><si><t>Email</t></si><si><t>WhatsApp</t></si><si><r><t>Ana </t></r><r><t>&amp; Cia</t></r></si><si><t>ana@x.com</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>79991592167</v></c></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t>Bia</t></is></c><c r="C4"><v>5.511912345678E12</v></c></row></sheetData></worksheet>',
      "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
    });
    const t = await parseXlsx(buf);
    assert.deepEqual(t[0], ["Nome", "Email", "WhatsApp"]);
    assert.deepEqual(t[1], ["Ana & Cia", "ana@x.com", "79991592167"]);
    assert.deepEqual(t[3], ["Bia", "", "5511912345678"]);
    const d = detectColumns(t);
    const rows = toRows(t, d.map, d.hasHeader);
    assert.deepEqual(
      rows.map((r) => r.line),
      [2, 4],
    );
  });

  test("o que fica de fora antes de importar", () => {
    assert.equal(rowProblem({ line: 1, name: "a", email: "a@b.co", phone: null }), null);
    assert.equal(
      rowProblem({ line: 1, name: "a", email: null, phone: "+55 (11) 91234-5678" }),
      null,
    );
    assert.equal(
      rowProblem({ line: 1, name: "a", email: null, phone: null }),
      "sem e-mail nem telefone",
    );
    assert.equal(
      rowProblem({ line: 1, name: "a", email: "x", phone: "123" }),
      "e-mail inválido e telefone inválido",
    );
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as Record<string, unknown>;
};

describe("importar lista no CRM", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  let key = "";
  let ana = "";
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'li_%')`;
    await sql!`delete from crm.flows where key like 'li_%'`;
    await sql!`delete from crm.segments where key like 'lista_%'`;
    ana = String(
      (
        await sql!`insert into crm.customers (full_name, email, phone) values ('Ana Cliente', 'ana@example.com', null) returning customer_id`
      )[0]!["customer_id"],
    );
    await sql!`insert into crm.customer_identities (kind, value, customer_id) values ('email', 'ana@example.com', ${ana})`;
  });
  after(async () => {
    await sql?.end();
  });

  test("cria a lista (nome sem acento vira a chave) e não repete nome", async () => {
    const r = await call("crm_create_list", { p_name: "Leads Promoção Novembro" });
    key = String(r["key"]);
    assert.equal(key, "lista_leads_promocao_novembro");
    const { error } = await rpc("crm_create_list", { p_name: "leads promoção novembro" });
    assert.match(String(error?.message), /Já existe/);
  });

  test("importa: cliente existente é reaproveitado, novos são contatos reais, inválidos ficam de fora", async () => {
    const r = await call("crm_import_list_contacts", {
      p_segment: key,
      p_rows: [
        { line: 2, name: "Ana Outro Nome", email: "ANA@example.com", phone: "(79) 99159-2167" },
        { line: 3, name: "Bia", email: null, phone: "+55 11 91234-5678" },
        { line: 4, name: "Caio", email: "caio@example.com", phone: null },
        { line: 5, name: "Sem contato", email: "", phone: "" },
        { line: 6, name: "Errado", email: "caio-at-example", phone: "1234" },
      ],
    });
    assert.equal(r["total"], 5);
    assert.equal(r["added"], 3);
    assert.equal(r["matched"], 1);
    assert.equal(r["created"], 2);
    assert.equal(r["invalid"], 2);
    assert.deepEqual(
      (r["invalid_rows"] as { line: number }[]).map((x) => x.line),
      [5, 6],
    );
    // the existing customer keeps the name, gains the phone it lacked
    const [a] =
      await sql!`select full_name, phone, whatsapp from crm.customers where customer_id = ${ana}`;
    assert.equal(a!["full_name"], "Ana Cliente");
    assert.equal(a!["phone"], "79991592167");
    const [b] = await sql!`select c.is_test, c.whatsapp from crm.customers c
                            join crm.customer_identities i using (customer_id)
                            where i.kind = 'whatsapp' and i.value = '5511912345678'`;
    assert.equal(b!["is_test"], false);
    assert.equal(b!["whatsapp"], "11912345678");
  });

  test("importar de novo não duplica", async () => {
    const r = await call("crm_import_list_contacts", {
      p_segment: key,
      p_rows: [{ line: 2, name: "Bia", email: null, phone: "11912345678" }],
    });
    assert.equal(r["added"], 0);
    assert.equal(r["already_in_list"], 1);
    assert.equal(r["created"], 0);
    const [n] =
      await sql!`select count(*)::int as n from crm.segment_members m join crm.segments s using (segment_id) where s.key = ${key}`;
    assert.equal(n!["n"], 3);
  });

  test("a lista aparece nos segmentos e serve para um disparo", async () => {
    const segs = (await rpc("crm_list_segments", {})).data as {
      key: string;
      kind: string;
      members: number;
    }[];
    const s = segs.find((x) => x.key === key)!;
    assert.equal(s.kind, "manual");
    assert.equal(Number(s.members), 3);
    await call("crm_save_flow", {
      p_key: "li_disparo",
      p_name: "li",
      p_trigger_fact: "BROADCAST",
      p_graph: { nodes: [{ id: "start", type: "trigger", config: {} }], edges: [] },
    });
    await call("crm_publish_flow", { p_key: "li_disparo" });
    await call("crm_set_broadcast", {
      p_key: "li_disparo",
      p_segment: key,
      p_schedule: { mode: "once", at: "2030-01-01T10:00" },
      p_audience: "once_ever",
    });
    const run = await call("crm_run_broadcast_now", { p_key: "li_disparo" });
    assert.equal(run["enrolled"], 3);
  });

  test("não importa na lista Teste nem em segmento por regra; quem pediu exclusão fica de fora", async () => {
    const { error } = await rpc("crm_import_list_contacts", {
      p_segment: "customer_active",
      p_rows: [{ line: 1, email: "x@example.com" }],
    });
    assert.match(String(error?.message), /lista manual/);
    const t = await rpc("crm_import_list_contacts", {
      p_segment: "teste",
      p_rows: [{ line: 1, email: "x@example.com" }],
    });
    assert.match(String(t.error?.message), /contatos de teste/);
    await sql!`update crm.customers set anonymized_at = now() where customer_id = ${ana}`;
    const r = await call("crm_import_list_contacts", {
      p_segment: key,
      p_rows: [{ line: 9, email: "ana@example.com" }],
    });
    assert.deepEqual(r["invalid_rows"], [{ line: 9, reason: "pediu exclusão dos dados (LGPD)" }]);
  });
});

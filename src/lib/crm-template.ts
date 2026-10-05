/** Message templates for automations: shared by the server executor and the editor preview. */

function format(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))
    return Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return String(v);
}

/** Replaces {{name}} with customer fields, then trigger data. Unknown names render empty. */
export function renderTemplate(
  template: string,
  customer: Record<string, unknown>,
  trigger: Record<string, unknown> = {},
) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) =>
    format(customer[key] ?? trigger[key]),
  );
}

/** Approved WhatsApp templates (Meta) → the CRM's WhatsApp content. Shared by editor and server. */
import { waPlaceholders, type WhatsappButton, type WhatsappContent } from "./crm-messages.ts";

export interface MetaTemplate {
  id?: string;
  name: string;
  language: string;
  status: string;
  category: string;
  parameter_format?: string;
  components: {
    type: string;
    format?: string;
    text?: string;
    buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
  }[];
}

/** The editor's content for an approved template (keeps the values already filled). */
export function contentFromTemplate(
  t: MetaTemplate,
  prev?: WhatsappContent | null,
): WhatsappContent {
  const comp = (type: string) => t.components.find((x) => x.type === type);
  const header = comp("HEADER");
  // same template again: the values already filled stay
  const prevMeta = prev?.meta?.name === t.name ? prev.meta : null;
  const prevHeader = prev?.header ?? null;
  const fmt = (header?.format ?? "").toLowerCase();
  const named = (t.parameter_format ?? "").toUpperCase() === "NAMED";
  const buttons = (comp("BUTTONS")?.buttons ?? []).map((b): WhatsappButton => {
    const type = b.type.toUpperCase();
    if (type === "URL") return { type: "url", text: b.text, url: b.url ?? "" };
    if (type === "PHONE_NUMBER")
      return { type: "phone", text: b.text, phone: b.phone_number ?? "" };
    if (type === "COPY_CODE") return { type: "copy_code", text: b.text || "Copiar código" };
    return { type: "quick_reply", text: b.text };
  });
  const body = comp("BODY")?.text ?? "";
  const keys = waPlaceholders(body);
  return {
    category: t.category.toUpperCase() === "MARKETING" ? "marketing" : "utility",
    header:
      fmt === "text"
        ? { type: "text", text: header?.text ?? "" }
        : fmt === "image" || fmt === "video" || fmt === "document"
          ? { type: fmt, url: prevHeader?.url ?? "" }
          : { type: "none" },
    body,
    footer: comp("FOOTER")?.text ?? "",
    buttons,
    meta: {
      name: t.name,
      language: t.language,
      format: named ? "named" : "positional",
      params: Object.fromEntries(
        keys.map((k) => [k, prevMeta?.params?.[k] ?? (named ? `{{${k}}}` : "")]),
      ),
      header_params: prevMeta?.header_params ?? {},
      button_params: prevMeta?.button_params ?? {},
    },
  };
}

/** Templates that can be used: approved ones, by name. */
export const usableTemplates = (list: MetaTemplate[]) =>
  list
    .filter((t) => t.status.toUpperCase() === "APPROVED")
    .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));

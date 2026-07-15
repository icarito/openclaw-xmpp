// Xmpp plugin module implements XEP-0004 Data Forms.
//
// Ported near-verbatim from src/channels/xmpp-control/xep-0004.ts (NanoClaw).
// No NanoClaw-specific dependencies -- pure XML building/parsing.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

const FORM_NS = "jabber:x:data";

export type FormType = "form" | "submit" | "result" | "cancel";

export interface FormField {
  var: string;
  type?:
    | "boolean"
    | "fixed"
    | "hidden"
    | "jid-multi"
    | "jid-single"
    | "list-multi"
    | "list-single"
    | "text-multi"
    | "text-single";
  label?: string;
  value?: string | string[];
  desc?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
}

export interface DataForm {
  type: FormType;
  title?: string;
  instructions?: string[];
  fields: FormField[];
}

function normalizeBooleanValue(value: string): string {
  return value === "true" || value === "1" ? "1" : "0";
}

function valueToXml(field: FormField): Element[] {
  const value = field.value;
  if (value === undefined) return [];
  if (field.type === "boolean" && typeof value === "string") {
    return [xml("value", {}, normalizeBooleanValue(value))];
  }
  if (Array.isArray(value)) return value.map((v) => xml("value", {}, v));
  return [xml("value", {}, value)];
}

export function buildFormElement(form: DataForm): Element {
  const children: Element[] = [];

  if (form.title) children.push(xml("title", {}, form.title));
  if (form.instructions) {
    for (const instr of form.instructions) {
      children.push(xml("instructions", {}, instr));
    }
  }

  for (const field of form.fields) {
    const attrs: Record<string, string> = { var: field.var };
    if (field.type) attrs.type = field.type;
    if (field.label) attrs.label = field.label;

    const fieldEls: Element[] = [];
    if (field.desc) fieldEls.push(xml("desc", {}, field.desc));
    if (field.required) fieldEls.push(xml("required", {}));
    // XEP-0004 3.3: <option/> MUST NOT appear on fields other than
    // list-single/list-multi.
    if (field.options && (field.type === "list-single" || field.type === "list-multi")) {
      for (const opt of field.options) {
        fieldEls.push(xml("option", { label: opt.label }, xml("value", {}, opt.value)));
      }
    }
    fieldEls.push(...valueToXml(field));

    children.push(xml("field", attrs, ...fieldEls));
  }

  return xml("x", { xmlns: FORM_NS, type: form.type }, ...children);
}

export function buildRequestForm(title: string, instructions: string[], fields: FormField[]): Element {
  return buildFormElement({ type: "form", title, instructions, fields });
}

export function buildResultForm(title: string, fields: FormField[]): Element {
  return buildFormElement({ type: "result", title, fields });
}

export function parseSubmitForm(xElement: Element): Record<string, string> {
  const result: Record<string, string> = {};
  const fields = xElement.getChildren("field");
  for (const field of fields) {
    const name = field.attrs.var as string | undefined;
    if (!name) continue;
    const values = field.getChildren("value");
    if (values.length > 0) {
      result[name] = values.map((v: Element) => v.text()).join("\n");
    } else {
      result[name] = "";
    }
  }
  return result;
}

export function isFormSubmit(stanza: Element): boolean {
  const x = stanza.getChild("x", FORM_NS);
  return x !== undefined && x.attrs.type === "submit";
}

export function isFormCancel(stanza: Element): boolean {
  const x = stanza.getChild("x", FORM_NS);
  return x !== undefined && x.attrs.type === "cancel";
}

export function extractFormType(stanza: Element): FormType | null {
  const x = stanza.getChild("x", FORM_NS);
  if (!x) return null;
  return (x.attrs.type as FormType) || null;
}

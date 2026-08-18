import type { TemplateBinding, TemplateDefinition } from "./template-definition.js";

export interface TemplateBindingContext {
  readonly recipient: { readonly displayName: string };
  readonly project: { readonly name: string };
  readonly training: { readonly name: string; readonly code: string };
  readonly certificate: { readonly number: string; readonly issuedAt: string };
  readonly verificationUrl: string;
}

const bindingResolvers: Readonly<Record<TemplateBinding, (context: TemplateBindingContext) => string>> = {
  "recipient.display_name": (context) => context.recipient.displayName,
  "project.name": (context) => context.project.name,
  "training.name": (context) => context.training.name,
  "training.code": (context) => context.training.code,
  "certificate.number": (context) => context.certificate.number,
  "certificate.issued_at": (context) => context.certificate.issuedAt,
  verification_url: (context) => context.verificationUrl
};

export interface BoundTemplateElement {
  readonly index: number;
  readonly value: string | null;
}

export const bindTemplate = (
  definition: TemplateDefinition,
  context: TemplateBindingContext
): readonly BoundTemplateElement[] => definition.elements.map((element, index) => {
  if (element.type === "text") {
    return { index, value: element.binding === undefined ? element.text ?? "" : bindingResolvers[element.binding](context) };
  }
  if (element.type === "qr") return { index, value: bindingResolvers.verification_url(context) };
  return { index, value: null };
});

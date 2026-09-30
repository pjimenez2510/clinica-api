import { DocumentTemplateSlotInvalidError } from './document.errors';
import type { DocumentKind } from './document-kind';

/**
 * DOC-030 to DOC-037. The template, and the closed set of slots it fills.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIXED SLOTS, NOT AN EDITABLE TEMPLATE, AND THE ARGUMENT IS THIS PROJECT'S OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The general risk has a name — INTERNAL PLATFORM EFFECT: making something so
 * configurable that it becomes a badly-made programming language inside your
 * application. But the argument that decides it here is stronger and local: A
 * VERIFIABLE EARS REQUIREMENT CANNOT BE WRITTEN AGAINST A TEMPLATE THE CLINIC
 * REWROTE ON TUESDAY. The chain normativa → REQ → DOC → prueba stops being
 * checkable the moment the structure of the document is tenant data — and this
 * whole repository is built on that chain being checkable by `pnpm rtm`.
 *
 * Besides, «varias clínicas» here means several DEPLOYMENTS: the schema says so
 * out loud — «Not a tenant: the whole database belongs to one clinic».
 *
 * What IS parameterised is exactly what Stripe parameterises: logo, the
 * establishment's own data, an accent colour, a free footer and a few key-value
 * fields. It is enough.
 */

/** DOC-036. One key-value field of the header. */
export interface HeaderField {
  label: string;
  value: string;
}

/** DOC-034. Every slot there is. Adding one is a schema change and a SPEC change. */
export interface TemplateSlots {
  /** DOC-035. `#rrggbb`, lowercase. */
  accentColour: string;
  /** Spanish: the patient reads it. */
  footerText: string | null;
  /** DOC-036. At most six. */
  headerFields: readonly HeaderField[];
  /**
   * DOC-034. THE THREE FIELDS ART. 5 DOES NOT REQUIRE.
   *
   * The only establishment datum the receta must carry is the NAME (art. 5.a).
   * RUC, address and telephone are the clinic's choice — printing them is a
   * decision, and a decision is a switch, not a mandatory column.
   */
  showEstablishmentRuc: boolean;
  showEstablishmentAddress: boolean;
  showEstablishmentPhone: boolean;
}

/** A published version of a template. */
export interface DocumentTemplate extends TemplateSlots {
  id: string;
  kind: DocumentKind;
  version: number;
  publishedAt: Date;
}

export const MAX_HEADER_FIELDS = 6;
const ACCENT_COLOUR = /^#[0-9a-f]{6}$/;
const MAX_LABEL_LENGTH = 40;
const MAX_VALUE_LENGTH = 120;

/**
 * DOC-035, DOC-036. The slots, checked before anything is written.
 *
 * ⚠️ THE DATABASE CHECKS THE SAME THINGS
 * (`document_template_accent_colour_format`,
 * `document_template_header_fields_bounded`) AND THAT IS NOT DUPLICATION. This
 * one names the field so a form can highlight it; the `CHECK` guards the import
 * and the `psql` that never come through here. The two say the same rule to two
 * different readers.
 */
export function assertSlotsAreValid(slots: TemplateSlots): void {
  if (!ACCENT_COLOUR.test(slots.accentColour)) {
    throw new DocumentTemplateSlotInvalidError(
      'accentColour',
      'El color de acento se escribe como #rrggbb en minúsculas, por ejemplo #1f6f8b',
    );
  }

  if (slots.headerFields.length > MAX_HEADER_FIELDS) {
    throw new DocumentTemplateSlotInvalidError(
      'headerFields',
      `La cabecera admite como mucho ${MAX_HEADER_FIELDS} campos`,
    );
  }

  slots.headerFields.forEach((field, index) => {
    if (field.label.trim() === '' || field.value.trim() === '') {
      throw new DocumentTemplateSlotInvalidError(
        `headerFields.${index}`,
        'Cada campo de la cabecera necesita una etiqueta y un valor',
      );
    }
    if (
      field.label.length > MAX_LABEL_LENGTH ||
      field.value.length > MAX_VALUE_LENGTH
    ) {
      throw new DocumentTemplateSlotInvalidError(
        `headerFields.${index}`,
        'La etiqueta o el valor son demasiado largos para la cabecera',
      );
    }
  });
}

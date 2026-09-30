import { Inject, Injectable } from '@nestjs/common';

import {
  EXAM_CATALOGUE_REPOSITORY,
  type ExamCatalogueRepository,
  type ExamDefinitionView,
} from '../domain/exam-catalogue.repository';

/**
 * ORD-010 to ORD-012. What can be ordered, and what each one yields.
 *
 * ⚠️ READ AND NOTHING ELSE, AND THE ABSENCE IS THE DECISION. Creating an exam
 * or an analyte is a CATALOGUE operation: versioned whole replacement, retired
 * codes disabled and never deleted, validity per version — the three rules of
 * the IHE catalogue-distribution standard, all three already built into
 * `CatalogSystem → CatalogRelease → CatalogConcept` and reachable through
 * `catalog:manage`. A second, weaker way to create one here is how two
 * catalogues of the same thing start disagreeing.
 *
 * ⚠️ AND IT SERVES NO PRICE (ORD-002). `exam_definition.billable_service_id`
 * points at what the line is invoiced under; the AMOUNT lives in a price list,
 * per payer, per period, and belongs to `billing`. Nothing here loads it, so
 * nothing here can leak it onto a clinical screen.
 *
 * NOT AUDITED: a catalogue is not a chart. What travels is «qué exámenes
 * existen», which says nothing about any person.
 */
@Injectable()
export class ExamCatalogueService {
  constructor(
    @Inject(EXAM_CATALOGUE_REPOSITORY)
    private readonly exams: ExamCatalogueRepository,
  ) {}

  /**
   * ORD-010 to ORD-012. Every orderable a doctor can ask for today, with its
   * determinations in printing order.
   *
   * The preparation travels because it is printed ON THE ORDER the patient
   * takes away: a fast nobody stated is a second extraction, and the eight to
   * twelve hours of `EX-GLUCOSA-AYUNAS` are the difference between a result
   * and a wasted morning.
   */
  active(): Promise<ExamDefinitionView[]> {
    return this.exams.active();
  }
}

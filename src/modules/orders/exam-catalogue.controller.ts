import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../../shared/http/auth.decorators';

import { ExamCatalogueService } from './application/exam-catalogue.service';
import {
  OrderableExamListDto,
  type OrderableExamListResponse,
} from './dto/exam-catalogue.dto';

/**
 * ORD-010 to ORD-012. What can be ordered, and what each one yields.
 *
 * `catalog:read` AND `'global'` SITE SCOPE, and both are deliberate: a
 * catalogue is not a chart, it is identical at every site, and nothing here
 * says anything about any person. Declaring `'query'` would claim a narrowing
 * the handler does not perform, which is worse than saying «this is not
 * site-scoped» out loud.
 *
 * ⚠️ READ ONLY. An orderable is a service of the one catalogue (ADR-013),
 * created in billing (BI-280); its structure is `catalog:manage` (ORD-105).
 */
@ApiTags('orders')
@Controller({ path: 'exams', version: '1' })
export class ExamCatalogueController {
  constructor(private readonly exams: ExamCatalogueService) {}

  /** ORD-010 to ORD-012. Every orderable, with its determinations in order. */
  @Get()
  @RequirePermission('catalog:read', 'global')
  @ApiOperation({
    summary:
      'Listar los exámenes que se pueden pedir y las determinaciones que devuelven',
  })
  @ApiOkResponse({ type: OrderableExamListDto })
  async active(): Promise<OrderableExamListResponse> {
    const items = await this.exams.active();

    return {
      items: items.map((exam) => ({
        id: exam.id,
        code: exam.code,
        name: exam.name,
        category: exam.category,
        form010Section: exam.form010Section,
        specimenType: exam.specimenType,
        patientPreparation: exam.patientPreparation,
        turnaroundHours: exam.turnaroundHours,
        requiresFasting: exam.requiresFasting,
        fastingHours: exam.fastingHours,
        // BI-285. The key keeps its name; the value is the service's MSP code.
        tariffCode: exam.mspCode,
        performedExternally: exam.performedExternally,
        externalLabName: exam.externalLabName,
        analytes: exam.analytes.map((entry) => ({
          id: entry.analyte.id,
          code: entry.analyte.code,
          name: entry.analyte.name,
          unit: entry.analyte.unit,
          valueType: entry.analyte.valueType,
          decimals: entry.analyte.decimals,
          allowedValues: entry.analyte.allowedValues
            ? [...entry.analyte.allowedValues]
            : null,
          position: entry.position,
          isReflex: entry.isReflex,
        })),
      })),
    };
  }
}

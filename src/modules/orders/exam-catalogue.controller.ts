import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../../shared/http/auth.decorators';

import { ExamCatalogueService } from './application/exam-catalogue.service';
import {
  ExamDefinitionListDto,
  type ExamDefinitionListResponse,
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
 * ⚠️ READ ONLY. Creating an exam or an analyte is `catalog:manage`, through the
 * versioned release mechanism this system already has. A second way to create
 * one here is how two catalogues of the same thing start disagreeing.
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
  @ApiOkResponse({ type: ExamDefinitionListDto })
  async active(): Promise<ExamDefinitionListResponse> {
    const items = await this.exams.active();

    return {
      items: items.map((exam) => ({
        id: exam.id,
        code: exam.code,
        name: exam.name,
        form010Section: exam.form010Section,
        specimenType: exam.specimenType,
        patientPreparation: exam.patientPreparation,
        turnaroundHours: exam.turnaroundHours,
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

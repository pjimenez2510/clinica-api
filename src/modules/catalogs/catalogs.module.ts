import './infrastructure/catalogs.constraints';
import { Module } from '@nestjs/common';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';

import { CatalogsService } from './application/catalogs.service';
import { CatalogsController } from './catalogs.controller';
import { CATALOG_REPOSITORY } from './domain/catalog.repository';
import { PrismaCatalogRepository } from './infrastructure/prisma-catalog.repository';

/**
 * Catálogos clínicos: CIE-10 hoy, CNMB y tarifario después.
 *
 * UN SOLO MÓDULO PARA TODOS, no uno por catálogo. Los tres comparten forma
 * —código, descripción, jerarquía, vigencia— y lo que cambia es el archivo que
 * se importa, no la manera de consultarlos. Tres módulos serían el mismo código
 * tres veces esperando a divergir.
 *
 * `CatalogsService` se exporta porque la consulta clínica tendrá que validar un
 * diagnóstico antes de guardarlo, y esa comprobación no puede vivir en dos
 * sitios.
 */
@Module({
  controllers: [CatalogsController],
  providers: [
    CatalogsService,
    CurrentUserService,
    { provide: CATALOG_REPOSITORY, useClass: PrismaCatalogRepository },
  ],
  exports: [CatalogsService],
})
export class CatalogsModule {}

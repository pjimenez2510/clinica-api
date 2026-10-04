import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { assertClinicWideScope } from '../../shared/authorisation/site-scope';
import { clinicalDateOf } from '../../shared/domain/clinic-time';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { PricingService } from './application/pricing.service';
import { ServiceCatalogueService } from './application/service-catalogue.service';
import type { Requester } from './application/service-catalogue.service';
import type {
  BillableServiceView,
  PayerView,
  ServiceCategoryView,
} from './domain/billing.repository';
import { Money } from './domain/money';
import type { PriceRow } from './domain/price-list';
import {
  CatalogueQueryDto,
  CreatePayerDto,
  CreateServiceCategoryDto,
  CreateServiceDto,
  PayerDto,
  PayerListDto,
  PriceDto,
  PriceListResponseDto,
  ServiceCategoryDto,
  ServiceCategoryListDto,
  ServiceExamListDto,
  ServicePriceListDto,
  ServiceDto,
  ServiceListDto,
  SetPriceDto,
  TaxRateDto,
  UpdatePayerDto,
  UpdateServiceCategoryDto,
  UpdateServiceDto,
  type PayerResponse,
  type PriceListResponse,
  type PriceResponse,
  type ServiceCategoryResponse,
  type ServiceExamResponse,
  type ServicePriceResponse,
  type ServiceResponse,
  type TaxRateResponse,
} from './dto/billing.dto';

/**
 * What the clinic charges for, and how much.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY ROUTE HERE IS `global` AND NOT `param:siteId`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What the clinic charges is not a site's: it is the CLINIC'S. A tariff split
 * by branch is the mistake nobody can consolidate into a report afterwards,
 * and `price_list.site_id` stays NULL for exactly that reason. So the scope is
 * declared `global`, which the route-coverage test accepts only as a stated
 * decision — and the writes back it up with `assertClinicWideScope`, because a
 * grant confined to Norte and Sur is not clinic-wide even when those are the
 * only two sites open: the clinic opens a third next month and inherits a
 * tariff decided by somebody who never had that site (D-023).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHY READING IS `billing:read` WHILE WRITING IS `billing:price-manage`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BI-046, BI-134: whoever invoices does not set prices. A price is a datum
 * that moves money, and the two acts are done by different people — the
 * cashier needs to SEE the tariff to charge, and must not be able to change
 * it. No factory role carries both permissions, and a test asserts it.
 */
@ApiTags('billing')
@Controller({ path: 'billing', version: '1' })
export class BillingCatalogueController {
  constructor(
    private readonly services: ServiceCatalogueService,
    private readonly pricing: PricingService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** BI-020, BI-021. */
  @Get('tax-rates')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar las tarifas de impuesto del SRI' })
  @ApiOkResponse({ type: TaxRateDto })
  async taxRates(): Promise<{ items: TaxRateResponse[] }> {
    const items = await this.services.listTaxRates();
    return {
      items: items.map((rate) => ({
        id: rate.id,
        sriCode: rate.sriCode,
        name: rate.name,
        percentage: rate.percentage?.toString() ?? null,
        validFrom: rate.validFrom,
        validTo: rate.validTo,
      })),
    };
  }

  /** BI-010, BI-011, BI-014. */
  @Get('services')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar el catálogo de prestaciones' })
  @ApiOkResponse({ type: ServiceListDto })
  async listServices(
    @Query() query: CatalogueQueryDto,
  ): Promise<{ items: ServiceResponse[] }> {
    const items = await this.services.listServices({
      includeInactive: query.includeInactive,
    });
    return { items: items.map(toServiceResponse) };
  }

  /** BI-010 a BI-013. */
  @Post('services')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una prestación del catálogo' })
  @ApiCreatedResponse({ type: ServiceDto })
  async createService(@Body() dto: CreateServiceDto): Promise<ServiceResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toServiceResponse(
      await this.services.createService(
        {
          code: dto.code,
          name: dto.name,
          categoryId: dto.categoryId,
          tariffCode: dto.tariffCode ?? null,
          taxRateId: dto.taxRateId,
        },
        requester,
      ),
    );
  }

  /** BI-011, BI-014, BI-025. */
  @Patch('services/:serviceId')
  @RequirePermission('billing:price-manage', 'global')
  @ApiOperation({ summary: 'Modificar una prestación del catálogo' })
  @ApiOkResponse({ type: ServiceDto })
  async updateService(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: UpdateServiceDto,
  ): Promise<ServiceResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toServiceResponse(
      await this.services.updateService(
        serviceId,
        {
          name: dto.name,
          categoryId: dto.categoryId,
          tariffCode: dto.tariffCode,
          taxRateId: dto.taxRateId,
          active: dto.active,
          // BI-158. The DTO always took it and nothing passed it on: the
          // mapping could only be changed by the seed (found in B11).
          consultation: dto.consultation,
        },
        requester,
      ),
    );
  }

  /** BI-189. The service's prices in every payer's list, the one in force marked. */
  @Get('services/:serviceId/prices')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar los precios de una prestación en todas las listas' }) // prettier-ignore
  @ApiOkResponse({ type: ServicePriceListDto })
  async servicePrices(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<{ items: ServicePriceResponse[] }> {
    const items = await this.services.servicePrices(
      serviceId,
      clinicalDateOf(new Date()),
    );
    return {
      items: items.map((price) => ({
        priceId: price.priceId,
        payer: price.payer,
        amount: price.amount.toString(),
        validFrom: price.validFrom,
        validTo: price.validTo,
        inForce: price.inForce,
      })),
    };
  }

  /** BI-188. The exams of the exam catalogue charged through the service. */
  @Get('services/:serviceId/exams')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar los exámenes que se cobran con una prestación' }) // prettier-ignore
  @ApiOkResponse({ type: ServiceExamListDto })
  async serviceExams(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<{ items: ServiceExamResponse[] }> {
    return { items: await this.services.serviceExams(serviceId) };
  }

  /** BI-012. */
  @Delete('services/:serviceId')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirar una prestación que nadie ha usado' })
  @ApiNoContentResponse()
  async deleteService(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<void> {
    const requester = this.requireClinicWide('billing:price-manage');
    await this.services.deleteService(serviceId, requester);
  }

  /** BI-185. The categories, alphabetical; the inactive ones on request. */
  @Get('service-categories')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar las categorías de prestación' })
  @ApiOkResponse({ type: ServiceCategoryListDto })
  async listCategories(
    @Query() query: CatalogueQueryDto,
  ): Promise<{ items: ServiceCategoryResponse[] }> {
    const items = await this.services.listCategories({
      includeInactive: query.includeInactive,
    });
    return { items: items.map(toCategoryResponse) };
  }

  /** BI-185, BI-186. */
  @Post('service-categories')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear una categoría de prestación' })
  @ApiCreatedResponse({ type: ServiceCategoryDto })
  async createCategory(
    @Body() dto: CreateServiceCategoryDto,
  ): Promise<ServiceCategoryResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toCategoryResponse(
      await this.services.createCategory(
        { name: dto.name, kind: dto.kind },
        requester,
      ),
    );
  }

  /** BI-185. Renames or (de)activates; the kind is fixed (BI-187). */
  @Patch('service-categories/:categoryId')
  @RequirePermission('billing:price-manage', 'global')
  @ApiOperation({ summary: 'Renombrar o desactivar una categoría de prestación' }) // prettier-ignore
  @ApiOkResponse({ type: ServiceCategoryDto })
  async updateCategory(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toCategoryResponse(
      await this.services.updateCategory(
        categoryId,
        { name: dto.name, active: dto.active },
        requester,
      ),
    );
  }

  /** BI-030, BI-031. */
  @Get('payers')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar los pagadores' })
  @ApiOkResponse({ type: PayerListDto })
  async listPayers(
    @Query() query: CatalogueQueryDto,
  ): Promise<{ items: PayerResponse[] }> {
    const items = await this.pricing.listPayers({
      includeInactive: query.includeInactive,
    });
    return { items: items.map(toPayerResponse) };
  }

  /** BI-030, BI-034. */
  @Post('payers')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Dar de alta un pagador' })
  @ApiCreatedResponse({ type: PayerDto })
  async createPayer(@Body() dto: CreatePayerDto): Promise<PayerResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toPayerResponse(
      await this.pricing.createPayer(
        {
          code: dto.code,
          name: dto.name,
          kind: dto.kind,
          ruc: dto.ruc ?? null,
          agreementReference: dto.agreementReference ?? null,
        },
        requester,
      ),
    );
  }

  /** BI-031, BI-034. */
  @Patch('payers/:payerId')
  @RequirePermission('billing:price-manage', 'global')
  @ApiOperation({ summary: 'Modificar o desactivar un pagador' })
  @ApiOkResponse({ type: PayerDto })
  async updatePayer(
    @Param('payerId', ParseUUIDPipe) payerId: string,
    @Body() dto: UpdatePayerDto,
  ): Promise<PayerResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toPayerResponse(
      await this.pricing.updatePayer(
        payerId,
        {
          name: dto.name,
          ruc: dto.ruc,
          agreementReference: dto.agreementReference,
          active: dto.active,
        },
        requester,
      ),
    );
  }

  /** BI-040, BI-041. */
  @Get('payers/:payerId/prices')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar la lista de precios de un pagador' })
  @ApiOkResponse({ type: PriceListResponseDto })
  async listPrices(
    @Param('payerId', ParseUUIDPipe) payerId: string,
  ): Promise<PriceListResponse> {
    const { priceList, prices } = await this.pricing.listPrices(payerId);
    return {
      priceListId: priceList.id,
      payerId: priceList.payerId,
      publiclyListed: priceList.publiclyListed,
      items: prices.map(toPriceResponse),
    };
  }

  /**
   * BI-041 a BI-048. «A partir de esta fecha cuesta otra cosa».
   *
   * A `POST` and not a `PUT`: what happens is the CREATION of a validity, and
   * the previous one is closed as part of it. Nothing is replaced, which is
   * the whole point of BI-044 — the row that justified yesterday's charges
   * keeps saying what it said.
   */
  @Post('payers/:payerId/prices')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Fijar el precio de una prestación desde una fecha',
  })
  @ApiCreatedResponse({ type: PriceDto })
  async setPrice(
    @Param('payerId', ParseUUIDPipe) payerId: string,
    @Body() dto: SetPriceDto,
  ): Promise<PriceResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toPriceResponse(
      await this.pricing.setPrice(
        {
          payerId,
          billableServiceId: dto.billableServiceId,
          // The string never becomes a number on the way in either: `Money`
          // parses the decimal text the DTO validated.
          amount: Money.parse(dto.amount),
          effectiveFrom: dto.effectiveFrom,
        },
        requester,
      ),
    );
  }

  /**
   * D-023. Holding `billing:price-manage` somewhere is not holding it
   * everywhere, and the tariff is everywhere.
   */
  private requireClinicWide(permission: 'billing:price-manage'): Requester {
    assertClinicWideScope(this.currentUser.requirePrincipal(), permission);
    return { userId: this.currentUser.requireUserId() };
  }
}

/**
 * The service as served. The tax percentage leaves as a string (BI-001), and
 * there is still no amount on it (BI-006).
 */
function toServiceResponse(service: BillableServiceView): ServiceResponse {
  return {
    id: service.id,
    code: service.code,
    name: service.name,
    category: toCategoryResponse(service.category),
    procedureConcept: service.procedureConcept,
    tariffCode: service.tariffCode,
    taxRateId: service.taxRateId,
    taxSriCode: service.taxSriCode,
    taxPercentage: service.taxPercentage?.toString() ?? null,
    active: service.active,
    // BI-158. Which consultation this service IS, so administration can see
    // and change it instead of the mapping living only in the seed.
    specialtyId: service.specialtyId,
    visitSequence: service.visitSequence,
  };
}

/** BI-185. A category as served. */
function toCategoryResponse(
  category: ServiceCategoryView,
): ServiceCategoryResponse {
  return {
    id: category.id,
    name: category.name,
    kind: category.kind,
    active: category.active,
  };
}

/** The payer as served, field for field; nothing on a payer is money. */
function toPayerResponse(payer: PayerView): PayerResponse {
  return {
    id: payer.id,
    code: payer.code,
    name: payer.name,
    kind: payer.kind,
    ruc: payer.ruc,
    agreementReference: payer.agreementReference,
    agreementValidTo: payer.agreementValidTo,
    active: payer.active,
  };
}

/** One price row with its `[validFrom, validTo)` validity (BI-041). */
function toPriceResponse(price: PriceRow): PriceResponse {
  return {
    id: price.id,
    billableServiceId: price.billableServiceId,
    // A STRING. `JSON.parse` would turn a number back into a float and lose
    // the cent this whole module exists to keep (BI-001).
    amount: price.amount.toString(),
    validFrom: price.validFrom,
    validTo: price.validTo,
  };
}

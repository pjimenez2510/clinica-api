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
  PayerView,
  ServiceKind,
  ServiceListItem,
  ServicePriceView,
  ServiceView,
} from './domain/billing.repository';
import { Money } from './domain/money';
import type { PriceRow } from './domain/price-list';
import {
  CatalogueQueryDto,
  CreatePayerDto,
  CreateServiceDto,
  MarkTaxReviewedDto,
  MarkWrittenConsentDto,
  PayerDto,
  PayerListDto,
  PriceDto,
  PriceListResponseDto,
  ServiceDetailDto,
  ServicePriceListDto,
  ServiceDto,
  ServiceListDto,
  ServiceQueryDto,
  CorrectPriceDto,
  CorrectedPriceDto,
  SetPriceDto,
  TaxRateDto,
  UpdatePayerDto,
  UpdateServiceDto,
  type PayerResponse,
  type PriceListResponse,
  type PriceResponse,
  type ServiceDetailResponse,
  type ServiceListItemResponse,
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

  /**
   * BI-282 (D-220 §3). One page of the catalogue, filtered and ordered in the
   * database, each row with its prices in force today in every active list.
   * The selector («Agregar cargo») asks the same route for its first 20.
   */
  @Get('services')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Buscar en el catálogo de servicios, por páginas' })
  @ApiOkResponse({ type: ServiceListDto })
  async listServices(@Query() query: ServiceQueryDto): Promise<{
    items: ServiceListItemResponse[];
    total: number;
    kindCounts: { kind: ServiceKind; total: number }[];
    page: number;
    pageSize: number;
  }> {
    const page = await this.services.listServices({
      query: query.q ?? null,
      kind: query.kind ?? null,
      specialtyId: query.specialtyId ?? null,
      includeInactive: query.includeInactive,
      forTaxReview: query.forTaxReview,
      page: query.page,
      pageSize: query.pageSize,
      today: clinicalDateOf(new Date()),
    });
    return { ...page, items: page.items.map(toServiceListItemResponse) };
  }

  /** BI-283. The service's card: data, extension, analytes and prices. */
  @Get('services/:serviceId')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar la ficha de un servicio' })
  @ApiOkResponse({ type: ServiceDetailDto })
  async serviceDetail(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<ServiceDetailResponse> {
    const detail = await this.services.serviceDetail(
      serviceId,
      clinicalDateOf(new Date()),
    );
    return {
      ...toServiceResponse(detail),
      analytes: detail.analytes.map((analyte) => ({
        ...analyte,
        ranges: analyte.ranges.map((range) => ({ ...range })),
      })),
      prices: detail.prices.map(toServicePriceResponse),
    };
  }

  /** BI-280. The kind first, then only what it carries, and its price. */
  @Post('services')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear un servicio del catálogo con su precio particular' }) // prettier-ignore
  @ApiCreatedResponse({ type: ServiceDto })
  async createService(@Body() dto: CreateServiceDto): Promise<ServiceResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toServiceResponse(
      await this.services.createService(
        {
          kind: dto.kind,
          code: dto.code,
          name: dto.name,
          selfPayAmount: Money.parse(dto.selfPayAmount),
          mspCode: dto.mspCode ?? null,
          taxRateId: dto.taxRateId,
          specialtyId: dto.specialtyId,
          durationMinutes: dto.durationMinutes,
          visitKind: dto.visitKind,
          exam: dto.exam,
        },
        requester,
      ),
    );
  }

  /** BI-279, BI-281, BI-284 to BI-286, BI-025. */
  @Patch('services/:serviceId')
  @RequirePermission('billing:price-manage', 'global')
  @ApiOperation({ summary: 'Corregir un servicio del catálogo' })
  @ApiOkResponse({ type: ServiceDto })
  async updateService(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: UpdateServiceDto,
  ): Promise<ServiceResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toServiceResponse(
      await this.services.updateService(serviceId, { ...dto }, requester),
    );
  }

  /**
   * BI-256 (D-159.1, D-199.1). «Exige consentimiento 024»: the medical
   * direction's key, not the price manager's. Who and when come from the
   * session and the application's clock.
   */
  @Post('services/:serviceId/written-consent')
  @RequirePermission('record:consent-rule', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar si un servicio exige el consentimiento informado escrito (024)' }) // prettier-ignore
  @ApiOkResponse({ type: ServiceDto })
  async markWrittenConsent(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: MarkWrittenConsentDto,
  ): Promise<ServiceResponse> {
    const requester = this.requireClinicWide('record:consent-rule');
    return toServiceResponse(
      await this.services.markWrittenConsent(
        serviceId,
        dto.required,
        requester,
      ),
    );
  }

  /**
   * BI-024. «Revisé el IVA de este servicio»: who and when, from the
   * session and the application's clock, of the rate in the body —the one
   * the reviewer saw—, or 409 `TAX_REVIEW_RATE_CHANGED` if it is no longer
   * the service's. Changing the rate afterwards makes it pending again
   * (D-172.2).
   */
  @Post('services/:serviceId/tax-review')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar revisado el IVA de un servicio' }) // prettier-ignore
  @ApiOkResponse({ type: ServiceDto })
  async markTaxReviewed(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: MarkTaxReviewedDto,
  ): Promise<ServiceResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toServiceResponse(
      await this.services.markTaxReviewed(serviceId, dto.taxRateId, requester),
    );
  }

  /** BI-189. The service's prices in every payer's list, the one in force marked. */
  @Get('services/:serviceId/prices')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar los precios de un servicio en todas las listas' }) // prettier-ignore
  @ApiOkResponse({ type: ServicePriceListDto })
  async servicePrices(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<{ items: ServicePriceResponse[] }> {
    const items = await this.services.servicePrices(
      serviceId,
      clinicalDateOf(new Date()),
    );
    return { items: items.map(toServicePriceResponse) };
  }

  /** BI-012. */
  @Delete('services/:serviceId')
  @RequirePermission('billing:price-manage', 'global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirar un servicio que nadie ha usado' })
  @ApiNoContentResponse()
  async deleteService(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<void> {
    const requester = this.requireClinicWide('billing:price-manage');
    await this.services.deleteService(serviceId, requester);
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
    summary: 'Fijar el precio de un servicio desde una fecha',
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
          serviceId: dto.serviceId,
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
   * BI-230. «Editar» a mistyped amount, in place and with version. The row
   * before the correction is kept by the base (`record_version`).
   */
  @Patch('prices/:priceId')
  @RequirePermission('billing:price-manage', 'global')
  @ApiOperation({
    summary: 'Corregir el importe de un precio vigente o futuro',
  })
  @ApiOkResponse({ type: CorrectedPriceDto })
  async correctPrice(
    @Param('priceId', ParseUUIDPipe) priceId: string,
    @Body() dto: CorrectPriceDto,
  ): Promise<PriceResponse> {
    const requester = this.requireClinicWide('billing:price-manage');
    return toPriceResponse(
      await this.pricing.correctPrice(
        priceId,
        Money.parse(dto.amount),
        requester,
      ),
    );
  }

  /**
   * D-023. Holding `billing:price-manage` somewhere is not holding it
   * everywhere, and the tariff is everywhere.
   */
  private requireClinicWide(
    permission: 'billing:price-manage' | 'record:consent-rule',
  ): Requester {
    assertClinicWideScope(this.currentUser.requirePrincipal(), permission);
    return { userId: this.currentUser.requireUserId() };
  }
}

/**
 * The service as served. The tax percentage leaves as a string (BI-001), and
 * there is still no amount on it (BI-006).
 */
function toServiceResponse(service: ServiceView): ServiceResponse {
  return {
    id: service.id,
    code: service.code,
    name: service.name,
    kind: service.kind,
    consultation: service.consultation && { ...service.consultation },
    exam: service.exam && { ...service.exam },
    mspCode: service.mspCode,
    taxRateId: service.taxRateId,
    taxSriCode: service.taxSriCode,
    taxPercentage: service.taxPercentage?.toString() ?? null,
    active: service.active,
    writtenConsent: {
      required: service.writtenConsent.required,
      setAt: service.writtenConsent.setAt?.toISOString() ?? null,
      setBy:
        service.writtenConsent.setById === null
          ? null
          : {
              id: service.writtenConsent.setById,
              name: service.writtenConsent.setByName ?? '',
            },
    },
    taxReview:
      service.taxReview === null
        ? null
        : {
            reviewedAt: service.taxReview.reviewedAt.toISOString(),
            reviewedBy: {
              id: service.taxReview.reviewedById,
              name: service.taxReview.reviewedByName,
            },
          },
  };
}

/** BI-282. A row of the list: the service and its prices in force today. */
function toServiceListItemResponse(
  item: ServiceListItem,
): ServiceListItemResponse {
  return {
    ...toServiceResponse(item),
    prices: item.prices.map((price) => ({
      priceListId: price.priceListId,
      payerId: price.payerId,
      priceId: price.priceId,
      amount: price.amount.toString(),
      validFrom: price.validFrom,
    })),
  };
}

/** BI-189. One price of the service in one payer's list. */
function toServicePriceResponse(
  price: ServicePriceView & { inForce: boolean },
): ServicePriceResponse {
  return {
    priceId: price.priceId,
    payer: price.payer,
    amount: price.amount.toString(),
    validFrom: price.validFrom,
    validTo: price.validTo,
    inForce: price.inForce,
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
    serviceId: price.serviceId,
    // A STRING. `JSON.parse` would turn a number back into a float and lose
    // the cent this whole module exists to keep (BI-001).
    amount: price.amount.toString(),
    validFrom: price.validFrom,
    validTo: price.validTo,
  };
}

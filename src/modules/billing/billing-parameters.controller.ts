import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { assertClinicWideScope } from '../../shared/authorisation/site-scope';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { BillingParametersService } from './application/billing-parameters.service';
import type { Requester } from './application/service-catalogue.service';
import type {
  DiscountLimitView,
  LastChange,
  PaymentMethodView,
} from './domain/billing-parameters.repository';
import { CatalogueQueryDto } from './dto/billing.dto';
import {
  CreatePaymentMethodDto,
  DiscountLimitDto,
  DiscountLimitListDto,
  PaymentMethodDto,
  PaymentMethodListDto,
  SetDiscountLimitDto,
  UpdatePaymentMethodDto,
  type DiscountLimitResponse,
  type PaymentMethodResponse,
} from './dto/billing-parameters.dto';

/**
 * B7 — what the clinic changes without a deploy (BI-140 to BI-147).
 *
 * `global`, like the rest of the catalogue: how the clinic gets paid and how
 * much a role may discount are the CLINIC'S, not a site's, and the writes
 * back that up with `assertClinicWideScope` (D-023).
 *
 * READING THE PAYMENT METHODS IS `billing:read` because the cashier needs the
 * list to issue (BI-145); WRITING IS `settings:manage`, which the cashier
 * does not carry. The discount limits are `settings:read` to read: the cashier
 * has no business with another role's ceiling.
 */
@ApiTags('billing')
@Controller({ path: 'billing', version: '1' })
export class BillingParametersController {
  constructor(
    private readonly parameters: BillingParametersService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** BI-100, BI-145. */
  @Get('payment-methods')
  @RequirePermission('billing:read', 'global')
  @ApiOperation({ summary: 'Consultar los medios de pago' })
  @ApiOkResponse({ type: PaymentMethodListDto })
  async listPaymentMethods(
    @Query() query: CatalogueQueryDto,
  ): Promise<{ items: PaymentMethodResponse[] }> {
    const items = await this.parameters.listPaymentMethods({
      includeInactive: query.includeInactive,
    });
    return { items: items.map(toPaymentMethodResponse) };
  }

  /** BI-140, BI-144, BI-147. */
  @Post('payment-methods')
  @RequirePermission('settings:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Dar de alta un medio de pago' })
  @ApiCreatedResponse({ type: PaymentMethodDto })
  async createPaymentMethod(
    @Body() dto: CreatePaymentMethodDto,
  ): Promise<PaymentMethodResponse> {
    return toPaymentMethodResponse(
      await this.parameters.createPaymentMethod(
        { name: dto.name, sriCode: dto.sriCode },
        this.requireClinicWide(),
      ),
    );
  }

  /** BI-144, BI-146, BI-147. */
  @Patch('payment-methods/:paymentMethodId')
  @RequirePermission('settings:manage', 'global')
  @ApiOperation({ summary: 'Renombrar o desactivar un medio de pago' })
  @ApiOkResponse({ type: PaymentMethodDto })
  async updatePaymentMethod(
    @Param('paymentMethodId', ParseUUIDPipe) paymentMethodId: string,
    @Body() dto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethodResponse> {
    return toPaymentMethodResponse(
      await this.parameters.updatePaymentMethod(
        paymentMethodId,
        { name: dto.name, sriCode: dto.sriCode, active: dto.active },
        this.requireClinicWide(),
      ),
    );
  }

  /** BI-141. */
  @Get('discount-limits')
  @RequirePermission('settings:read', 'global')
  @ApiOperation({ summary: 'Consultar el límite de descuento de cada rol' })
  @ApiOkResponse({ type: DiscountLimitListDto })
  async listDiscountLimits(): Promise<{ items: DiscountLimitResponse[] }> {
    const items = await this.parameters.listDiscountLimits();
    return { items: items.map(toDiscountLimitResponse) };
  }

  /** BI-141, BI-142, BI-147. */
  @Put('discount-limits/:roleId')
  @RequirePermission('settings:manage', 'global')
  @ApiOperation({ summary: 'Asignar el límite de descuento de un rol' })
  @ApiOkResponse({ type: DiscountLimitDto })
  async setDiscountLimit(
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: SetDiscountLimitDto,
  ): Promise<DiscountLimitResponse> {
    return toDiscountLimitResponse(
      await this.parameters.setDiscountLimit(
        roleId,
        dto.maxDiscountPercentage,
        this.requireClinicWide(),
      ),
    );
  }

  /** D-023. A grant confined to some sites does not set the clinic's rules. */
  private requireClinicWide(): Requester {
    assertClinicWideScope(
      this.currentUser.requirePrincipal(),
      'settings:manage',
    );
    return { userId: this.currentUser.requireUserId() };
  }
}

function toLastChange(change: LastChange | null) {
  return change === null
    ? null
    : {
        at: change.at.toISOString(),
        by: { id: change.byId, name: change.byName },
      };
}

function toPaymentMethodResponse(
  method: PaymentMethodView,
): PaymentMethodResponse {
  return {
    id: method.id,
    name: method.name,
    sriCode: method.sriCode,
    active: method.active,
    displayOrder: method.displayOrder,
    lastChange: toLastChange(method.lastChange),
  };
}

function toDiscountLimitResponse(
  limit: DiscountLimitView,
): DiscountLimitResponse {
  return {
    roleId: limit.roleId,
    roleCode: limit.roleCode,
    roleName: limit.roleName,
    roleActive: limit.roleActive,
    maxDiscountPercentage: limit.maxDiscountPercentage,
    lastChange: toLastChange(limit.lastChange),
  };
}

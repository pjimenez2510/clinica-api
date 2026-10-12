import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { AnnouncesChange } from '../../shared/events/announces-change';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { toEntryResponse } from './agenda-entry.response';
import { type BoardViewer, BoardService } from './application/board.service';
import { rolesShapingBoard } from './domain/board';
import { AgendaSitesDto, type AgendaSitesResponse } from './dto/agenda.dto';
import {
  BOARD_FIELD_CATALOGUE,
  BoardNoteDto,
  type BoardNoteResponse,
  BoardViewDto,
  type BoardViewResponse,
  BoardViewsDto,
  type BoardViewsResponse,
  PublicBoardDto,
  type PublicBoardResponse,
  ReplaceBoardViewDto,
  SetBoardNoteDto,
  StaffBoardDto,
  StaffBoardQueryDto,
  type StaffBoardResponse,
} from './dto/board.dto';

/**
 * The day board (E9): its two projections, its note, and its views per role.
 *
 * TWO ROUTES, TWO PERMISSIONS, NO SWITCH (AG-136). The waiting-room screen
 * signs in with a role that holds `agenda:board:public` and nothing else, so
 * it cannot read the staff projection even with the URL changed by hand.
 *
 * Rooted at `agenda` and not at `agenda/sites/:siteId` because two of its
 * routes have no site: the waiting room's site list, and the views, which
 * belong to roles.
 */
@ApiTags('agenda')
@Controller({ path: 'agenda', version: '1' })
export class BoardController {
  constructor(
    private readonly board: BoardService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * AG-133 to AG-135, AG-138, AG-139. The staff projection of one day.
   * Audited ONCE per request, never per row (AG-139, SC-004).
   */
  @Get('sites/:siteId/board')
  @RequirePermission('agenda:read', 'param:siteId')
  @ApiOperation({ summary: 'Tablero del día de una sede, para el personal' })
  @ApiOkResponse({ type: StaffBoardDto })
  async staffBoard(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: StaffBoardQueryDto,
    @Req() req: Request,
  ): Promise<StaffBoardResponse> {
    const board = await this.board.staffBoard(
      {
        siteId,
        date: query.date,
        practitionerId: query.practitionerId,
        specialtyId: query.specialtyId,
      },
      this.viewer(req, 'agenda:read', siteId),
    );

    return {
      siteId,
      date: query.date,
      fields: board.fields,
      generatedAt: board.generatedAt.toISOString(),
      items: board.rows.map((row) => ({
        ...toEntryResponse(row.entry),
        practitionerName: row.practitionerName,
        roomName: row.roomName,
        boardNote: row.boardNote,
        boardNoteStamp: row.boardNoteStamp
          ? {
              byName: row.boardNoteStamp.byName,
              at: row.boardNoteStamp.at.toISOString(),
            }
          : null,
        stateSince: row.stateSince?.toISOString() ?? null,
        minutesInState: row.minutesInState,
        latenessMinutes: row.latenessMinutes,
        emergencyNeedsInPersonNotice: row.emergencyNeedsInPersonNotice,
        boardNoteEditable: row.boardNoteEditable,
      })),
    };
  }

  /**
   * AG-136, AG-137, AG-139. The waiting-room projection, today only.
   *
   * BUILT FIELD BY FIELD from a row that never loaded anything else: nothing
   * of the record can travel by accident.
   */
  @Get('sites/:siteId/board/public')
  @RequirePermission('agenda:board:public', 'param:siteId')
  @ApiOperation({ summary: 'Pantalla de la sala de espera de una sede' })
  @ApiOkResponse({ type: PublicBoardDto })
  async publicBoard(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Req() req: Request,
  ): Promise<PublicBoardResponse> {
    const board = await this.board.publicBoard(
      siteId,
      this.viewer(req, 'agenda:board:public', siteId),
    );
    return {
      siteId,
      date: board.date,
      generatedAt: board.generatedAt.toISOString(),
      items: board.rows.map((row) => ({
        startsAt: row.startsAt.toISOString(),
        displayName: row.displayName,
        practitionerName: row.practitionerName,
        roomName: row.roomName,
        state: row.state,
      })),
    };
  }

  /**
   * AG-136. The sites the waiting-room screen may show. Its own route because
   * that role does not hold `agenda:read`, which `/agenda/sites` asks for.
   */
  @Get('board/public/sites')
  @RequirePermission('agenda:board:public', 'query')
  @ApiOperation({ summary: 'Sedes de la pantalla de la sala de espera' })
  @ApiOkResponse({ type: AgendaSitesDto })
  async publicSites(): Promise<AgendaSitesResponse> {
    const scope = this.currentUser
      .requirePrincipal()
      .sitesFor('agenda:board:public');
    const items = await this.board.publicSites(
      scope === ALL_SITES ? 'all' : scope,
    );
    return { items };
  }

  /** AG-176. The short note of one appointment, and nothing else of it. */
  @Put('sites/:siteId/entries/:entryId/board-note')
  @RequirePermission('agenda:board:note', 'param:siteId')
  // AG-179. The staff boards show the note; the waiting room does not (AG-137).
  @AnnouncesChange('agenda')
  @ApiOperation({ summary: 'Escribir la nota corta de una cita en el tablero' })
  @ApiOkResponse({ type: BoardNoteDto })
  async setBoardNote(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: SetBoardNoteDto,
    @Req() req: Request,
  ): Promise<BoardNoteResponse> {
    const result = await this.board.setBoardNote(
      { siteId, entryId, boardNote: dto.boardNote },
      // AG-185: the trail row says from where, like every other.
      {
        userId: this.currentUser.requireUserId(),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
    );
    return {
      boardNote: result.boardNote,
      boardNoteStamp: {
        byName: result.boardNoteStamp.byName,
        at: result.boardNoteStamp.at.toISOString(),
      },
    };
  }

  /**
   * AG-138. The catalogue of fields and each role's view. Under `user:read`,
   * like the rest of a role.
   */
  @Get('board-views')
  @RequirePermission('user:read', 'global')
  @ApiOperation({ summary: 'Columnas del tablero que ve cada rol' })
  @ApiOkResponse({ type: BoardViewsDto })
  async boardViews(): Promise<BoardViewsResponse> {
    const roles = await this.board.listViews();
    return { fields: BOARD_FIELD_CATALOGUE, roles };
  }

  /** AG-138. Replaces one role's view; under `user:manage`, like its permissions. */
  @Put('board-views/:roleId')
  @RequirePermission('user:manage', 'global')
  @ApiOperation({ summary: 'Cambiar las columnas del tablero de un rol' })
  @ApiOkResponse({ type: BoardViewDto })
  async replaceBoardView(
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: ReplaceBoardViewDto,
    @Req() req: Request,
  ): Promise<BoardViewResponse> {
    const fields = await this.board.replaceView(
      { roleId, fields: dto.fields },
      {
        userId: this.currentUser.requireUserId(),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
    );
    return { roleId, fields };
  }

  /**
   * Who is looking, for the view (AG-138) and the trail (AG-139): the roles
   * held AT THIS SITE that carry the route's permission — a role granted only
   * at another site does not shape this site's board.
   *
   * `req.ip` is the real client only because `trust proxy` counts hops.
   */
  private viewer(
    req: Request,
    permission: Permission,
    siteId: string,
  ): BoardViewer {
    const principal = this.currentUser.requirePrincipal();
    return {
      userId: principal.userId,
      roleCodes: rolesShapingBoard(principal.grants, siteId, permission),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

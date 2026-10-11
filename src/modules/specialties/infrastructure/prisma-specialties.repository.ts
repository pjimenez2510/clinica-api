import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { SpecialtyInUseError } from '../domain/specialties.errors';
import type {
  SpecialtiesRepository,
  SpecialtyView,
} from '../domain/specialties.repository';
import {
  duplicateErrorFrom,
  isForeignKeyRestriction,
  isRecordNotFound,
} from './specialties-database-errors';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here, and so does every PostgreSQL refusal
 * that means something to an administrator: the functional unique indexes
 * answer as `SPECIALTY_DUPLICATE` (SP-006) and a RESTRICT foreign key on a
 * delete answers as the "in use" conflict that offers deactivation (SP-003).
 * Nothing here checks first: two administrators writing in the same
 * millisecond are arbitrated by the indexes, not by a read that was stale
 * before it returned.
 */

/**
 * The selection is the view: every column the domain shape declares and
 * nothing else.
 */
const SPECIALTY_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
} satisfies Prisma.SpecialtySelect;

/**
 * Prisma adapter for `SpecialtiesRepository`; see the header for the refusals
 * translated here.
 */
@Injectable()
export class PrismaSpecialtiesRepository implements SpecialtiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** SP-007. Ordered by name so the screen is stable between requests. */
  async listSpecialties(
    includeInactive: boolean,
  ): Promise<readonly SpecialtyView[]> {
    return this.prisma.specialty.findMany({
      where: includeInactive ? {} : { active: true },
      select: SPECIALTY_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  /** `null` for an unknown id; the service decides the refusal. */
  async findSpecialty(id: string): Promise<SpecialtyView | null> {
    return this.prisma.specialty.findUnique({
      where: { id },
      select: SPECIALTY_SELECT,
    });
  }

  /** SP-002; SP-006 answered by `specialty_code_unique`/`specialty_name_unique`. */
  async createSpecialty(input: {
    code: string;
    name: string;
  }): Promise<SpecialtyView> {
    try {
      return await this.prisma.specialty.create({
        data: input,
        select: SPECIALTY_SELECT,
      });
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /**
   * SP-006 answered by the unique indexes on code and name. `null` when the row
   * is gone.
   */
  async updateSpecialty(
    id: string,
    patch: { name?: string; active?: boolean },
  ): Promise<SpecialtyView | null> {
    try {
      // ADR-013: the specialty alone. Its consultations carry their own names
      // (BI-279), so renaming it renames no service.
      return await this.prisma.specialty.update({
        where: { id },
        data: patch,
        select: SPECIALTY_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** SP-003: the RESTRICT foreign keys have the final word. */
  async deleteSpecialty(id: string): Promise<boolean> {
    try {
      await this.prisma.specialty.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      if (isForeignKeyRestriction(error)) throw new SpecialtyInUseError();
      throw error;
    }
  }
}

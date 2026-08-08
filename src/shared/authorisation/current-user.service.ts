import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { UnauthorizedError } from '../domain/errors/domain-error';
import { CURRENT_USER } from '../http/auth.decorators';

/**
 * Reads the authenticated identity from anywhere in the request.
 *
 * IN `shared`, NOT IN `modules/auth`, for the same reason `Principal` is: every
 * business module needs to know who is asking — the patient register writes it
 * into the access trail, and the encounter module will stamp it on a signed
 * note. Leaving it inside `auth` forced `patients` to import from another
 * module, which `dependency-cruiser` refuses. It was right to: modules
 * importing each other is how a codebase stops having modules.
 *
 * The claims are read from CLS rather than passed down through every call.
 * Threading "who is asking" through six signatures is noise, and the one place
 * somebody forgets to pass it is the place the audit row goes missing.
 */
export class MissingTokenError extends UnauthorizedError {
  readonly code = 'MISSING_TOKEN';
  constructor() {
    super('No authenticated identity in this request');
  }
}

/** The subset of the token the rest of the application is allowed to see. */
export interface CurrentUser {
  /** User id. */
  sub: string;
  /** Refresh family, so a single session can be revoked. */
  fam: string;
  [claim: string]: unknown;
}

@Injectable()
export class CurrentUserService {
  constructor(private readonly cls: ClsService) {}

  get(): CurrentUser | undefined {
    return this.cls.get<CurrentUser | undefined>(CURRENT_USER);
  }

  /**
   * The user id, or a refusal.
   *
   * Throws rather than returning `null` because every caller needs it: an
   * audit entry without a user is not a weaker entry, it is a useless one.
   */
  requireUserId(): string {
    const user = this.get();
    if (!user) throw new MissingTokenError();
    return user.sub;
  }
}

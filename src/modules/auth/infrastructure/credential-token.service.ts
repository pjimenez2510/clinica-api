import { Injectable } from '@nestjs/common';

import type { CredentialTokenPort } from '../application/credential-ports';
import {
  generateCredentialToken,
  hashCredentialToken,
} from '../domain/credential-token';

/**
 * The `CredentialTokenPort` adapter (AU-021).
 *
 * THIN ON PURPOSE: what a token is — how much entropy, how it is hashed at
 * rest — is policy and lives in `domain/credential-token.ts`, for the same
 * reason `PASSWORD_HASHING` does. This class exists only to make that policy
 * injectable, and its emptiness is the point.
 *
 * ITS OWN ADAPTER AND NOT A METHOD ON `TokenService`. The two happen to want
 * the same thing today, and they are not the same secret: one is rotated every
 * few minutes inside an authenticated session, the other is mailed to somebody
 * who has never signed in. Sharing one generator would make «change how
 * refresh tokens work» and «change how invitations work» the same change.
 */
@Injectable()
export class CredentialTokenService implements CredentialTokenPort {
  generate(): { token: string; hash: string } {
    return generateCredentialToken();
  }

  hash(token: string): string {
    return hashCredentialToken(token);
  }
}

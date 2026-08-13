import type { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env.schema';
import { MailNotConfiguredError } from '../../mail/mail.errors';

import { NodemailerMailer } from './nodemailer.mailer';

/**
 * The adapter's refusal path, without an SMTP server anywhere near it.
 *
 * WHAT THIS PINS DOWN: that an installation with no `SMTP_HOST` fails AT THE
 * POINT OF USE and not at boot, and that the failure is a named domain error
 * rather than whatever nodemailer throws when asked to connect to `undefined`.
 * The difference matters to the person deploying the system: one message names
 * the variable to fill in, the other is a DNS error.
 */
function configWithout(host: string | undefined): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    SMTP_HOST: host,
    SMTP_PORT: 1025,
    SMTP_FROM: 'no-reply@clinica.local',
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<Env, true>;
}

function logger(): PinoLogger {
  return {
    setContext: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  } as unknown as PinoLogger;
}

const MESSAGE = {
  to: 'nueva@clinica.ec',
  subject: 'Active su cuenta',
  text: 'enlace',
};

describe('el adaptador de correo', () => {
  it('AU-029 se construye sin servidor de correo configurado', () => {
    // Una instalación que nunca da de alta a nadie tiene que poder arrancar.
    // Exigir `SMTP_HOST` al arrancar dejaría toda la API caída por una función
    // que esa clínica no usa.
    expect(
      () => new NodemailerMailer(configWithout(undefined), logger()),
    ).not.toThrow();
  });

  it('AU-029 rechaza con MAIL_NOT_CONFIGURED al intentar enviar sin SMTP_HOST', async () => {
    const mailer = new NodemailerMailer(configWithout(undefined), logger());

    await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(
      MailNotConfiguredError,
    );
  });

  it('AU-029 nombra la variable que falta, para quien despliega el sistema', async () => {
    const mailer = new NodemailerMailer(configWithout(undefined), logger());

    await expect(mailer.send(MESSAGE)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MailNotConfiguredError &&
        error.userTitle.includes('SMTP_HOST'),
    );
  });
});

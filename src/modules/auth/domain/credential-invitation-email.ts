import { CREDENTIAL_INVITATION_TTL_HOURS } from './credential-invitation';

/**
 * The invitation message itself (AU-021, AU-026).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO TEMPLATE ENGINE HERE, AND WHEN THERE WOULD HAVE TO BE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handlebars, MJML or `@nestjs-modules/mailer` would each add a dependency, a
 * directory of `.hbs` files, a build step to copy them into `dist/`, and a
 * whole class of failure that only appears in production — a template that
 * did not get packaged. What they buy is layout, and this system sends exactly
 * ONE message, six lines long, whose entire job is to carry a link.
 *
 * The threshold is not «when the message gets prettier». It is when there are
 * several messages sharing a header and a footer, or when somebody at the
 * clinic has to be able to edit the wording without a deploy. Neither is true
 * today, and building for either now would mean maintaining machinery for a
 * second message that does not exist.
 *
 * PLAIN TEXT IS THE MESSAGE; the HTML is its twin. Written in that order on
 * purpose: mail clients that strip HTML, screen readers and spam filters all
 * read the text part, and a link that only survives in HTML is a link some
 * recipients cannot follow.
 *
 * A PURE FUNCTION IN THE DOMAIN, so the wording can be asserted without an
 * SMTP server, and so the transport cannot quietly start deciding what the
 * clinic says to its staff.
 */

/** What the mailer sends: a plain-text body and its HTML twin. */
export interface CredentialInvitationMessage {
  subject: string;
  text: string;
  html: string;
}

/**
 * Everything the message says that is not fixed wording. The names are typed by
 * humans, which is why the HTML is escaped.
 */
export interface CredentialInvitationContent {
  /** Who is being invited, as they should be addressed. */
  recipientName: string;
  /** Who invited them. A person, so the message is not from «el sistema». */
  inviterName: string;
  /**
   * The clinic, as it calls itself. `null` on a fresh installation that has
   * not registered its establishment yet (OR-001), and the sentence has to
   * survive that — an e-mail reading «null le ha creado una cuenta» is worse
   * than one that simply does not name the clinic.
   */
  clinicName: string | null;
  /** The single-use link, already pointing at the interface. */
  link: string;
}

/**
 * Escapes the four characters that would otherwise close a tag or an
 * attribute.
 *
 * NOT paranoia about a made-up threat: `recipientName` and `inviterName` come
 * from the account form, and `clinicName` from the establishment form. Both
 * are typed by a human, and an apostrophe in «O'Brien» or an ampersand in
 * «Salud & Vida» is the ordinary case, not the attack. Without this the
 * apostrophe renders as garbage and the ampersand can swallow the rest of the
 * line, taking the link with it.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Drops a trailing full stop from a name that is about to end a sentence.
 *
 * NOT a nicety, and not hypothetical: it was caught sending a real message
 * through Mailpit. Ecuadorian legal names end in an abbreviation far more often
 * than not — «Clínica de Desarrollo S.A.», «Centro Médico Vida Cía. Ltda.» —
 * and the sentence that names the clinic ends right after it, so the message
 * read «... en el sistema de Clínica de Desarrollo S.A..». A doubled full stop
 * in the one paragraph that has to look legitimate is exactly the kind of
 * detail that makes a person treat the message as phishing.
 */
function withoutTrailingStop(name: string): string {
  return name.replace(/\.+$/, '');
}

/**
 * Builds the message, in Spanish and addressed to the person.
 *
 * WHAT IT SAYS AND WHY EACH PART IS THERE (ADR-005):
 *   - who invited them, so the message is not an anonymous link asking for a
 *     password — which is what every phishing attempt looks like;
 *   - the clinic's name, for the same reason;
 *   - what the link does, before they click it;
 *   - that it expires, with the number of hours, so «lo hago el lunes» is a
 *     decision and not a surprise;
 *   - what to do if it was not them, because the honest answer to «yo no pedí
 *     esto» is to tell somebody, not to ignore it.
 *
 * WHAT IT NEVER SAYS: anything about the account beyond its existence. No
 * roles, no cedula, no site. A mailbox is not an authenticated channel.
 */
export function buildCredentialInvitationMessage(
  content: CredentialInvitationContent,
): CredentialInvitationMessage {
  const { recipientName, inviterName, clinicName, link } = content;
  const clinic = clinicName ?? 'la clínica';

  const subject = `Active su cuenta de ${clinic}`;

  const text = [
    `Hola ${recipientName}:`,
    '',
    `${inviterName} le ha creado una cuenta en el sistema de ${withoutTrailingStop(clinic)}.`,
    'Para entrar por primera vez tiene que elegir su propia contraseña. Nadie',
    'más la conocerá, ni siquiera quien le creó la cuenta.',
    '',
    'Abra este enlace y elija su contraseña:',
    link,
    '',
    `El enlace sirve una sola vez y caduca en ${CREDENTIAL_INVITATION_TTL_HOURS} horas.`,
    'Si caduca, pida a quien administra el sistema que se lo envíe de nuevo.',
    '',
    'Si usted no esperaba este mensaje, no abra el enlace y avise a quien',
    'administra el sistema.',
  ].join('\n');

  /**
   * Deliberately styleless: no CSS, no images, no tracking pixel. Every mail
   * client renders this identically, nothing is blocked by a privacy setting,
   * and there is nothing here that could fail to load and take the link with
   * it. The link is also shown as text, because a client that does not
   * linkify it still lets somebody copy it.
   */
  const safeLink = escapeHtml(link);
  const html = [
    `<p>Hola ${escapeHtml(recipientName)}:</p>`,
    `<p>${escapeHtml(inviterName)} le ha creado una cuenta en el sistema de ${escapeHtml(withoutTrailingStop(clinic))}. Para entrar por primera vez tiene que elegir su propia contraseña. Nadie más la conocerá, ni siquiera quien le creó la cuenta.</p>`,
    `<p><a href="${safeLink}">Elegir mi contraseña</a></p>`,
    `<p>Si el enlace no funciona, cópielo en su navegador:<br>${safeLink}</p>`,
    `<p>El enlace sirve una sola vez y caduca en ${CREDENTIAL_INVITATION_TTL_HOURS} horas. Si caduca, pida a quien administra el sistema que se lo envíe de nuevo.</p>`,
    '<p>Si usted no esperaba este mensaje, no abra el enlace y avise a quien administra el sistema.</p>',
  ].join('\n');

  return { subject, text, html };
}

/**
 * Where the link points: the INTERFACE, never the API.
 *
 * The person opening it needs a form, and this API answers JSON. `clinica-web`
 * owns `/acceso/credencial`, reads the token from the query string, asks
 * `GET /auth/credential/:token` whether it is still good, and only then shows
 * the password field.
 *
 * `encodeURIComponent` because the token is base64url — which happens to
 * contain no character that needs escaping, so this is not what makes it work
 * today. It is what stops it breaking the day the token encoding changes.
 */
export function credentialInvitationLink(
  webBaseUrl: string,
  token: string,
): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  return `${base}/acceso/credencial?token=${encodeURIComponent(token)}`;
}

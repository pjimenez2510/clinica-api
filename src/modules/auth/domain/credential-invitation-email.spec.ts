import { describe, expect, it } from 'vitest';

import {
  buildCredentialInvitationMessage,
  credentialInvitationLink,
} from './credential-invitation-email';

/**
 * The first-credential invitation e-mail as a pure rendering: who invites,
 * from which clinic, where the link goes and when it expires, in both the
 * HTML and the plain-text part. Pure domain unit; cites AU-021 and AU-026.
 */

const CONTENT = {
  recipientName: 'Ana Villacís',
  inviterName: 'Gabriela Mera',
  clinicName: 'Centro Médico Santa Ana',
  link: 'http://localhost:3001/acceso/credencial?token=abc123',
};

describe('el correo de invitación', () => {
  it('AU-021 dice quién invita, desde qué clínica y a dónde ir', () => {
    // Las tres cosas juntas son lo que distingue este mensaje de un intento de
    // phishing: un enlace anónimo que pide una contraseña es exactamente lo
    // que la persona debería ignorar.
    const message = buildCredentialInvitationMessage(CONTENT);

    expect(message.text).toContain('Ana Villacís');
    expect(message.text).toContain('Gabriela Mera');
    expect(message.text).toContain('Centro Médico Santa Ana');
    expect(message.text).toContain(CONTENT.link);
    expect(message.subject).toContain('Centro Médico Santa Ana');
  });

  it('AU-026 avisa de que el enlace caduca, y en cuántas horas', () => {
    const message = buildCredentialInvitationMessage(CONTENT);

    expect(message.text).toContain('72 horas');
    expect(message.html).toContain('72 horas');
  });

  it('AU-021 sigue siendo una frase legible cuando la clínica no tiene nombre todavía', () => {
    // Una instalación recién montada no tiene establecimiento registrado
    // (OR-001). «null le ha creado una cuenta» es peor que no nombrarla.
    const message = buildCredentialInvitationMessage({
      ...CONTENT,
      clinicName: null,
    });

    expect(message.text).not.toContain('null');
    expect(message.subject).not.toContain('null');
    expect(message.text).toContain('la clínica');
  });

  it('AU-021 lleva el enlace también en el texto plano, no sólo en el HTML', () => {
    // Un cliente que quita el HTML, un lector de pantalla y un filtro de
    // correo leen la parte de texto. Un enlace que sólo sobrevive en HTML es
    // un enlace que parte de los destinatarios no puede seguir.
    const message = buildCredentialInvitationMessage(CONTENT);

    expect(message.text).toContain(CONTENT.link);
    expect(message.html).toContain(CONTENT.link);
  });

  it('AU-021 no dobla el punto cuando el nombre legal acaba en abreviatura', () => {
    // Caught sending a real message through Mailpit: «... en el sistema de
    // Clínica de Desarrollo S.A..». Los nombres legales ecuatorianos acaban en
    // abreviatura casi siempre —«S.A.», «Cía. Ltda.»— y un punto doblado en el
    // único párrafo que tiene que parecer legítimo es lo que hace que alguien
    // trate el mensaje como phishing.
    const message = buildCredentialInvitationMessage({
      ...CONTENT,
      clinicName: 'Clínica de Desarrollo S.A.',
    });

    expect(message.text).toContain('sistema de Clínica de Desarrollo S.A.');
    expect(message.text).not.toContain('S.A..');
    expect(message.html).not.toContain('S.A..');
  });

  it('AU-021 escapa los nombres antes de meterlos en el HTML', () => {
    // «Salud & Vida» y «O'Brien» son el caso corriente, no el ataque: sin
    // escapar, el ampersand se come el resto de la línea y se lleva el enlace.
    const message = buildCredentialInvitationMessage({
      ...CONTENT,
      clinicName: 'Salud & Vida <Quito>',
    });

    expect(message.html).toContain('Salud &amp; Vida &lt;Quito&gt;');
    expect(message.html).not.toContain('<Quito>');
  });

  it('AU-021 construye un enlace que apunta a la interfaz y no a la API', () => {
    // Quien lo abre necesita un formulario, y esta API responde JSON.
    expect(credentialInvitationLink('http://localhost:3001', 'abc')).toBe(
      'http://localhost:3001/acceso/credencial?token=abc',
    );
  });

  it('AU-021 no duplica la barra cuando la dirección base ya trae una', () => {
    expect(credentialInvitationLink('https://clinica.ec/', 'abc')).toBe(
      'https://clinica.ec/acceso/credencial?token=abc',
    );
  });
});

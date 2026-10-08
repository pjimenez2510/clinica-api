import { describe, expect, it } from 'vitest';

import { BOARD_FIELDS } from '../../../shared/domain/board-fields';

import {
  type BoardSubject,
  isPresentToday,
  latenessMinutes,
  minutesInState,
  normaliseBoardNote,
  publicIdentification,
  publicStateOf,
  resolveBoardFields,
  rolesShapingBoard,
  stateSinceOf,
} from './board';

/**
 * Every instant here is derived from one reference taken at run time; none is
 * written by hand. The board's arithmetic is between instants, so the
 * reference itself does not matter — only the distances do.
 */
const NOW = new Date();
const minutesBefore = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

const subject = (overrides: Partial<BoardSubject> = {}): BoardSubject => ({
  status: 'BOOKED',
  subjectStatus: null,
  subjectStatusAt: null,
  lastStatusChangeAt: minutesBefore(600),
  startsAt: minutesBefore(-30),
  checkedInAt: null,
  ...overrides,
});

describe('AG-135 el tiempo en el estado actual lo calcula el servidor', () => {
  it('AG-135 cuenta desde el último cambio del PACIENTE cuando lo hay', () => {
    const row = subject({
      status: 'CHECKED_IN',
      checkedInAt: minutesBefore(40),
      subjectStatus: 'IN_PREPARATION',
      subjectStatusAt: minutesBefore(12),
      lastStatusChangeAt: minutesBefore(40),
    });

    expect(stateSinceOf(row)).toEqual(minutesBefore(12));
    expect(minutesInState(row, NOW)).toBe(12);
  });

  it('AG-135 AG-127 cuenta desde el último cambio de la CITA mientras no hay estado de paciente', () => {
    const row = subject({
      status: 'NO_SHOW',
      lastStatusChangeAt: minutesBefore(25),
    });

    expect(stateSinceOf(row)).toEqual(minutesBefore(25));
    expect(minutesInState(row, NOW)).toBe(25);
  });

  it('AG-135 nunca devuelve minutos negativos con un reloj adelantado', () => {
    const row = subject({ lastStatusChangeAt: minutesBefore(-2) });

    expect(minutesInState(row, NOW)).toBe(0);
  });

  it('AG-135 sin ningún cambio registrado no hay tiempo que contar', () => {
    const row = subject({ lastStatusChangeAt: null });

    expect(stateSinceOf(row)).toBeNull();
    expect(minutesInState(row, NOW)).toBeNull();
  });
});

describe('AG-134 el retraso es una resta, nunca un estado', () => {
  it('AG-134 antes de la llegada, cuánto pasó de la hora', () => {
    expect(latenessMinutes(subject({ startsAt: minutesBefore(18) }), NOW)).toBe(
      18,
    );
  });

  it('AG-134 antes de la hora no hay retraso', () => {
    expect(
      latenessMinutes(subject({ startsAt: minutesBefore(-10) }), NOW),
    ).toBeNull();
  });

  it('AG-134 tras la llegada, el retraso de la llegada y no el de ahora', () => {
    const row = subject({
      status: 'CHECKED_IN',
      startsAt: minutesBefore(60),
      checkedInAt: minutesBefore(45),
    });

    expect(latenessMinutes(row, NOW)).toBe(15);
  });

  it('AG-134 quien llegó antes de su hora no lleva retraso', () => {
    const row = subject({
      status: 'CHECKED_IN',
      startsAt: minutesBefore(5),
      checkedInAt: minutesBefore(20),
    });

    expect(latenessMinutes(row, NOW)).toBeNull();
  });

  it('AG-134 una cita cerrada sin llegada no acumula retraso', () => {
    const row = subject({ status: 'NO_SHOW', startsAt: minutesBefore(90) });

    expect(latenessMinutes(row, NOW)).toBeNull();
  });
});

describe('AG-138 cada rol ve su conjunto de campos', () => {
  const views = [
    { roleCode: 'RECEPCION', field: 'PRACTITIONER' },
    { roleCode: 'RECEPCION', field: 'BOARD_NOTE' },
    { roleCode: 'ENFERMERIA', field: 'ROOM' },
    { roleCode: 'ENFERMERIA', field: 'BOARD_NOTE' },
  ] as const;

  it('AG-138 dos roles distintos reciben conjuntos distintos', () => {
    expect(resolveBoardFields(['RECEPCION'], views)).toEqual([
      'PRACTITIONER',
      'BOARD_NOTE',
    ]);
    expect(resolveBoardFields(['ENFERMERIA'], views)).toEqual([
      'ROOM',
      'BOARD_NOTE',
    ]);
  });

  it('AG-138 quien lleva dos roles ve la unión, en el orden del catálogo', () => {
    expect(resolveBoardFields(['ENFERMERIA', 'RECEPCION'], views)).toEqual([
      'PRACTITIONER',
      'ROOM',
      'BOARD_NOTE',
    ]);
  });

  it('AG-138 cerrado por defecto: un rol sin vista no ve ningún campo opcional', () => {
    expect(resolveBoardFields(['CAJA'], views)).toEqual([]);
  });

  it('AG-138 un campo que el código no conoce no se sirve aunque esté en la base', () => {
    expect(
      resolveBoardFields(
        ['RECEPCION'],
        [{ roleCode: 'RECEPCION', field: 'DIAGNOSIS' }],
      ),
    ).toEqual([]);
  });

  it('AG-138 el catálogo de campos no incluye lo que no se puede quitar', () => {
    expect(BOARD_FIELDS).not.toContain('PATIENT');
    expect(BOARD_FIELDS).not.toContain('EMERGENCY');
    expect(BOARD_FIELDS).not.toContain('STATUS');
  });
});

describe('AG-137 la proyección pública identifica lo justo para llamar', () => {
  it('AG-137 primer nombre e inicial del primer apellido', () => {
    expect(publicIdentification('María José', 'Andrade López')).toBe(
      'María A.',
    );
  });

  it('AG-137 recorta espacios y no inventa una inicial que no existe', () => {
    expect(publicIdentification('  Rosa ', '')).toBe('Rosa');
  });

  it('AG-137 la inicial va en mayúscula aunque el registro no lo esté', () => {
    expect(publicIdentification('luis', 'de la Torre')).toBe('Luis D.');
  });

  it('AG-137 sólo están presentes quienes llegaron y no se han ido ni salido', () => {
    const arrived = subject({ status: 'CHECKED_IN', subjectStatus: 'ARRIVED' });
    const inCare = subject({
      status: 'IN_PROGRESS',
      subjectStatus: 'RECEIVING_CARE',
    });
    const onLeave = subject({
      status: 'IN_PROGRESS',
      subjectStatus: 'ON_LEAVE',
    });
    const departed = subject({
      status: 'FULFILLED',
      subjectStatus: 'DEPARTED',
    });
    const booked = subject({ status: 'BOOKED' });
    const confirmed = subject({ status: 'CONFIRMED' });
    const left = subject({
      status: 'LEFT_WITHOUT_BEING_SEEN',
      subjectStatus: 'DEPARTED',
    });

    expect([arrived, inCare].every(isPresentToday)).toBe(true);
    expect(
      [onLeave, departed, booked, confirmed, left].some(isPresentToday),
    ).toBe(false);
  });

  it('AG-137 el estado público es grueso: en sala, en preparación o en atención', () => {
    expect(
      publicStateOf(
        subject({ status: 'CHECKED_IN', subjectStatus: 'ARRIVED' }),
      ),
    ).toBe('WAITING');
    expect(
      publicStateOf(subject({ status: 'CHECKED_IN', subjectStatus: 'READY' })),
    ).toBe('WAITING');
    expect(
      publicStateOf(subject({ status: 'CHECKED_IN', subjectStatus: null })),
    ).toBe('WAITING');
    expect(
      publicStateOf(
        subject({ status: 'CHECKED_IN', subjectStatus: 'IN_PREPARATION' }),
      ),
    ).toBe('IN_PREPARATION');
    expect(
      publicStateOf(
        subject({ status: 'IN_PROGRESS', subjectStatus: 'RECEIVING_CARE' }),
      ),
    ).toBe('IN_CARE');
    expect(
      publicStateOf(subject({ status: 'IN_PROGRESS', subjectStatus: null })),
    ).toBe('IN_CARE');
  });
});

describe('AG-176 la nota corta se guarda limpia', () => {
  it('AG-176 recorta los espacios de los extremos', () => {
    expect(normaliseBoardNote('  Espera a su hija ')).toBe('Espera a su hija');
  });

  it('AG-176 en blanco la vacía', () => {
    expect(normaliseBoardNote('   ')).toBeNull();
    expect(normaliseBoardNote(null)).toBeNull();
  });
});

describe('AG-138 qué roles dan forma al tablero de una sede', () => {
  const grants = [
    { roleCode: 'RECEPCION', siteId: 'site-a', permissions: ['agenda:read'] },
    { roleCode: 'ENFERMERIA', siteId: 'site-b', permissions: ['agenda:read'] },
    { roleCode: 'MEDICO', siteId: null, permissions: ['agenda:read'] },
    { roleCode: 'CAJA', siteId: 'site-a', permissions: ['billing:read'] },
  ];

  it('AG-138 los de esta sede y los globales, nunca los de otra sede', () => {
    expect(rolesShapingBoard(grants, 'site-a', 'agenda:read')).toEqual([
      'RECEPCION',
      'MEDICO',
    ]);
  });

  it('AG-138 sólo los que llevan el permiso de la ruta', () => {
    expect(rolesShapingBoard(grants, 'site-a', 'agenda:board:public')).toEqual(
      [],
    );
  });

  it('AG-137 sin nombre no queda un espacio delante de la inicial', () => {
    expect(publicIdentification('', 'Andrade')).toBe('A.');
  });
});

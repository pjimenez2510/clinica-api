import { registerConstraintMeanings } from '../../../shared/http/constraint-meanings';

/**
 * What the base's refusals mean to the person at the screen, for the CHECKs of
 * `20261001034254_privacy_consent_and_requests` that a request can reach when
 * it slips past the service's own checks (a clock skew, a race). The codes are
 * the ones the SPEC fixes, so the client branches the same either way.
 */
registerConstraintMeanings({
  data_subject_request_received_not_future: {
    code: 'DATA_REQUEST_RECEIVED_IN_FUTURE',
    field: 'receivedAt',
    message: 'La fecha de recepción no puede ser posterior a este momento',
  },
  privacy_notice_version_body_valid: {
    code: 'PRIVACY_NOTICE_INVALID',
    field: 'body',
    message: 'Escriba el aviso de privacidad (hasta 20 000 caracteres)',
  },
  patient_authorization_channel_matches_purpose: {
    code: 'PRIVACY_AUTHORIZATION_INVALID',
    field: 'channel',
    message:
      'Los recordatorios y la publicidad van por WhatsApp o por correo; lo demás, sin canal',
  },
});

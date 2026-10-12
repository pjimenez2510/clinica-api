/**
 * PR-060 to PR-067, PR-114. The allergy rule lives in `shared/clinical/`
 * since D2: the assistant checks the lines it proposes with the SAME
 * functions the issue does (AS-069), and no module imports another.
 */
export * from '../../../shared/clinical/allergy-match';

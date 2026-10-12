/**
 * PR-101 to PR-104, PR-115. The vocabulary lives in `shared/clinical/` since
 * D2: the assistant proposes lines in the same codes the receta stores
 * (AS-063), and no module imports another.
 */
export * from '../../../shared/clinical/prescription-vocabulary';

import { ValidationError } from '../public/validation.js';
export { validateCatalog } from '../public/catalog-validation.js';

export function validateRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > Number.MAX_SAFE_INTEGER) throw new ValidationError('版本號不正確');
}

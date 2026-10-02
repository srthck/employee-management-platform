import CompensationComponent from '../models/CompensationComponent.js';
import CompensationVersion from '../models/CompensationVersion.js';
import auditService from './auditService.js';
import { runInTransaction } from '../utils/transaction.js';
import { httpError } from './employeeScope.js';
import {
  COMPONENT_TYPES,
  RECURRENCES,
  CALCULATION_METHODS,
  TAX_TREATMENTS,
  WAGE_TREATMENTS,
  CTC_TREATMENTS,
  PAYSLIP_TREATMENTS,
  COMPONENT_CODE_PATTERN,
  DEFAULT_COMPONENTS,
  payrollApplicationFor,
  validateFormula,
} from '../utils/compensation.js';

/**
 * compensationComponentService — the company's component catalogue.
 *
 * Components describe what a pay component IS. Statutory components are seeded
 * by PayGuard and marked system-managed: their amounts always come from
 * versioned compliance rules, never from the catalogue.
 *
 * Definitions are versioned: an update closes the current version and appends
 * the next one, so compensation versions always name the exact definition used.
 */

const TREATMENT_VALUES = {
  taxable: TAX_TREATMENTS,
  pfWage: WAGE_TREATMENTS,
  esiWage: WAGE_TREATMENTS,
  ptWage: WAGE_TREATMENTS,
  ctc: CTC_TREATMENTS,
  payslip: PAYSLIP_TREATMENTS,
};

export const componentView = (component) => ({
  id: String(component._id),
  code: component.code,
  name: component.name,
  description: component.description,
  type: component.type,
  recurrence: component.recurrence,
  calculationMethod: component.calculationMethod,
  defaultBasis: component.defaultBasis,
  treatments: {
    taxable: component.treatments.taxable,
    pfWage: component.treatments.pfWage,
    esiWage: component.treatments.esiWage,
    ptWage: component.treatments.ptWage,
    ctc: component.treatments.ctc,
    payslip: component.treatments.payslip,
  },
  statutory: component.statutory,
  payrollApplication: component.payrollApplication,
  isArchived: component.isArchived,
  version: component.version,
  updatedAt: component.updatedAt,
});

/** Validate an incoming definition; returns the normalized fields. */
function validateDefinition(payload, { existing = null } = {}) {
  const errors = [];
  const code = existing ? existing.code : String(payload.code || '').trim().toUpperCase();
  if (!existing && !COMPONENT_CODE_PATTERN.test(code)) {
    errors.push({ field: 'code', message: 'A component code is 2–40 characters: capitals, digits and underscores.' });
  }

  const name = payload.name !== undefined ? String(payload.name).trim() : existing?.name;
  if (!name || name.length < 2 || name.length > 80) {
    errors.push({ field: 'name', message: 'Name must be 2 to 80 characters.' });
  }

  const type = payload.type ?? existing?.type;
  if (!COMPONENT_TYPES.includes(type)) {
    errors.push({ field: 'type', message: `Type must be one of: ${COMPONENT_TYPES.join(', ')}.` });
  }

  const recurrence = payload.recurrence ?? existing?.recurrence ?? 'RECURRING';
  if (!RECURRENCES.includes(recurrence)) {
    errors.push({ field: 'recurrence', message: `Recurrence must be one of: ${RECURRENCES.join(', ')}.` });
  }

  const calculationMethod = payload.calculationMethod ?? existing?.calculationMethod ?? 'FIXED_AMOUNT';
  if (!CALCULATION_METHODS.includes(calculationMethod)) {
    errors.push({ field: 'calculationMethod', message: `Calculation method must be one of: ${CALCULATION_METHODS.join(', ')}.` });
  }
  if (calculationMethod === 'STATUTORY') {
    errors.push({ field: 'calculationMethod', message: 'STATUTORY components are system-managed and cannot be created or edited.' });
  }

  const treatments = { ...(existing?.treatments?.toObject?.() ?? existing?.treatments ?? {}) };
  for (const [field, allowed] of Object.entries(TREATMENT_VALUES)) {
    const value = payload.treatments?.[field];
    if (value === undefined) continue;
    if (!allowed.includes(value)) {
      errors.push({ field: `treatments.${field}`, message: `${field} must be one of: ${allowed.join(', ')}.` });
    } else {
      treatments[field] = value;
    }
  }

  let defaultBasis = payload.defaultBasis === undefined ? existing?.defaultBasis ?? null : payload.defaultBasis;
  if (defaultBasis !== null && typeof defaultBasis === 'object') {
    if (defaultBasis.percentage !== undefined && (!Number.isFinite(defaultBasis.percentage) || defaultBasis.percentage < 0 || defaultBasis.percentage > 100)) {
      errors.push({ field: 'defaultBasis.percentage', message: 'A percentage must be between 0 and 100.' });
    }
    if (defaultBasis.amount !== undefined && (!Number.isFinite(defaultBasis.amount) || defaultBasis.amount < 0)) {
      errors.push({ field: 'defaultBasis.amount', message: 'An amount cannot be negative.' });
    }
    if (defaultBasis.formula) {
      try {
        validateFormula(defaultBasis.formula, {});
      } catch (err) {
        errors.push({ field: 'defaultBasis.formula', message: err.message });
      }
    }
  } else if (defaultBasis !== null) {
    defaultBasis = null;
  }

  const description = payload.description === undefined
    ? existing?.description ?? null
    : (payload.description === null ? null : String(payload.description).trim().slice(0, 400) || null);

  if (errors.length > 0) throw httpError(422, 'VALIDATION_FAILED', 'Validation failed', { errors });

  return {
    code,
    name,
    description,
    type,
    recurrence,
    calculationMethod,
    defaultBasis,
    treatments,
    statutory: false,
    payrollApplication: payrollApplicationFor({ type, recurrence, statutory: false }),
  };
}

const auditComponent = (action, component, actor, companyId, meta, session) => auditService.log({
  action,
  actorId: actor.id,
  actorEmail: actor.email,
  actorRole: actor.role,
  entityType: 'COMPENSATION_COMPONENT',
  entityId: component._id,
  companyId,
  meta: { code: component.code, version: component.version, ...meta },
}, session);

const compensationComponentService = {
  /**
   * Create any missing default components for a company. Runs at registration
   * and in the migration; safe to call repeatedly.
   */
  async seedDefaults(companyId, actor, session = null) {
    const existing = await CompensationComponent.find({ companyId, isCurrent: true })
      .select('code').session(session).lean();
    const present = new Set(existing.map((component) => component.code));
    const missing = DEFAULT_COMPONENTS.filter((component) => !present.has(component.code));
    if (missing.length === 0) return [];

    const documents = missing.map((component) => ({
      ...component,
      companyId,
      version: 1,
      isCurrent: true,
      recordedBy: actor.id,
      recordedByEmail: actor.email || null,
    }));
    return CompensationComponent.create(documents, { session, ordered: true });
  },

  async list(companyId, { includeArchived = false } = {}) {
    const filter = { companyId, isCurrent: true };
    if (!includeArchived) filter.isArchived = false;
    const components = await CompensationComponent.find(filter).sort({ type: 1, code: 1 }).lean();
    return { components: components.map(componentView) };
  },

  /** Current, usable components as a Map keyed by code. */
  async catalogueMap(companyId, session = null) {
    const components = await CompensationComponent.find({ companyId, isCurrent: true, isArchived: false })
      .session(session).lean();
    return new Map(components.map((component) => [component.code, component]));
  },

  async create(companyId, actor, payload) {
    const definition = validateDefinition(payload);
    return runInTransaction(async (session) => {
      const clash = await CompensationComponent.exists({ companyId, code: definition.code, isCurrent: true }).session(session);
      if (clash) throw httpError(409, 'COMPONENT_CODE_IN_USE', `A component with code ${definition.code} already exists.`);

      const [component] = await CompensationComponent.create([{
        ...definition,
        companyId,
        version: 1,
        recordedBy: actor.id,
        recordedByEmail: actor.email || null,
      }], { session });

      await auditComponent('COMPENSATION_COMPONENT_CREATED', component, actor, companyId, { type: component.type }, session);
      return componentView(component.toObject());
    }, { label: 'compensation.component.create' });
  },

  /** Change semantics by appending a new definition version. */
  async update(companyId, actor, code, payload) {
    return runInTransaction(async (session) => {
      const current = await CompensationComponent.findOne({ companyId, code: String(code).toUpperCase(), isCurrent: true }).session(session);
      if (!current) throw httpError(404, 'NOT_FOUND', 'Component not found.');
      if (current.statutory) {
        throw httpError(409, 'COMPONENT_SYSTEM_MANAGED', 'Statutory components are system-managed: their amounts come from compliance rules.');
      }

      const definition = validateDefinition(payload, { existing: current });
      const changedFields = ['name', 'description', 'type', 'recurrence', 'calculationMethod'].filter(
        (field) => JSON.stringify(definition[field]) !== JSON.stringify(current[field])
      );
      const changedTreatments = Object.keys(TREATMENT_VALUES).filter(
        (field) => definition.treatments[field] !== current.treatments[field]
      );
      if (changedFields.length === 0 && changedTreatments.length === 0
        && JSON.stringify(definition.defaultBasis) === JSON.stringify(current.defaultBasis)) {
        throw httpError(422, 'NO_CHANGE', 'The submitted definition matches the current one.');
      }

      current.isCurrent = false;
      current.supersededAt = new Date();
      await current.save({ session });

      const [component] = await CompensationComponent.create([{
        ...definition,
        companyId,
        isArchived: current.isArchived,
        version: current.version + 1,
        recordedBy: actor.id,
        recordedByEmail: actor.email || null,
      }], { session });

      await auditComponent('COMPENSATION_COMPONENT_UPDATED', component, actor, companyId, {
        changedFields: [...changedFields, ...changedTreatments.map((field) => `treatments.${field}`)],
        previousVersion: current.version,
      }, session);

      return componentView(component.toObject());
    }, { label: 'compensation.component.update' });
  },

  /** Archive a component so it can no longer be added to compensation. */
  async archive(companyId, actor, code) {
    return runInTransaction(async (session) => {
      const current = await CompensationComponent.findOne({ companyId, code: String(code).toUpperCase(), isCurrent: true }).session(session);
      if (!current) throw httpError(404, 'NOT_FOUND', 'Component not found.');
      if (current.statutory) throw httpError(409, 'COMPONENT_SYSTEM_MANAGED', 'Statutory components cannot be archived.');
      if (current.isArchived) throw httpError(422, 'NO_CHANGE', 'This component is already archived.');

      const inUse = await CompensationVersion.exists({ companyId, isCurrent: true, 'lines.componentCode': current.code }).session(session);
      if (inUse) {
        throw httpError(409, 'COMPONENT_IN_USE', 'This component is part of current employee compensation. Remove it there first.');
      }

      current.isCurrent = false;
      current.supersededAt = new Date();
      await current.save({ session });

      const [component] = await CompensationComponent.create([{
        companyId,
        code: current.code,
        name: current.name,
        description: current.description,
        type: current.type,
        recurrence: current.recurrence,
        calculationMethod: current.calculationMethod,
        defaultBasis: current.defaultBasis,
        treatments: current.treatments,
        statutory: current.statutory,
        payrollApplication: current.payrollApplication,
        isArchived: true,
        version: current.version + 1,
        recordedBy: actor.id,
        recordedByEmail: actor.email || null,
      }], { session });

      await auditComponent('COMPENSATION_COMPONENT_ARCHIVED', component, actor, companyId, {}, session);
      return componentView(component.toObject());
    }, { label: 'compensation.component.archive' });
  },
};

export default compensationComponentService;

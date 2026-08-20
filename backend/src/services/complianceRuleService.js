import mongoose from 'mongoose';
import ComplianceRuleVersion from '../models/ComplianceRuleVersion.js';

const complianceRuleService = {
  async listRules({ ruleType, jurisdiction, limit = 50, skip = 0 } = {}) {
    const filter = {};
    if (ruleType) filter.ruleType = ruleType.toUpperCase();
    if (jurisdiction) filter.jurisdiction = jurisdiction.toUpperCase();
    const [rules, total] = await Promise.all([
      ComplianceRuleVersion.find(filter).sort({ ruleType: 1, jurisdiction: 1, effectiveFrom: -1 }).skip(Number(skip)).limit(Number(limit)).lean(),
      ComplianceRuleVersion.countDocuments(filter),
    ]);
    return { rules, total, limit: Number(limit), skip: Number(skip) };
  },

  async getRule(id) {
    if (!mongoose.isValidObjectId(id)) throw Object.assign(new Error('Rule not found.'), { statusCode: 404 });
    const rule = await ComplianceRuleVersion.findById(id).lean();
    if (!rule) throw Object.assign(new Error('Rule not found.'), { statusCode: 404 });
    return rule;
  },
};

export default complianceRuleService;

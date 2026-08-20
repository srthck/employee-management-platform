import complianceRuleService from '../services/complianceRuleService.js';

export const listRules = async (req, res) => {
  const result = await complianceRuleService.listRules(req.query);
  return res.status(200).json({ success: true, data: result });
};

export const getRule = async (req, res) => {
  const rule = await complianceRuleService.getRule(req.params.id);
  return res.status(200).json({ success: true, data: { rule } });
};

import payrollSnapshotRepository from '../repositories/payrollSnapshotRepository.js';
import payslipService from '../services/payslipService.js';

/**
 * Employee self-service.
 *
 * An employee sees only their own FINALIZED payslips. A snapshot that belongs
 * to someone else, to another company, or is not yet finalized is reported as
 * not found.
 */

const isMine = (snapshot, user) =>
  snapshot.snapshotStatus === 'FINALIZED' &&
  String(snapshot.employeeSnapshot.employeeId) === user.employeeId &&
  String(snapshot.companyId) === user.companyId;

export const listMyPayslips = async (req, res) => {
  const snapshots = await payrollSnapshotRepository.findByEmployee(req.user.employeeId, {
    snapshotStatus: 'FINALIZED',
    limit: 120,
  });

  const payslips = snapshots
    .filter((snapshot) => isMine(snapshot, req.user))
    .map((snapshot) => ({
      id: snapshot._id,
      periodMonth: snapshot.periodMonth,
      periodYear: snapshot.periodYear,
      grossMonthly: snapshot.payrollInputs.grossMonthly,
      totalDeductions: snapshot.payrollResults.totalEmployeeDeductions,
      netPayBeforeTDS: snapshot.payrollResults.netPayBeforeTDS,
      finalizedAt: snapshot.finalizedAt,
    }));

  return res.status(200).json({ success: true, data: { payslips } });
};

export const getMyPayslip = async (req, res) => {
  const snapshot = await payrollSnapshotRepository.findById(req.params.id);

  if (!snapshot || !isMine(snapshot, req.user)) {
    return res.status(404).json({ success: false, message: 'Payslip not found.' });
  }

  return res.status(200).json({
    success: true,
    data: { payslip: payslipService.buildPayslip(snapshot) },
  });
};

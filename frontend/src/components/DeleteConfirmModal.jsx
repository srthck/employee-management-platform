export default function DeleteConfirmModal({
  employee,
  onConfirm,
  onCancel,
}) {
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#241F20]/40 p-4 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        className="w-full max-w-sm rounded-[14px] border border-[#E7D8D5] bg-[#FFFDF8] shadow-[0_12px_40px_rgba(60,25,30,0.16)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-employee-title"
      >

        {/* HEADER */}
        <div className="px-6 pb-4 pt-6">

          <div className="mb-4 flex items-center gap-3">

            {/* Warning icon */}
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#F8E8EA] text-[#9B1C31]">
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </div>

            <div>
              <h3
                id="delete-employee-title"
                className="text-base font-semibold text-[#241F20]"
              >
                Archive employee
              </h3>

              <p className="mt-0.5 text-sm text-[#6F6565]">
                Please confirm this action.
              </p>
            </div>

          </div>

          <p className="text-sm leading-6 text-[#5F5555]">
            Are you sure you want to archive{' '}
            <span className="font-semibold text-[#241F20]">
              {employee?.firstName} {employee?.lastName}
            </span>
            ?
          </p>

          <div className="mt-4 rounded-[10px] border border-[#E7D8D5] bg-[#FFF7F0] px-4 py-3">
            <p className="text-xs leading-5 text-[#6F6565]">
              The employee leaves future payroll runs and loses login
              access. Finalized payslips stay preserved, and the record can
              be restored from the archived view.
            </p>
          </div>

        </div>

        {/* ACTIONS */}
        <div className="flex items-center justify-end gap-3 px-6 pb-6">

          <button
            type="button"
            onClick={onCancel}
            className="rounded-[8px] border border-[#E7D8D5] bg-white px-4 py-2 text-sm font-medium text-[#6F6565] transition hover:border-[#A6192E] hover:bg-[#F8E8EA] hover:text-[#A6192E]"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={onConfirm}
            className="flex items-center gap-2 rounded-[8px] bg-[#A6192E] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#7D1022] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>

            Archive employee
          </button>

        </div>
      </div>
    </div>
  );
}
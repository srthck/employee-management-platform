import { useEffect, useState, useContext } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../services/api';
import { AuthContext } from '../contexts/AuthContext';

/**
 * PayGuard Landing Page
 *
 * Professional landing page for the PayGuard payroll platform.
 * Existing authentication and backend health-check functionality
 * is preserved.
 */

export default function Home() {
  const { user, logout } = useContext(AuthContext);

  const [apiStatus, setApiStatus] = useState(null);
  const [apiLoading, setApiLoading] = useState(true);

  useEffect(() => {
    const checkAPI = async () => {
      try {
        const response = await apiClient.get('/health');
        setApiStatus(response.data);
      } catch (err) {
        setApiStatus(null);
      } finally {
        setApiLoading(false);
      }
    };

    checkAPI();
  }, []);

  const isAPIOnline = !apiLoading && apiStatus;

  return (
    <div className="min-h-screen bg-[#FFFDF8] text-[#241F20]">

      {/* =========================================================
          NAVIGATION
      ========================================================== */}
      <nav className="border-b border-[#E7D8D5] bg-[#FFFDF8]">
        <div className="mx-auto flex h-[78px] max-w-[1450px] items-center justify-between px-8 lg:px-16">

          {/* PayGuard Logo */}
          <Link
            to="/"
            className="flex items-center gap-3"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#A6192E] shadow-[0_6px_16px_rgba(60,25,30,0.12)]">
              <span className="text-lg font-semibold text-white">
                P
              </span>
            </div>

            <span className="text-[19px] font-semibold tracking-[-0.025em] text-[#241F20]">
              PayGuard
            </span>
          </Link>

          {/* Navigation Links */}
          <div className="hidden items-center gap-12 md:flex">
            <a
              href="#features"
              className="text-[14px] font-medium text-[#6F6565] transition-colors hover:text-[#A6192E]"
            >
              Features
            </a>

            <a
              href="#security"
              className="text-[14px] font-medium text-[#6F6565] transition-colors hover:text-[#A6192E]"
            >
              Security
            </a>

            <a
              href="#compliance"
              className="text-[14px] font-medium text-[#6F6565] transition-colors hover:text-[#A6192E]"
            >
              Compliance
            </a>
          </div>

          {/* Authentication */}
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="hidden text-sm text-[#6F6565] lg:block">
                  {user.name}
                </span>

                <Link
                  to="/dashboard"
                  className="rounded-[9px] bg-[#A6192E] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#7D1022]"
                >
                  Dashboard
                </Link>

                <button
                  type="button"
                  onClick={logout}
                  className="rounded-[9px] border border-[#E7D8D5] bg-white px-5 py-2.5 text-sm font-semibold text-[#A6192E] transition hover:border-[#A6192E] hover:bg-[#F8E8EA]"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <Link
                to="/login"
                className="rounded-[9px] border border-[#E7D8D5] bg-white px-6 py-2.5 text-sm font-semibold text-[#A6192E] transition hover:border-[#A6192E] hover:bg-[#F8E8EA]"
              >
                Sign In
              </Link>
            )}
          </div>
        </div>
      </nav>

      {/* =========================================================
          MAIN CONTENT
      ========================================================== */}
      <main>

        {/* =======================================================
            HERO
        ======================================================== */}
        <section className="mx-auto max-w-[1450px] px-8 pb-16 pt-16 lg:px-16 lg:pb-20 lg:pt-18">

          <div className="grid items-center gap-14 lg:grid-cols-[1fr_0.94fr] lg:gap-16">

            {/* =================================================
                LEFT SIDE
            ================================================== */}
            <div>

              {/* Eyebrow */}
              <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[#E7D8D5] bg-[#F8E8EA] px-4 py-2">
                <span className="h-2 w-2 rounded-full bg-[#2E7D32]" />

                <span className="text-xs font-semibold tracking-[0.04em] text-[#A6192E]">
                  Intelligent Payroll Infrastructure
                </span>
              </div>

              {/* Main Brand Heading */}
              <h1 className="text-[48px] font-semibold leading-[1.05] tracking-[-0.04em] text-[#241F20] sm:text-[54px] lg:text-[60px]">
                Pay<span className="text-[#A6192E]">Guard</span>
              </h1>

              {/* Tagline */}
              <p className="mt-5 text-[20px] font-semibold tracking-[-0.015em] text-[#A6192E] sm:text-[22px]">
                Detect. Explain. Predict. Protect.
              </p>

              {/* Main Project Description */}
              <h2 className="mt-6 max-w-[720px] text-[17px] font-semibold leading-7 text-[#241F20]">
                Immutable Payroll Engine with ML-Based Anomaly Detection &
                Versioned Statutory Compliance
              </h2>

              <p className="mt-4 max-w-[690px] text-[16px] leading-7 text-[#6F6565]">
                A unified platform built around payroll engineering,
                machine learning, data integrity, and statutory compliance.
              </p>

              {/* CTA Buttons */}
              <div className="mt-8 flex flex-wrap items-center gap-4">

                {user ? (
                  <Link
                    to="/dashboard"
                    className="rounded-[10px] bg-[#A6192E] px-7 py-4 text-[15px] font-semibold text-white shadow-[0_10px_22px_rgba(60,25,30,0.12)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#7D1022]"
                  >
                    Explore PayGuard
                    <span className="ml-3">
                      →
                    </span>
                  </Link>
                ) : (
                  <Link
                    to="/register"
                    className="rounded-[10px] bg-[#A6192E] px-7 py-4 text-[15px] font-semibold text-white shadow-[0_10px_22px_rgba(60,25,30,0.12)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#7D1022]"
                  >
                    Explore PayGuard
                    <span className="ml-3">
                      →
                    </span>
                  </Link>
                )}

                <Link
                  to="/login"
                  className="rounded-[10px] border border-[#E7D8D5] bg-white px-7 py-4 text-[15px] font-semibold text-[#241F20] transition duration-200 hover:border-[#A6192E] hover:bg-[#F8E8EA] hover:text-[#A6192E]"
                >
                  Sign In
                </Link>
              </div>

              {/* Trust Statement */}
              <div className="mt-7 flex items-center gap-2 text-sm text-[#6F6565]">
                <span className="text-base font-bold text-[#2E7D32]">
                  ✓
                </span>

                <span>
                  Built for secure and accountable payroll operations
                </span>
              </div>
            </div>

            {/* =================================================
                RIGHT PAYROLL CARD
            ================================================== */}
            <div className="relative">

              {/* Decorative Glow */}
              <div className="absolute -right-8 -top-10 h-64 w-64 rounded-full bg-[#F8E8EA] opacity-50 blur-3xl" />

              {/* Main Card */}
              <div className="relative overflow-hidden rounded-[22px] border border-[#E7D8D5] bg-white p-7 shadow-[0_22px_55px_rgba(60,25,30,0.08)] sm:p-8">

                {/* Card Header */}
                <div className="flex items-start justify-between">

                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A6192E]">
                      Payroll Health
                    </p>

                    <h2 className="mt-2 text-[22px] font-semibold tracking-[-0.025em] text-[#241F20]">
                      Payroll Overview
                    </h2>
                  </div>

                  {/* API Status */}
                  <div className="flex items-center gap-2 rounded-full bg-[#F3F8F3] px-3 py-1.5">

                    <span
                      className={`h-2 w-2 rounded-full ${
                        apiLoading
                          ? 'bg-[#B7791F]'
                          : isAPIOnline
                          ? 'animate-pulse bg-[#2E7D32]'
                          : 'bg-[#B7791F]'
                      }`}
                    />

                    <span className="text-xs font-semibold text-[#2E7D32]">
                      {apiLoading
                        ? 'Checking'
                        : isAPIOnline
                        ? 'Live'
                        : 'Offline'}
                    </span>
                  </div>
                </div>

                {/* Payroll Metric */}
                <div className="mt-7">

                  <p className="text-[42px] font-bold tracking-[-0.04em] text-[#241F20]">
                    ₹24.8L
                  </p>

                  <p className="mt-1 text-sm text-[#6F6565]">
                    Current payroll volume
                  </p>
                </div>

                {/* Payroll Chart */}
                <div className="mt-8">

                  <div className="flex h-[135px] items-end gap-3 border-b border-[#E7D8D5] px-1 pb-2">

                    {[
                      '42%',
                      '54%',
                      '48%',
                      '68%',
                      '59%',
                      '77%',
                      '88%',
                    ].map((height, index) => (
                      <div
                        key={index}
                        className="flex-1 rounded-t-[5px] bg-[#A6192E] transition duration-200 hover:bg-[#7D1022]"
                        style={{ height }}
                      />
                    ))}

                  </div>
                </div>

                {/* Integrity Status */}
                <div className="mt-6 flex items-center justify-between">

                  <div className="flex items-center gap-3">

                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F3F8F3]">
                      <span className="text-lg font-bold text-[#2E7D32]">
                        ✓
                      </span>
                    </div>

                    <div>
                      <p className="text-sm font-semibold text-[#241F20]">
                        Integrity verified
                      </p>

                      <p className="mt-0.5 text-xs text-[#6F6565]">
                        Payroll snapshot secure
                      </p>
                    </div>

                  </div>

                  <span className="text-sm font-semibold text-[#2E7D32]">
                    +8.4%
                  </span>

                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =======================================================
            FEATURE STRIP
        ======================================================== */}
        <section
          id="features"
          className="border-t border-[#E7D8D5] bg-white"
        >
          <div className="mx-auto grid max-w-[1450px] grid-cols-1 px-8 py-9 sm:grid-cols-3 lg:px-16">

            {/* Feature 1 */}
            <div className="border-b border-[#E7D8D5] px-5 py-5 sm:border-b-0 sm:border-r">

              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#A6192E]">
                Intelligent
              </p>

              <h3 className="mt-2 text-lg font-semibold tracking-[-0.015em] text-[#241F20]">
                ML-Based Anomaly Detection
              </h3>

              <p className="mt-2 text-sm leading-6 text-[#6F6565]">
                Identify unusual payroll patterns and explain suspicious
                salary variations.
              </p>

            </div>

            {/* Feature 2 */}
            <div
              id="security"
              className="border-b border-[#E7D8D5] px-5 py-5 sm:border-b-0 sm:border-r"
            >

              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#A6192E]">
                Secure
              </p>

              <h3 className="mt-2 text-lg font-semibold tracking-[-0.015em] text-[#241F20]">
                Immutable Payroll Integrity
              </h3>

              <p className="mt-2 text-sm leading-6 text-[#6F6565]">
                Tamper-evident payroll snapshots and audit trails provide
                trustworthy data lineage.
              </p>

            </div>

            {/* Feature 3 */}
            <div
              id="compliance"
              className="px-5 py-5"
            >

              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#A6192E]">
                Compliant
              </p>

              <h3 className="mt-2 text-lg font-semibold tracking-[-0.015em] text-[#241F20]">
                Versioned Statutory Rules
              </h3>

              <p className="mt-2 text-sm leading-6 text-[#6F6565]">
                Effective-dated compliance rules help keep payroll processing
                transparent and accountable.
              </p>

            </div>

          </div>
        </section>
      </main>

      {/* =========================================================
          FOOTER
      ========================================================== */}
      <footer className="border-t border-[#E7D8D5] bg-[#FFFDF8]">

        <div className="mx-auto flex max-w-[1450px] flex-col items-center justify-between gap-3 px-8 py-6 text-sm text-[#6F6565] sm:flex-row lg:px-16">

          <p>
            © {new Date().getFullYear()} PayGuard
          </p>

          <p>
            Detect. Explain. Predict. Protect.
          </p>

        </div>

      </footer>
    </div>
  );
}
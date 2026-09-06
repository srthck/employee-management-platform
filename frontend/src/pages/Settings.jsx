import { useContext } from 'react';
import { AuthContext } from '../contexts/AuthContext';

export default function Settings() {
  const { user } = useContext(AuthContext);

  return (
    <div className="space-y-8">
      {/* =========================================================
          PAGE HEADER
      ========================================================== */}
      <div>
        <p className="eyebrow">Administration</p>

        <h1 className="page-title">
          Settings
        </h1>

        <p className="page-subtitle">
          Account and current company context.
        </p>
      </div>

      {/* =========================================================
          PROFILE PANEL
      ========================================================== */}
      <section className="panel max-w-2xl">
        <p className="eyebrow">
          Profile
        </p>

        <h2 className="section-title">
          Authenticated user
        </h2>

        <dl className="mt-6 divide-y divide-[#E7D8D5] text-sm">

          {/* Name */}
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-[#6F6565]">
              Name
            </dt>

            <dd className="font-semibold text-[#241F20]">
              {user?.name}
            </dd>
          </div>

          {/* Email */}
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-[#6F6565]">
              Email
            </dt>

            <dd className="font-semibold text-[#241F20]">
              {user?.email}
            </dd>
          </div>

          {/* Role */}
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-[#6F6565]">
              Role
            </dt>

            <dd className="font-semibold text-[#241F20]">
              {user?.role}
            </dd>
          </div>

          {/* Company Context */}
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-[#6F6565]">
              Company context
            </dt>

            <dd className="font-semibold text-[#241F20]">
              Single tenant
            </dd>
          </div>

        </dl>
      </section>
    </div>
  );
}
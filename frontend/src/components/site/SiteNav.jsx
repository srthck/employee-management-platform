import { useContext, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../contexts/AuthContext';
import ProoflineMark from './ProoflineMark';

export const SECTION_LINKS = [
  { href: '#trace', label: 'How a result is traced' },
  { href: '#lifecycle', label: 'Run lifecycle' },
  { href: '#capabilities', label: 'Capabilities' },
  { href: '#integrity', label: 'Integrity' },
];

/**
 * Public-site navigation. Section links collapse into a disclosure menu below
 * the desktop breakpoint; the account action stays visible at every width.
 */
export default function SiteNav() {
  const { user, loading, logout } = useContext(AuthContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="site-nav">
      <div className="site-nav__bar site-container">
        <Link to="/" className="site-brand" aria-label="PayGuard home">
          <ProoflineMark />
          <span className="site-brand__word">PayGuard</span>
        </Link>

        <nav className="site-nav__links" aria-label="Page sections">
          {SECTION_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="site-nav__link">{link.label}</a>
          ))}
        </nav>

        <div className="site-nav__account" data-loading={loading ? '' : undefined}>
          {loading ? null : user ? (
            <>
              <span className="site-nav__user">{user.name}</span>
              <button type="button" onClick={logout} className="site-btn site-btn--quiet site-nav__secondary">
                Sign out
              </button>
              <Link to="/dashboard" className="site-btn site-btn--primary">
                <span className="site-nav__long">Open dashboard</span>
                <span className="site-nav__short">Dashboard</span>
              </Link>
            </>
          ) : (
            <>
              <Link to="/login" className="site-btn site-btn--quiet">Sign in</Link>
              <Link to="/register" className="site-btn site-btn--primary site-nav__secondary">Create account</Link>
            </>
          )}
          <button
            ref={toggleRef}
            type="button"
            className="site-nav__toggle"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="site-nav__toggle-icon" aria-hidden="true" data-open={menuOpen ? '' : undefined} />
            <span className="site-nav__toggle-label">Menu</span>
          </button>
        </div>
      </div>

      <div id={menuId} className="site-nav__menu" hidden={!menuOpen}>
        <nav className="site-container" aria-label="Page sections">
          <ul>
            {SECTION_LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} onClick={closeMenu}>{link.label}</a>
              </li>
            ))}
          </ul>
          {!loading && (
            <div className="site-nav__menu-account">
              {user ? (
                <button type="button" onClick={() => { closeMenu(); logout(); }} className="site-btn site-btn--quiet">
                  Sign out
                </button>
              ) : (
                <Link to="/register" className="site-btn site-btn--primary">Create account</Link>
              )}
            </div>
          )}
        </nav>
      </div>
    </header>
  );
}

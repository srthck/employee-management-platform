import { useContext, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../contexts/AuthContext';
import ProoflineMark from './ProoflineMark';
import Icon from '../ui/Icon';

export const SECTION_LINKS = [
  { href: '#trace', label: 'Trace' },
  { href: '#lifecycle', label: 'Lifecycle' },
  { href: '#capabilities', label: 'Capabilities' },
  { href: '#integrity', label: 'Integrity' },
];

/**
 * Public-site navigation: the brand at the left, the page sections in a
 * centred glass capsule, and circular controls at the right. The capsule
 * collapses into the menu disclosure below the desktop breakpoint; the
 * account action stays reachable at every width.
 */
export default function SiteNav() {
  const { user, loading, logout } = useContext(AuthContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState(SECTION_LINKS[0].href);
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

  // The capsule marks the section currently in view, as the reference does.
  useEffect(() => {
    const targets = SECTION_LINKS
      .map((link) => document.querySelector(link.href))
      .filter(Boolean);
    if (!targets.length || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActive(`#${visible.target.id}`);
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="site-nav">
      <div className="site-nav__bar">
        <Link to="/" className="site-brand" aria-label="PayGuard home">
          <ProoflineMark />
          <span className="site-brand__word">PayGuard</span>
        </Link>

        <nav className="site-nav__pill" aria-label="Page sections">
          {SECTION_LINKS.map((link) => {
            const isActive = active === link.href;
            return (
              <a
                key={link.href}
                href={link.href}
                className="site-nav__link"
                data-active={isActive ? '' : undefined}
                aria-current={isActive ? 'true' : undefined}
              >
                {isActive && <span className="site-nav__dot" aria-hidden="true" />}
                {link.label}
              </a>
            );
          })}
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
              <Link to="/login" className="site-btn site-btn--quiet site-nav__secondary">Sign in</Link>
              <Link to="/register" className="site-btn site-btn--primary">
                <span className="site-nav__long">Create account</span>
                <span className="site-nav__short">Sign up</span>
              </Link>
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
            <Icon name={menuOpen ? 'close' : 'menu'} size={18} />
            <span className="sr-only">Menu</span>
          </button>
        </div>
      </div>

      <div id={menuId} className="site-nav__menu" hidden={!menuOpen}>
        <nav aria-label="Page sections">
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
                <>
                  <Link to="/login" onClick={closeMenu} className="site-btn site-btn--quiet">Sign in</Link>
                  <Link to="/register" onClick={closeMenu} className="site-btn site-btn--primary">Create account</Link>
                </>
              )}
            </div>
          )}
        </nav>
      </div>
    </header>
  );
}

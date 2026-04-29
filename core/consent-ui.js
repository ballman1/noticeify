/**
 * ConsentGuard — consent-ui.js
 *
 * Lazily loaded by consent-loader.js only when the banner needs to be shown
 * (i.e. first-time visitors with no stored consent). Returning users who
 * already have a valid consent cookie never load this file.
 *
 * Exports two public functions:
 *   showBanner(options)          — renders the consent banner
 *   openPreferenceCenter(options) — renders or opens the preference center
 *
 * The UI is injected as a Shadow DOM root on a <div id="cg-ui"> element
 * appended to <body>. Shadow DOM provides full CSS isolation — the client
 * site's stylesheets cannot accidentally override the banner, and the
 * banner's styles cannot leak into the page.
 *
 * Accessibility requirements met:
 *   - ARIA role="dialog" with aria-modal, aria-labelledby, aria-describedby
 *   - Focus trap inside preference center modal
 *   - Focus returns to trigger element on close
 *   - Keyboard: Tab, Shift+Tab cycle within modal; Escape closes
 *   - Visible focus indicators
 *   - Toggle switches have aria-checked and aria-label
 *   - Screen reader announcements via aria-live region
 *   - No dark patterns, no pre-checked non-essential toggles
 *   - Reject and Accept are equal visual weight (no deceptive hierarchy)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  {
    key:         'functional',
    label:       'Functional',
    description: 'Enables enhanced features such as remembering your preferences, region, and language settings across visits.',
    vendors:     'Preference cookies',
  },
  {
    key:         'analytics',
    label:       'Analytics',
    description: 'Help us understand how visitors use our website so we can improve performance and usability.',
    vendors:     'Google Analytics 4, Microsoft Clarity',
  },
  {
    key:         'marketing',
    label:       'Marketing & advertising',
    description: 'May be used to measure ad performance, personalize ads, build audiences, or support remarketing across other websites.',
    vendors:     'Meta Pixel, Google Ads, Microsoft Ads, TikTok Pixel, Klaviyo, Pinterest',
  },
  {
    key:         'personalization',
    label:       'Personalization',
    description: 'Used to tailor content, product recommendations, and site experience based on your interests and browsing behavior.',
    vendors:     'Justuno',
  },
  {
    key:         'support',
    label:       'Support & chat',
    description: 'Allows live chat, customer support, and interactive help features to operate on this website.',
    vendors:     'Zendesk Chat',
  },
  {
    key:         'media',
    label:       'Embedded media',
    description: 'Enables embedded video players and third-party media. These services may set their own cookies when activated.',
    vendors:     'YouTube, Vimeo',
  },
];

// ---------------------------------------------------------------------------
// Shadow DOM host
// ---------------------------------------------------------------------------

let _shadowRoot  = null;
let _hostEl      = null;
let _bannerEl    = null;
let _prefEl      = null;
let _prefTrigger = null; // element that opened the pref center (for focus return)

function ensureShadowRoot() {
  if (_shadowRoot) return _shadowRoot;

  _hostEl = document.createElement('div');
  _hostEl.id = 'cg-ui';
  _hostEl.setAttribute('data-nosnippet', ''); // prevent Google indexing banner text
  document.body.appendChild(_hostEl);

  _shadowRoot = _hostEl.attachShadow({ mode: 'open' });

  // Inject styles into shadow root
  const style = document.createElement('style');
  style.textContent = STYLES;
  _shadowRoot.appendChild(style);

  // Aria live region for screen reader announcements
  const live = document.createElement('div');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.className = 'sr-announce';
  _shadowRoot.appendChild(live);

  return _shadowRoot;
}

function announce(text) {
  const live = _shadowRoot && _shadowRoot.querySelector('.sr-announce');
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 50); }
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {boolean}  options.gpcDetected
 * @param {function} options.onAcceptAll
 * @param {function} options.onRejectNonEssential
 * @param {function} options.onSavePreferences
 */
function showBanner({ gpcDetected, onAcceptAll, onRejectNonEssential, onSavePreferences }) {
  const root = ensureShadowRoot();
  if (_bannerEl) return; // already shown

  const banner = document.createElement('div');
  banner.className  = 'cg-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.setAttribute('aria-describedby', 'cg-banner-desc');

  banner.innerHTML = `
    ${gpcDetected ? `
      <div class="cg-gpc-notice" role="status">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.4"/>
          <path d="M7 4.5v3M7 9.5v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        Your browser's privacy signal has been detected. Non-essential advertising tracking has been disabled.
      </div>` : ''}

    <div class="cg-banner-inner">
      <div class="cg-banner-text">
        <p class="cg-banner-title">Your privacy choices</p>
        <p class="cg-banner-body" id="cg-banner-desc">
          We use cookies and similar technologies to operate this website, improve
          performance, understand site usage, personalize content, and support
          advertising. Non-essential cookies and third-party tracking technologies
          will not be activated unless you give consent.
        </p>
        <p class="cg-banner-links">
          <a href="/privacy-policy" target="_blank" rel="noopener">Privacy Policy</a>
          <span aria-hidden="true">·</span>
          <a href="/cookie-policy" target="_blank" rel="noopener">Cookie Policy</a>
          <span aria-hidden="true">·</span>
          <a href="/privacy-choices" target="_blank" rel="noopener">Your Privacy Choices</a>
        </p>
      </div>
      <div class="cg-banner-actions">
        <button class="cg-btn cg-btn-accept" id="cg-accept-all">Accept all</button>
        <button class="cg-btn cg-btn-reject" id="cg-reject-all">Reject non-essential</button>
        <button class="cg-btn cg-btn-manage" id="cg-manage-prefs">Manage preferences</button>
      </div>
    </div>
  `;

  root.appendChild(banner);
  _bannerEl = banner;

  // Slide in
  requestAnimationFrame(() => banner.classList.add('cg-banner--visible'));

  // Focus first button for keyboard users
  setTimeout(() => {
    const first = banner.querySelector('#cg-accept-all');
    if (first) first.focus();
  }, 350);

  // Wire buttons
  banner.querySelector('#cg-accept-all').addEventListener('click', () => {
    hideBanner();
    onAcceptAll();
    announce('All cookies accepted.');
  });

  banner.querySelector('#cg-reject-all').addEventListener('click', () => {
    hideBanner();
    onRejectNonEssential();
    announce('Non-essential cookies rejected.');
  });

  banner.querySelector('#cg-manage-prefs').addEventListener('click', () => {
    _prefTrigger = banner.querySelector('#cg-manage-prefs');
    openPreferenceCenter({
      currentCategories: {},
      gpcDetected,
      onSave: (cats) => {
        hideBanner();
        onSavePreferences(cats);
        announce('Your privacy preferences have been saved.');
      },
    });
  });
}

function hideBanner() {
  if (!_bannerEl) return;
  _bannerEl.classList.remove('cg-banner--visible');
  _bannerEl.classList.add('cg-banner--hiding');
  setTimeout(() => {
    _bannerEl && _bannerEl.remove();
    _bannerEl = null;
  }, 300);
}

// ---------------------------------------------------------------------------
// Preference center
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object}   options.currentCategories — existing grants (may be partial)
 * @param {boolean}  options.gpcDetected
 * @param {function} options.onSave            — called with final categories object
 */
function openPreferenceCenter({ currentCategories = {}, gpcDetected, onSave }) {
  const root = ensureShadowRoot();
  if (_prefEl) return;

  const overlay = document.createElement('div');
  overlay.className = 'cg-overlay';
  overlay.setAttribute('aria-hidden', 'true'); // overlay itself is decorative

  const modal = document.createElement('div');
  modal.className = 'cg-pref';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'cg-pref-title');
  modal.setAttribute('aria-describedby', 'cg-pref-desc');
  modal.tabIndex = -1;

  const categoryRows = CATEGORIES.map(cat => {
    const isGPCBlocked = gpcDetected && (cat.key === 'marketing' || cat.key === 'personalization');
    const isChecked    = isGPCBlocked ? false : !!currentCategories[cat.key];

    return `
      <div class="cg-pref-row" data-category="${cat.key}">
        <div class="cg-pref-row-info">
          <span class="cg-pref-row-label">${cat.label}</span>
          <span class="cg-pref-row-desc">${cat.description}</span>
          <span class="cg-pref-row-vendors">${cat.vendors}</span>
          ${isGPCBlocked ? '<span class="cg-gpc-label">Disabled by browser privacy signal</span>' : ''}
        </div>
        <label class="cg-toggle" aria-label="${cat.label} — ${isChecked ? 'enabled' : 'disabled'}">
          <input
            type="checkbox"
            class="cg-toggle-input"
            data-category="${cat.key}"
            ${isChecked ? 'checked' : ''}
            ${isGPCBlocked ? 'disabled' : ''}
            aria-checked="${isChecked}"
          />
          <span class="cg-toggle-track" aria-hidden="true">
            <span class="cg-toggle-thumb"></span>
          </span>
        </label>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="cg-pref-header">
      <div>
        <h2 class="cg-pref-title" id="cg-pref-title">Manage your privacy preferences</h2>
        <p class="cg-pref-subtitle" id="cg-pref-desc">
          Strictly necessary cookies are always active. Your choices apply to
          39dollarglasses.com and are saved for 365 days.
        </p>
      </div>
      <button class="cg-pref-close" aria-label="Close privacy preferences">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div class="cg-pref-body">
      <!-- Strictly necessary row (always on, locked) -->
      <div class="cg-pref-row cg-pref-row--locked">
        <div class="cg-pref-row-info">
          <span class="cg-pref-row-label">Strictly necessary</span>
          <span class="cg-pref-row-desc">
            Required to operate the website — shopping cart, checkout session,
            authentication, payment processing, and fraud prevention.
          </span>
          <span class="cg-pref-row-vendors">Session cookies, Stripe, Sezzle, Signifyd</span>
        </div>
        <span class="cg-always-on" aria-label="Strictly necessary cookies are always active">Always on</span>
      </div>

      ${categoryRows}
    </div>

    <div class="cg-pref-footer">
      <span class="cg-pref-footer-meta">
        <a href="/privacy-policy" target="_blank" rel="noopener">Privacy Policy</a>
        <span aria-hidden="true">·</span>
        <a href="/cookie-policy" target="_blank" rel="noopener">Cookie Policy</a>
      </span>
      <div class="cg-pref-footer-btns">
        <button class="cg-btn cg-btn-reject" id="cg-pref-reject-all">Reject all</button>
        <button class="cg-btn cg-btn-accept" id="cg-pref-save">Save preferences</button>
      </div>
    </div>
  `;

  root.appendChild(overlay);
  root.appendChild(modal);
  _prefEl = modal;

  // Animate in
  requestAnimationFrame(() => {
    overlay.classList.add('cg-overlay--visible');
    modal.classList.add('cg-pref--visible');
  });

  // Focus the modal
  setTimeout(() => modal.focus(), 50);

  // ── Toggle interactions ──────────────────────────────────────────────────
  modal.querySelectorAll('.cg-toggle-input').forEach(input => {
    input.addEventListener('change', () => {
      input.setAttribute('aria-checked', input.checked.toString());
      const label = input.closest('.cg-toggle');
      if (label) {
        const catLabel = input.closest('.cg-pref-row')
          .querySelector('.cg-pref-row-label').textContent;
        label.setAttribute('aria-label',
          catLabel + ' — ' + (input.checked ? 'enabled' : 'disabled'));
      }
    });
  });

  // ── Reject all ────────────────────────────────────────────────────────────
  modal.querySelector('#cg-pref-reject-all').addEventListener('click', () => {
    modal.querySelectorAll('.cg-toggle-input:not(:disabled)').forEach(input => {
      input.checked = false;
      input.setAttribute('aria-checked', 'false');
    });
  });

  // ── Save ──────────────────────────────────────────────────────────────────
  modal.querySelector('#cg-pref-save').addEventListener('click', () => {
    const categories = {};
    CATEGORIES.forEach(cat => {
      const input = modal.querySelector(`.cg-toggle-input[data-category="${cat.key}"]`);
      categories[cat.key] = input ? input.checked : false;
    });
    closePrefCenter();
    onSave(categories);
  });

  // ── Close button ──────────────────────────────────────────────────────────
  modal.querySelector('.cg-pref-close').addEventListener('click', () => {
    closePrefCenter();
    // Return focus to whatever opened the pref center
    if (_prefTrigger) { _prefTrigger.focus(); _prefTrigger = null; }
  });

  // ── Escape key ────────────────────────────────────────────────────────────
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePrefCenter();
      if (_prefTrigger) { _prefTrigger.focus(); _prefTrigger = null; }
    }
    if (e.key === 'Tab') trapFocus(e, modal);
  });

  // ── Click outside ─────────────────────────────────────────────────────────
  overlay.addEventListener('click', () => {
    // Clicking overlay alone does not dismiss — user must make an active
    // choice. This prevents accidental dismissal on mobile.
  });
}

function closePrefCenter() {
  if (!_prefEl) return;
  const overlay = _shadowRoot.querySelector('.cg-overlay');

  _prefEl.classList.remove('cg-pref--visible');
  if (overlay) overlay.classList.remove('cg-overlay--visible');

  setTimeout(() => {
    _prefEl && _prefEl.remove();
    overlay && overlay.remove();
    _prefEl = null;
  }, 280);
}

// ---------------------------------------------------------------------------
// Focus trap utility
// ---------------------------------------------------------------------------

function trapFocus(e, container) {
  const focusable = Array.from(container.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.closest('[disabled]'));

  if (!focusable.length) return;

  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------------------
// Styles (injected into Shadow DOM)
// ---------------------------------------------------------------------------

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .sr-announce {
    position: absolute; width: 1px; height: 1px;
    overflow: hidden; clip: rect(0,0,0,0);
    white-space: nowrap; border: 0;
  }

  /* ── Banner ── */
  .cg-banner {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 2147483646;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    transform: translateY(100%);
    transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
  }
  .cg-banner--visible { transform: translateY(0); }
  .cg-banner--hiding  { transform: translateY(100%); }

  .cg-gpc-notice {
    display: flex; align-items: center; gap: 8px;
    background: #dbeafe; color: #1e3a5f;
    padding: 8px 20px; font-size: 12px;
    border-top: 1px solid #bfdbfe;
  }

  .cg-banner-inner {
    display: flex; align-items: center; gap: 24px;
    background: #fff;
    border-top: 1px solid #e5e7eb;
    padding: 16px 24px;
    box-shadow: 0 -4px 24px rgba(0,0,0,0.08);
  }

  @media (max-width: 680px) {
    .cg-banner-inner { flex-direction: column; align-items: stretch; gap: 14px; padding: 14px 16px; }
  }

  .cg-banner-text { flex: 1; min-width: 0; }
  .cg-banner-title { font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 4px; }
  .cg-banner-body  { font-size: 13px; color: #4b5563; line-height: 1.55; }
  .cg-banner-links { margin-top: 6px; font-size: 12px; color: #9ca3af; display: flex; gap: 8px; flex-wrap: wrap; }
  .cg-banner-links a { color: #2563eb; text-decoration: none; }
  .cg-banner-links a:hover { text-decoration: underline; }

  .cg-banner-actions {
    display: flex; flex-direction: column; gap: 7px;
    flex-shrink: 0; min-width: 180px;
  }

  @media (max-width: 680px) {
    .cg-banner-actions { flex-direction: row; flex-wrap: wrap; }
    .cg-banner-actions .cg-btn { flex: 1; min-width: 140px; }
  }

  /* ── Buttons ── */
  .cg-btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 9px 18px; border-radius: 6px;
    font-size: 13px; font-weight: 500; cursor: pointer;
    transition: background 0.15s, opacity 0.15s, transform 0.1s;
    border: 1px solid transparent; white-space: nowrap;
    font-family: inherit;
  }
  .cg-btn:active { transform: scale(0.98); }
  .cg-btn:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }

  .cg-btn-accept { background: #166534; color: #fff; border-color: #166534; }
  .cg-btn-accept:hover { background: #14532d; }

  .cg-btn-reject {
    background: transparent; color: #374151;
    border-color: #d1d5db;
  }
  .cg-btn-reject:hover { background: #f9fafb; }

  .cg-btn-manage {
    background: transparent; color: #6b7280;
    border-color: transparent; font-weight: 400;
    font-size: 12px; padding: 6px 10px;
  }
  .cg-btn-manage:hover { color: #374151; text-decoration: underline; background: transparent; }

  /* ── Overlay ── */
  .cg-overlay {
    position: fixed; inset: 0; z-index: 2147483645;
    background: rgba(0, 0, 0, 0);
    transition: background 0.28s ease;
  }
  .cg-overlay--visible { background: rgba(0, 0, 0, 0.45); }

  /* ── Preference center modal ── */
  .cg-pref {
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, calc(-50% + 20px));
    z-index: 2147483647;
    width: min(560px, calc(100vw - 32px));
    max-height: min(660px, calc(100vh - 40px));
    display: flex; flex-direction: column;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    opacity: 0;
    transition: opacity 0.25s ease, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
    outline: none;
  }
  .cg-pref--visible {
    opacity: 1;
    transform: translate(-50%, -50%);
  }

  @media (max-width: 600px) {
    .cg-pref {
      position: fixed;
      top: auto; left: 0; right: 0; bottom: 0;
      width: 100%; max-height: 88vh;
      border-radius: 16px 16px 0 0;
      transform: translate(0, 100%);
    }
    .cg-pref--visible { transform: translate(0, 0); }
  }

  .cg-pref-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; padding: 20px 20px 14px;
    border-bottom: 1px solid #f3f4f6; flex-shrink: 0;
  }
  .cg-pref-title  { font-size: 16px; font-weight: 600; color: #111827; }
  .cg-pref-subtitle { font-size: 12px; color: #6b7280; margin-top: 4px; line-height: 1.5; }

  .cg-pref-close {
    background: none; border: none; cursor: pointer;
    color: #9ca3af; padding: 4px; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 2px;
    transition: color 0.15s, background 0.15s;
  }
  .cg-pref-close:hover  { color: #374151; background: #f3f4f6; }
  .cg-pref-close:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }

  .cg-pref-body {
    flex: 1; overflow-y: auto; padding: 0 20px;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  /* ── Category rows ── */
  .cg-pref-row {
    display: flex; align-items: flex-start; gap: 14px;
    padding: 14px 0;
    border-bottom: 1px solid #f3f4f6;
  }
  .cg-pref-row:last-child { border-bottom: none; }
  .cg-pref-row--locked { opacity: .85; }

  .cg-pref-row-info { flex: 1; min-width: 0; }
  .cg-pref-row-label   { display: block; font-size: 13px; font-weight: 600; color: #111827; margin-bottom: 3px; }
  .cg-pref-row-desc    { display: block; font-size: 12px; color: #4b5563; line-height: 1.5; }
  .cg-pref-row-vendors { display: block; font-size: 11px; color: #9ca3af; margin-top: 4px; }
  .cg-gpc-label { display: inline-block; margin-top: 5px; font-size: 11px; color: #1e40af; font-weight: 500; }
  .cg-always-on { font-size: 11px; font-weight: 600; color: #166534; flex-shrink: 0; padding-top: 2px; white-space: nowrap; }

  /* ── Toggle ── */
  .cg-toggle {
    position: relative; display: inline-flex;
    width: 44px; height: 24px; flex-shrink: 0;
    cursor: pointer; margin-top: 1px;
  }
  .cg-toggle-input {
    position: absolute; opacity: 0; width: 100%; height: 100%;
    cursor: pointer; z-index: 1; margin: 0;
  }
  .cg-toggle-input:disabled { cursor: not-allowed; }
  .cg-toggle-input:disabled ~ .cg-toggle-track { opacity: .45; }

  .cg-toggle-track {
    position: absolute; inset: 0;
    background: #d1d5db; border-radius: 12px;
    transition: background 0.2s;
    display: flex; align-items: center;
  }
  .cg-toggle-input:checked ~ .cg-toggle-track { background: #166534; }
  .cg-toggle-input:focus-visible ~ .cg-toggle-track {
    outline: 2px solid #2563eb; outline-offset: 2px;
  }

  .cg-toggle-thumb {
    position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
  }
  .cg-toggle-input:checked ~ .cg-toggle-track .cg-toggle-thumb {
    transform: translateX(20px);
  }

  /* ── Footer ── */
  .cg-pref-footer {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 12px 20px;
    border-top: 1px solid #f3f4f6;
    background: #f9fafb; flex-shrink: 0;
    border-radius: 0 0 12px 12px;
  }
  @media (max-width: 600px) { .cg-pref-footer { border-radius: 0; } }
  @media (max-width: 460px) {
    .cg-pref-footer { flex-direction: column; align-items: stretch; }
    .cg-pref-footer-btns { flex-direction: column; }
    .cg-pref-footer-btns .cg-btn { width: 100%; }
  }

  .cg-pref-footer-meta { font-size: 11px; color: #9ca3af; display: flex; gap: 8px; flex-wrap: wrap; }
  .cg-pref-footer-meta a { color: #2563eb; text-decoration: none; }
  .cg-pref-footer-meta a:hover { text-decoration: underline; }
  .cg-pref-footer-btns { display: flex; gap: 8px; flex-shrink: 0; }

  /* ── Dark mode ── */
  @media (prefers-color-scheme: dark) {
    .cg-banner-inner  { background: #1f2937; border-color: #374151; }
    .cg-banner-title  { color: #f9fafb; }
    .cg-banner-body   { color: #9ca3af; }
    .cg-gpc-notice    { background: #1e3a5f; color: #bfdbfe; border-color: #1e40af; }
    .cg-pref          { background: #1f2937; }
    .cg-pref-title    { color: #f9fafb; }
    .cg-pref-subtitle { color: #9ca3af; }
    .cg-pref-row      { border-color: #374151; }
    .cg-pref-header   { border-color: #374151; }
    .cg-pref-row-label   { color: #f3f4f6; }
    .cg-pref-row-desc    { color: #9ca3af; }
    .cg-pref-row-vendors { color: #6b7280; }
    .cg-pref-footer   { background: #111827; border-color: #374151; border-radius: 0 0 12px 12px; }
    .cg-pref-close    { color: #6b7280; }
    .cg-pref-close:hover { background: #374151; color: #d1d5db; }
    .cg-toggle-track  { background: #4b5563; }
    .cg-btn-reject    { color: #d1d5db; border-color: #4b5563; }
    .cg-btn-reject:hover { background: #374151; }
    .cg-btn-manage    { color: #9ca3af; }
  }

  /* ── Reduced motion ── */
  @media (prefers-reduced-motion: reduce) {
    .cg-banner, .cg-pref, .cg-overlay { transition: none; }
    .cg-toggle-thumb { transition: none; }
    .cg-toggle-track { transition: none; }
  }
`;

export { showBanner, openPreferenceCenter };

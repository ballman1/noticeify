/**
 * ConsentGuard — media-embed-gate.js
 *
 * Replaces third-party media iframes (YouTube, Vimeo) with consent-aware
 * placeholders. The actual iframe only loads after the user grants the
 * 'media' category.
 *
 * Usage in HTML — use data-cg-src instead of src:
 *
 *   <iframe
 *     data-cg-src="https://www.youtube.com/embed/VIDEO_ID"
 *     data-cg-category="media"
 *     width="560" height="315"
 *     frameborder="0"
 *   ></iframe>
 *
 * Or wrap an existing embed in a div with class="cg-embed-gate":
 *
 *   <div class="cg-embed-gate" data-cg-src="https://www.youtube.com/embed/VIDEO_ID">
 *   </div>
 *
 * This module:
 *   1. On DOMContentLoaded, finds all gated embeds and renders placeholders
 *   2. Listens for consent changes via ConsentManager.onConsentChange()
 *   3. Activates embeds when the matching category is granted
 */

const TRACKED_DOMAINS = [
  'youtube.com', 'youtube-nocookie.com',
  'vimeo.com',
  'dailymotion.com',
  'twitch.tv',
];

function isDomainTracked(url) {
  try {
    const host = new URL(url).hostname;
    return TRACKED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Placeholder rendering
// ---------------------------------------------------------------------------

function buildPlaceholder(container, src, width, height) {
  const isYT     = src.includes('youtube');
  const isVimeo  = src.includes('vimeo');
  const label    = isYT ? 'YouTube' : isVimeo ? 'Vimeo' : 'Video';
  const thumbUrl = isYT
    ? extractYouTubeThumbnail(src)
    : null;

  const ph = document.createElement('div');
  ph.setAttribute('role', 'region');
  ph.setAttribute('aria-label', label + ' video — consent required');
  ph.style.cssText = [
    'position:relative',
    'width:' + (width || '100%'),
    'padding-top:' + (height ? '0' : '56.25%'),
    height ? 'height:' + height + 'px' : '',
    'background:#1a1a1a',
    'border-radius:8px',
    'overflow:hidden',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'flex-direction:column',
    'gap:12px',
    'text-align:center',
    'color:#fff',
    'font-family:system-ui,sans-serif',
    'font-size:14px',
  ].filter(Boolean).join(';');

  if (thumbUrl) {
    ph.style.backgroundImage = 'url(' + thumbUrl + ')';
    ph.style.backgroundSize  = 'cover';
    ph.style.backgroundPosition = 'center';
  }

  ph.innerHTML = `
    <div style="background:rgba(0,0,0,0.65);border-radius:8px;padding:16px 20px;max-width:320px;">
      <p style="margin:0 0 10px;font-weight:600;font-size:14px;">${label} video</p>
      <p style="margin:0 0 14px;font-size:12px;opacity:.8;line-height:1.5;">
        This video is hosted by ${label}. Loading it will allow ${label} to
        set cookies and track your activity.
      </p>
      <button
        data-cg-activate
        style="background:#fff;color:#1a1a1a;border:none;padding:8px 18px;
               border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;"
        onclick="window.ConsentManager && window.ConsentManager.openPreferences()"
      >
        Manage privacy settings
      </button>
    </div>
  `;

  container.appendChild(ph);
  return ph;
}

function extractYouTubeThumbnail(src) {
  const match = src.match(/\/embed\/([^/?]+)/);
  if (match) {
    return 'https://img.youtube.com/vi/' + match[1] + '/hqdefault.jpg';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Activate — swap placeholder for real iframe
// ---------------------------------------------------------------------------

function activateEmbed(container) {
  const src = container.getAttribute('data-cg-src');
  if (!src) return;

  // Remove existing placeholder
  container.querySelectorAll('[data-cg-activate]').forEach(el => {
    let ph = el.closest('[role]');
    if (ph) ph.remove();
  });
  container.querySelectorAll('div[style]').forEach(el => el.remove());

  const iframe = document.createElement('iframe');
  iframe.src             = src;
  iframe.width           = container.getAttribute('width')  || '100%';
  iframe.height          = container.getAttribute('height') || '315';
  iframe.frameBorder     = '0';
  iframe.allowFullscreen = true;
  iframe.allow           = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
  iframe.setAttribute('loading', 'lazy');
  container.style.padding = '0';
  container.appendChild(iframe);

  // Mark as activated so we don't process it again
  container.setAttribute('data-cg-activated', '1');
}

// ---------------------------------------------------------------------------
// Scan the DOM for gated embeds
// ---------------------------------------------------------------------------

function scanAndGateEmbeds() {
  // Handle <iframe data-cg-src="...">
  document.querySelectorAll('iframe[data-cg-src]:not([data-cg-activated])').forEach(iframe => {
    const src      = iframe.getAttribute('data-cg-src');
    const category = iframe.getAttribute('data-cg-category') || 'media';
    const width    = iframe.width;
    const height   = iframe.height;

    // Replace iframe with a wrapper div
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-cg-src', src);
    wrapper.setAttribute('data-cg-category', category);
    wrapper.setAttribute('width', width);
    wrapper.setAttribute('height', height);

    iframe.parentNode.replaceChild(wrapper, iframe);
    buildPlaceholder(wrapper, src, width, height);
  });

  // Handle <div class="cg-embed-gate" data-cg-src="...">
  document.querySelectorAll('.cg-embed-gate[data-cg-src]:not([data-cg-activated])').forEach(div => {
    if (!div.querySelector('iframe')) {
      buildPlaceholder(div, div.getAttribute('data-cg-src'));
    }
  });
}

// ---------------------------------------------------------------------------
// Consent change listener
// ---------------------------------------------------------------------------

function onConsentChange({ categories }) {
  if (!categories || !categories.media) return;

  // Activate all gated media embeds
  document.querySelectorAll('[data-cg-src]:not([data-cg-activated])').forEach(container => {
    const category = container.getAttribute('data-cg-category') || 'media';
    if (categories[category]) {
      activateEmbed(container);
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initMediaGate() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanAndGateEmbeds);
  } else {
    scanAndGateEmbeds();
  }

  // Hook into ConsentManager change events
  if (window.ConsentManager) {
    window.ConsentManager.onConsentChange(onConsentChange);
  } else {
    // ConsentManager may not be ready yet — retry after it initializes
    document.addEventListener('cg:ready', () => {
      window.ConsentManager.onConsentChange(onConsentChange);
    });
  }
}

initMediaGate();

export { initMediaGate, activateEmbed, scanAndGateEmbeds };

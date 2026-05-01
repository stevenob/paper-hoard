// Tiny shared script — runs on every page via _header include.
(function () {
  // Spinner on submit for any non-multipart form. Multipart (file upload)
  // doesn't get the spinner because the browser handles its own progress.
  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.enctype === 'multipart/form-data') return;
    const btn = form.querySelector('button[type="submit"], button:not([type])');
    if (btn && !btn.disabled) {
      btn.classList.add('is-loading');
      // Re-enable after 8s in case the page never navigates (XHR-style).
      setTimeout(function () { btn.classList.remove('is-loading'); }, 8000);
    }
  });

  // Mark cover images as loaded so the shimmer placeholder fades.
  // Also swap broken / tiny-placeholder images for a title fallback so
  // we never show an empty gray box.
  function replaceWithFallback(img) {
    var link = img.closest('.poster-link');
    var title = (link && link.getAttribute('aria-label')) || img.getAttribute('alt') || '?';
    var fallback = document.createElement('div');
    fallback.className = 'poster-fallback';
    var span = document.createElement('span');
    span.textContent = title;
    fallback.appendChild(span);
    img.replaceWith(fallback);
  }
  function checkOrFallback(img) {
    // Treat anything <= 64px in either dimension as a placeholder. Real
    // covers are at minimum ~100×150 (Google Books zoom=2). A 1×1 GIF
    // from Open Library default=true or Google's image-not-available
    // gets replaced with a clean title fallback.
    if (img.naturalWidth > 0 && img.naturalWidth <= 64) {
      replaceWithFallback(img);
      return;
    }
    img.classList.add('loaded');
  }
  function attach(img) {
    if (img.complete) {
      if (img.naturalWidth === 0) {
        replaceWithFallback(img);
        return;
      }
      checkOrFallback(img);
      return;
    }
    img.addEventListener('load', function () { checkOrFallback(img); });
    img.addEventListener('error', function () { replaceWithFallback(img); });
  }
  function scan() {
    document.querySelectorAll('.poster-link img').forEach(attach);
  }

  // Undo toast — server sets ph_undo=<copyId>|<title> for ~15s after a
  // soft-delete. Read it once on load, render a toast, and clear the cookie
  // so it doesn't reappear on every page.
  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function clearCookie(name) {
    document.cookie = name + '=; Max-Age=0; Path=/';
  }
  function showUndoToast() {
    const raw = readCookie('ph_undo');
    if (!raw) return;
    clearCookie('ph_undo');
    const sep = raw.indexOf('|');
    const id = sep >= 0 ? raw.slice(0, sep) : raw;
    const title = sep >= 0 ? raw.slice(sep + 1) : 'Copy';
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-undo';
    toast.setAttribute('role', 'status');
    toast.innerHTML =
      '<span class="toast-text">Moved to Trash: <strong></strong></span>' +
      '<form method="post" action="/library/copy/' + id + '/restore" style="display:inline">' +
      '  <button type="submit" class="toast-action">Undo</button>' +
      '</form>' +
      '<button type="button" class="toast-close" aria-label="Dismiss">×</button>';
    toast.querySelector('strong').textContent = title;
    toast.querySelector('.toast-close').addEventListener('click', function () {
      toast.classList.add('toast-leave');
      setTimeout(function () { toast.remove(); }, 250);
    });
    document.body.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('toast-leave');
      setTimeout(function () { toast.remove(); }, 250);
    }, 12000);
  }

  function init() {
    scan();
    showUndoToast();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// v3.5.22 Mobile nav drawer.
(function () {
  function setupDrawer() {
    var btn = document.querySelector('.topbar-menu-btn');
    var drawer = document.getElementById('topbar-drawer');
    if (!btn || !drawer) return;
    function close() {
      drawer.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    function open() {
      drawer.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (drawer.classList.contains('open')) close();
      else open();
    });
    document.addEventListener('click', function (e) {
      if (!drawer.classList.contains('open')) return;
      if (drawer.contains(e.target) || btn.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('open')) close();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDrawer);
  } else {
    setupDrawer();
  }
})();

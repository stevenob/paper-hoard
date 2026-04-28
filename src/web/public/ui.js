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
  function attach(img) {
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('loaded');
      return;
    }
    img.addEventListener('load', function () { img.classList.add('loaded'); });
    img.addEventListener('error', function () { img.classList.add('loaded'); });
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

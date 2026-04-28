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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
})();

(function () {
  'use strict';

  // Fills the shared page header: company name, logo initials and website link.
  const LEGAL_FORMS = /^(cv|pt|ud|tbk|ltd|inc|llc|co|gmbh|sdn|bhd)\.?$/i;

  function initials(name) {
    const words = name.split(/\s+/).filter((w) => w && !LEGAL_FORMS.test(w));
    return words
      .slice(0, 3)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      document.querySelectorAll('[data-company]').forEach((el) => (el.textContent = cfg.companyName));
      const mark = document.getElementById('brand-mark');
      if (mark) mark.textContent = initials(cfg.companyName) || '•';
      const site = document.getElementById('site-link');
      if (site && cfg.companyUrl) {
        site.href = cfg.companyUrl;
        site.hidden = false;
      }
      const year = document.getElementById('year');
      if (year) year.textContent = new Date().getFullYear();
    })
    .catch(() => {});
})();

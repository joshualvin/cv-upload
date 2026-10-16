(function () {
  'use strict';

  // Fills the shared page header: company name and website link.
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      document.querySelectorAll('[data-company]').forEach((el) => (el.textContent = cfg.companyName));
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

(function () {
  'use strict';

  // The public settings come inside the page (see loadPage in app.js); the
  // other scripts on the page use window.siteConfig instead of asking again.
  function readConfig() {
    try {
      return Promise.resolve(JSON.parse(document.getElementById('site-config').textContent));
    } catch (_) {
      return fetch('/api/config').then((r) => r.json());
    }
  }
  window.siteConfig = readConfig();

  // Fills the shared page header: company name and website link.
  window.siteConfig
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

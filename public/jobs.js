(function () {
  'use strict';

  const listEl = document.getElementById('jobs');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const searchEl = document.getElementById('search');
  const filtersEl = document.getElementById('filters');

  let jobs = [];
  let department = '';

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => (document.title = 'Karier · ' + cfg.companyName))
    .catch(() => {});

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function bulletList(title, items) {
    const wrap = el('div', 'job-section');
    wrap.appendChild(el('h3', '', title));
    const ul = el('ul');
    items.forEach((item) => ul.appendChild(el('li', '', item)));
    wrap.appendChild(ul);
    return wrap;
  }

  function postedLabel(date) {
    const d = new Date(date + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '';
    return 'Diposting ' + d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function card(job) {
    const li = el('li', 'job');
    li.id = job.id;
    const details = el('details');
    if (location.hash === '#' + job.id) details.open = true;

    const summary = el('summary');
    summary.appendChild(el('span', 'job-title', job.title));
    const meta = el('span', 'job-meta');
    [job.department, job.location, job.type].filter(Boolean).forEach((m) => meta.appendChild(el('span', 'tag', m)));
    summary.appendChild(meta);
    details.appendChild(summary);

    const body = el('div', 'job-body');
    if (job.summary) body.appendChild(el('p', '', job.summary));
    if (job.responsibilities.length) body.appendChild(bulletList('Tanggung jawab', job.responsibilities));
    if (job.requirements.length) body.appendChild(bulletList('Kualifikasi', job.requirements));

    const footer = el('div', 'job-footer');
    const apply = el('a', 'button', 'Lamar sekarang');
    apply.href = '/apply?position=' + encodeURIComponent(job.title);
    footer.appendChild(apply);
    if (job.postedAt) footer.appendChild(el('small', 'muted', postedLabel(job.postedAt)));
    body.appendChild(footer);

    details.appendChild(body);
    li.appendChild(details);
    return li;
  }

  function chip(label, value) {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === department));
    b.addEventListener('click', () => {
      department = value;
      renderFilters();
      render();
    });
    return b;
  }

  function renderFilters() {
    const departments = [...new Set(jobs.map((j) => j.department).filter(Boolean))].sort();
    filtersEl.replaceChildren();
    if (departments.length < 2) return;
    filtersEl.appendChild(chip('Semua', ''));
    departments.forEach((d) => filtersEl.appendChild(chip(d, d)));
  }

  function render() {
    const q = searchEl.value.trim().toLowerCase();
    const shown = jobs.filter(
      (j) =>
        (!department || j.department === department) &&
        (!q || [j.title, j.department, j.location, j.type, j.summary].join(' ').toLowerCase().includes(q))
    );
    listEl.replaceChildren(...shown.map(card));
    emptyEl.hidden = shown.length > 0 || jobs.length === 0;
    if (jobs.length === 0) countEl.textContent = 'Saat ini belum ada lowongan yang dibuka.';
    else countEl.textContent = shown.length + ' lowongan tersedia';
  }

  searchEl.addEventListener('input', render);

  fetch('/api/jobs')
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then((data) => {
      jobs = data.jobs || [];
      renderFilters();
      render();
      if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    })
    .catch(() => {
      countEl.textContent = 'Lowongan tidak dapat dimuat. Silakan muat ulang halaman.';
    });
})();

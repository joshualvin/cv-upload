(function () {
  'use strict';

  const input = document.getElementById('position');
  const img = document.getElementById('qr');
  const download = document.getElementById('download');
  const urlText = document.getElementById('url');
  const posterPosition = document.getElementById('poster-position');

  input.value = new URLSearchParams(location.search).get('position') || '';

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      document.getElementById('company').textContent = cfg.companyName + ' is hiring';
    })
    .catch(() => {});

  let timer;
  function refresh() {
    const position = input.value.trim();
    const qs = position ? '?position=' + encodeURIComponent(position) : '';
    img.src = '/qr.svg' + qs;
    download.href = '/qr.png' + (qs ? qs + '&' : '?') + 'download=1';
    posterPosition.hidden = !position;
    posterPosition.textContent = position ? 'Position: ' + position : '';
    history.replaceState(null, '', '/qr' + qs);
    fetch('/api/qr-link' + qs)
      .then((r) => r.json())
      .then((d) => (urlText.textContent = d.url))
      .catch(() => {});
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  });
  document.getElementById('print').addEventListener('click', () => window.print());
  refresh();
})();

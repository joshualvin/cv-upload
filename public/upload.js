(function () {
  'use strict';

  const form = document.getElementById('cv-form');
  const fileInput = document.getElementById('cv');
  const fileName = document.getElementById('file-name');
  const fileHint = document.getElementById('file-hint');
  const dropzone = document.getElementById('dropzone');
  const submitBtn = document.getElementById('submit');
  const progress = document.getElementById('progress');
  const bar = document.getElementById('bar');
  const formError = document.getElementById('form-error');
  const success = document.getElementById('success');

  let maxBytes = 10 * 1024 * 1024;
  let allowed = ['pdf', 'doc', 'docx'];

  const OTHER = 'Other';
  const otherField = document.getElementById('other-field');
  let dropdown = null;

  // Pre-fill the position from the QR link (?position=...)
  const position = (new URLSearchParams(location.search).get('position') || '').slice(0, 100);
  if (position) {
    form.elements.position.value = position;
    document.getElementById('position-label').textContent =
      position.toLowerCase() === OTHER.toLowerCase() ? 'peluang lainnya' : position;
    document.getElementById('position-banner').hidden = false;
  }

  function showOther() {
    const isOther = form.elements.position.value === OTHER;
    otherField.hidden = !isOther;
    if (!isOther) form.elements.position_other.value = '';
  }

  function selectPosition(value) {
    if (!dropdown) return;
    const match = Array.from(dropdown.options).find((o) => o.value.toLowerCase() === value.toLowerCase());
    if (match) dropdown.value = match.value;
    else if (value) {
      // An older QR code for a position no longer listed: keep it selectable.
      dropdown.insertBefore(new Option(value, value), dropdown.options[1]);
      dropdown.value = value;
    }
    showOther();
  }

  // Swap the free-text box for a dropdown when open positions are configured.
  fetch('/api/positions')
    .then((r) => r.json())
    .then(({ positions }) => {
      if (!positions || !positions.length) return;
      const input = form.elements.position;
      dropdown = document.createElement('select');
      dropdown.name = 'position';
      dropdown.add(new Option('Pilih posisi', ''));
      positions.forEach((p) => dropdown.add(new Option(p, p)));
      dropdown.add(new Option('Lainnya / terbuka untuk peluang lain', OTHER));
      dropdown.addEventListener('change', showOther);
      input.replaceWith(dropdown);
      document.getElementById('position-req').hidden = false;
      selectPosition(position);
    })
    .catch(() => {});

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      maxBytes = cfg.maxFileMb * 1024 * 1024;
      allowed = cfg.allowedExtensions;
      document.getElementById('company').textContent = cfg.companyName + ' · Karier';
      document.getElementById('consent-text').textContent =
        'Saya setuju ' + cfg.companyName + ' menyimpan CV dan data kontak saya untuk keperluan rekrutmen.';
      fileHint.textContent = allowed.join(', ').toUpperCase() + ' · maks ' + cfg.maxFileMb + ' MB';
      document.title = 'Kirim CV Anda · ' + cfg.companyName;
    })
    .catch(() => {});

  function setError(field, message) {
    const el = form.querySelector('.error[data-for="' + field + '"]');
    if (el) el.textContent = message || '';
    const input = form.elements[field];
    if (input && input.setAttribute) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearErrors() {
    form.querySelectorAll('.error[data-for]').forEach((el) => (el.textContent = ''));
    formError.textContent = '';
  }

  function checkFile() {
    const file = fileInput.files[0];
    if (!file) return 'Silakan pilih file CV Anda.';
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) return 'CV harus berupa file ' + allowed.join(', ').toUpperCase() + '.';
    if (file.size > maxBytes) return 'Ukuran file terlalu besar. Maksimal ' + maxBytes / 1024 / 1024 + ' MB.';
    return '';
  }

  // Clear a field's error as soon as the candidate edits it.
  form.addEventListener('input', (e) => {
    if (e.target.name && e.target !== fileInput) setError(e.target.name, '');
  });
  form.elements.consent.addEventListener('change', () => setError('consent', ''));

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileName.textContent = file ? file.name : 'Ketuk untuk memilih file';
    dropzone.classList.toggle('has-file', !!file);
    setError('cv', file ? checkFile() : '');
  });

  ['dragover', 'dragenter'].forEach((t) =>
    dropzone.addEventListener(t, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, () => dropzone.classList.remove('drag')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      fileInput.dispatchEvent(new Event('change'));
    }
  });

  function validate() {
    let ok = true;
    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    if (!name) (ok = false), setError('name', 'Silakan isi nama lengkap Anda.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) (ok = false), setError('email', 'Silakan isi alamat email yang valid.');
    if (!form.elements.phone.value.trim()) (ok = false), setError('phone', 'Silakan isi nomor WA/HP Anda.');
    if (dropdown && !dropdown.value) (ok = false), setError('position', 'Silakan pilih posisi, atau Lainnya.');
    const fileErr = checkFile();
    if (fileErr) (ok = false), setError('cv', fileErr);
    if (!form.elements.consent.checked) (ok = false), setError('consent', 'Silakan centang persetujuan di atas.');
    return ok;
  }

  function busy(on) {
    submitBtn.disabled = on;
    submitBtn.textContent = on ? 'Mengirim…' : 'Kirim CV';
    progress.hidden = !on;
    if (!on) bar.style.width = '0';
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors();
    if (!validate()) {
      const first = form.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }

    const body = new FormData(form);
    body.set('consent', form.elements.consent.checked ? 'yes' : '');

    // XHR rather than fetch so we can show upload progress on slow mobile connections.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) bar.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
    };
    xhr.onload = () => {
      busy(false);
      let res = {};
      try {
        res = JSON.parse(xhr.responseText);
      } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300 && res.ok) {
        form.hidden = true;
        success.hidden = false;
        window.scrollTo(0, 0);
        return;
      }
      if (res.errors) Object.keys(res.errors).forEach((k) => setError(k, res.errors[k]));
      formError.textContent = res.error || 'Pengiriman gagal. Silakan coba lagi.';
    };
    xhr.onerror = () => {
      busy(false);
      formError.textContent = 'Koneksi bermasalah. Periksa internet Anda lalu coba lagi.';
    };
    busy(true);
    xhr.send(body);
  });

  document.getElementById('again').addEventListener('click', () => {
    form.reset();
    if (dropdown) selectPosition(position);
    else if (position) form.elements.position.value = position;
    showOther();
    fileName.textContent = 'Ketuk untuk memilih file';
    dropzone.classList.remove('has-file');
    success.hidden = true;
    form.hidden = false;
  });
})();

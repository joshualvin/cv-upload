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

  // Pre-fill the position from the QR link (?position=...)
  const position = new URLSearchParams(location.search).get('position');
  if (position) {
    form.elements.position.value = position.slice(0, 100);
    document.getElementById('position-label').textContent = position;
    document.getElementById('position-banner').hidden = false;
  }

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      maxBytes = cfg.maxFileMb * 1024 * 1024;
      allowed = cfg.allowedExtensions;
      document.getElementById('company').textContent = cfg.companyName + ' · Careers';
      document.getElementById('consent-text').textContent =
        'I agree that ' + cfg.companyName + ' may store my CV and contact details for recruitment purposes' +
        (cfg.aiEnabled ? ', and may use AI to help review my CV. A person makes all hiring decisions.' : '.');
      fileHint.textContent = allowed.join(', ').toUpperCase() + ' · max ' + cfg.maxFileMb + ' MB';
      document.title = 'Submit your CV · ' + cfg.companyName;
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
    if (!file) return 'Please choose your CV file.';
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) return 'Your CV must be a ' + allowed.join(', ').toUpperCase() + ' file.';
    if (file.size > maxBytes) return 'Your file is too large. The maximum size is ' + maxBytes / 1024 / 1024 + ' MB.';
    return '';
  }

  // Clear a field's error as soon as the candidate edits it.
  form.addEventListener('input', (e) => {
    if (e.target.name && e.target !== fileInput) setError(e.target.name, '');
  });
  form.elements.consent.addEventListener('change', () => setError('consent', ''));

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileName.textContent = file ? file.name : 'Tap to choose a file';
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
    if (!name) (ok = false), setError('name', 'Please enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) (ok = false), setError('email', 'Please enter a valid email address.');
    const fileErr = checkFile();
    if (fileErr) (ok = false), setError('cv', fileErr);
    if (!form.elements.consent.checked) (ok = false), setError('consent', 'Please agree to the privacy notice.');
    return ok;
  }

  function busy(on) {
    submitBtn.disabled = on;
    submitBtn.textContent = on ? 'Uploading…' : 'Upload CV';
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
      formError.textContent = res.error || 'Upload failed. Please try again.';
    };
    xhr.onerror = () => {
      busy(false);
      formError.textContent = 'Network error. Please check your connection and try again.';
    };
    busy(true);
    xhr.send(body);
  });

  document.getElementById('again').addEventListener('click', () => {
    form.reset();
    if (position) form.elements.position.value = position;
    fileName.textContent = 'Tap to choose a file';
    dropzone.classList.remove('has-file');
    success.hidden = true;
    form.hidden = false;
  });
})();

(function () {
  'use strict';

  // Staff page: upload offline CVs one after another. The server reads name,
  // email and WA/HP from each CV with the AI, so staff type nothing about the
  // applicant.

  const form = document.getElementById('staff-form');
  const fileInput = document.getElementById('cv');
  const fileName = document.getElementById('file-name');
  const dropzone = document.getElementById('dropzone');
  const position = document.getElementById('position');
  const submitBtn = document.getElementById('submit');
  const formError = document.getElementById('form-error');
  const results = document.getElementById('results');
  const queue = document.getElementById('queue');
  const resultsNote = document.getElementById('results-note');

  const ALLOWED = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];
  let maxBytes = 10 * 1024 * 1024;
  let files = [];
  let waiting = 0;

  window.siteConfig
    .then((cfg) => {
      maxBytes = cfg.maxFileMb * 1024 * 1024;
      document.title = 'Unggah CV offline · ' + cfg.companyName;
    })
    .catch(() => {});

  fetch('/api/positions')
    .then((r) => r.json())
    .then(({ positions, other }) => {
      (positions || []).forEach((p) => position.add(new Option(p, p)));
      position.add(new Option('Lainnya / terbuka untuk peluang lain', other || 'Other'));
    })
    .catch(() => {});

  function showFiles(list) {
    files = Array.from(list || []);
    fileName.textContent = !files.length
      ? 'Ketuk untuk memilih atau memotret CV'
      : files.length === 1
        ? files[0].name
        : files.length + ' file dipilih';
    dropzone.classList.toggle('has-file', files.length > 0);
    formError.textContent = '';
  }

  fileInput.addEventListener('change', () => showFiles(fileInput.files));
  ['dragover', 'dragenter'].forEach((t) =>
    dropzone.addEventListener(t, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, () => dropzone.classList.remove('drag')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    showFiles(e.dataTransfer.files);
  });

  const ext = (name) => name.split('.').pop().toLowerCase();

  /**
   * Phone photos are often 3-8 MB and bigger than the AI accepts; shrink them
   * to at most 2000 px as JPEG. Anything the browser cannot draw is sent as is.
   */
  function shrinkPhoto(file) {
    if (!/^image\/(jpeg|png)$/.test(file.type)) return Promise.resolve(file);
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
        if (scale === 1 && file.size < 1.5 * 1024 * 1024) return resolve(file);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // PNG transparency would turn black in JPEG
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => resolve(blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file),
          'image/jpeg',
          0.85
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  function row(name) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = 'Menunggu';
    li.append(label, state);
    queue.appendChild(li);
    return (text, kind) => {
      state.textContent = text;
      state.className = 'state' + (kind ? ' ' + kind : '');
    };
  }

  function send(file, setState) {
    return new Promise((resolve) => {
      const body = new FormData();
      body.set('cv', file, file.name);
      body.set('position', position.value);
      body.set('note', form.elements.note.value);
      body.set('consent', form.elements.consent.checked ? 'yes' : '');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/admin/api/upload');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) setState('Mengunggah ' + Math.round((ev.loaded / ev.total) * 100) + '%');
      };
      xhr.onload = () => {
        let res = {};
        try {
          res = JSON.parse(xhr.responseText);
        } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300 && res.ok) {
          setState(res.waiting ? '✓ Tersimpan · menunggu AI' : '✓ Tersimpan', 'ok');
          if (res.waiting) waiting += 1;
          return resolve(true);
        }
        if (xhr.status === 401) setState('✗ Perlu masuk lagi; muat ulang halaman', 'fail');
        else setState('✗ ' + (res.error || 'Gagal, coba lagi'), 'fail');
        resolve(false);
      };
      xhr.onerror = () => {
        setState('✗ Koneksi bermasalah', 'fail');
        resolve(false);
      };
      xhr.send(body);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.textContent = '';
    if (!files.length) return (formError.textContent = 'Pilih minimal satu CV.');
    if (!form.elements.consent.checked) return (formError.textContent = 'Centang persetujuan pelamar dulu.');

    const batch = files;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Mengunggah…';
    results.hidden = false;
    resultsNote.textContent = '';
    let saved = 0;
    waiting = 0;

    for (const original of batch) {
      const setState = row(original.name);
      if (!ALLOWED.includes(ext(original.name))) {
        setState('✗ Jenis file tidak didukung', 'fail');
        continue;
      }
      setState('Menyiapkan…');
      const file = await shrinkPhoto(original);
      if (file.size > maxBytes) {
        setState('✗ Lebih dari ' + maxBytes / 1024 / 1024 + ' MB', 'fail');
        continue;
      }
      if (await send(file, setState)) saved += 1;
    }

    resultsNote.textContent =
      saved +
      ' dari ' +
      batch.length +
      ' CV tersimpan. ' +
      (waiting
        ? 'AI belum aktif di sini: nama, email, nomor WA/HP, dan penilaian diisi otomatis saat situs utama aktif kembali.'
        : 'Nama, email, nomor WA/HP, dan penilaian AI muncul di sheet sekitar 1 menit per CV.');
    form.elements.consent.checked = false;
    fileInput.value = '';
    showFiles([]);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Unggah CV';
  });
})();

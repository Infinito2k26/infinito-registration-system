// Clickable table rows: a click anywhere on a row with data-href opens it (links and
// buttons inside the row keep their own behaviour). Loaded as a file because the page CSP
// forbids inline handlers.
(function () {
  // Bulk verify (admins, Pending list): select rows / all, live count, confirm before sending.
  var bulkForm = document.querySelector('form[data-bulk-verify]');
  if (bulkForm) {
    var rows = document.querySelectorAll('input[data-bulk-row]');
    var all = document.querySelector('input[data-select-all]');
    var submit = bulkForm.querySelector('[data-bulk-submit]');
    var selected = function () {
      return Array.prototype.filter.call(rows, function (box) { return box.checked; }).length;
    };
    var refresh = function () {
      var n = selected();
      submit.disabled = n === 0;
      submit.textContent = n ? 'Verify selected (' + n + ')' : 'Verify selected';
      if (all) all.checked = n > 0 && n === rows.length;
    };
    rows.forEach(function (box) { box.addEventListener('change', refresh); });
    if (all) {
      all.addEventListener('change', function () {
        rows.forEach(function (box) { box.checked = all.checked; });
        refresh();
      });
    }
    bulkForm.addEventListener('submit', function (event) {
      var n = selected();
      if (n === 0 || !window.confirm('Verify ' + n + ' selected registration' + (n === 1 ? '' : 's') + '?')) {
        event.preventDefault();
        return;
      }
      submit.disabled = true; // no double submit
      submit.textContent = 'Verifying ' + n + '…';
    });
    refresh();
  }

  // Add participant manually: one submit (the server also ignores a repeat of the same entry).
  document.querySelectorAll('form[data-manual-participant]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var button = form.querySelector('[data-submit-once]');
      if (button) {
        button.disabled = true;
        button.textContent = 'Adding…';
      }
    });
  });

  // Forms that ask before submitting (notices: add all, remove, retry, queue).
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
    });
  });

  // One submit per click: the pressed button is disabled (its name/value is kept as a hidden field).
  document.querySelectorAll('form').forEach(function (form) {
    if (!form.querySelector('[data-submit-once]') || form.hasAttribute('data-manual-participant')) return;
    form.addEventListener('submit', function (event) {
      if (event.defaultPrevented) return;
      var pressed = event.submitter;
      if (pressed && pressed.name) {
        var keep = document.createElement('input');
        keep.type = 'hidden';
        keep.name = pressed.name;
        keep.value = pressed.value;
        form.appendChild(keep);
      }
      form.querySelectorAll('[data-submit-once]').forEach(function (button) { button.disabled = true; });
    });
  });

  // Notice recipients (Not yet selected): ticks are remembered across pages and filters in this
  // tab (sessionStorage) and all sent together by "Add selected recipients". The server only
  // adds participants who are still not selected.
  var noticeForm = document.querySelector('form[data-notice-select]');
  if (noticeForm) {
    var storeKey = 'notice-select:' + noticeForm.getAttribute('data-notice-select');
    var load = function () {
      try {
        var v = JSON.parse(window.sessionStorage.getItem(storeKey) || '[]');
        return Array.isArray(v) ? v : [];
      } catch (e) {
        return [];
      }
    };
    var store = function (ids) {
      try {
        window.sessionStorage.setItem(storeKey, JSON.stringify(ids));
      } catch (e) {
        // storage unavailable: ticks are kept on this page only
      }
    };
    var picked = load();
    var boxes = noticeForm.querySelectorAll('input[data-notice-row]');
    var pageAll = noticeForm.querySelector('input[data-notice-all]');
    var counter = noticeForm.querySelector('[data-notice-count]');
    var addButton = noticeForm.querySelector('[data-notice-submit]');
    var clearButton = noticeForm.querySelector('[data-notice-clear]');
    var mark = function (id, on) {
      var at = picked.indexOf(id);
      if (on && at < 0) picked.push(id);
      if (!on && at >= 0) picked.splice(at, 1);
    };
    var refreshNotice = function () {
      var onPage = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).length;
      counter.textContent = picked.length + ' selected' + (picked.length > onPage ? ' (' + onPage + ' on this page)' : '');
      addButton.disabled = picked.length === 0;
      addButton.textContent = picked.length ? 'Add selected recipients (' + picked.length + ')' : 'Add selected recipients';
      if (pageAll) pageAll.checked = boxes.length > 0 && onPage === boxes.length;
      store(picked);
    };
    boxes.forEach(function (box) {
      if (picked.indexOf(box.value) >= 0) box.checked = true;
      else if (box.checked) mark(box.value, true);
      box.addEventListener('change', function () {
        mark(box.value, box.checked);
        refreshNotice();
      });
    });
    if (pageAll) {
      pageAll.addEventListener('change', function () {
        boxes.forEach(function (box) {
          box.checked = pageAll.checked;
          mark(box.value, box.checked);
        });
        refreshNotice();
      });
    }
    clearButton.addEventListener('click', function () {
      picked = [];
      boxes.forEach(function (box) { box.checked = false; });
      refreshNotice();
    });
    noticeForm.addEventListener('submit', function (event) {
      if (picked.length === 0 || !window.confirm('Add ' + picked.length + ' participant(s) as recipients? Nothing is sent yet.')) {
        event.preventDefault();
        return;
      }
      var onPage = {};
      boxes.forEach(function (box) { onPage[box.value] = true; });
      picked.forEach(function (id) {
        if (onPage[id]) return;
        var hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'ids';
        hidden.value = id;
        noticeForm.appendChild(hidden);
      });
      addButton.disabled = true;
      addButton.textContent = 'Adding ' + picked.length + '…';
      store([]); // added (or reported) by the server; the list then shows who is still unselected
    });
    refreshNotice();
  }

  document.querySelectorAll('tr[data-href]').forEach(function (row) {
    row.addEventListener('click', function (event) {
      if (event.target.closest('a, button, input, select, textarea, label, form')) return;
      window.location.href = row.getAttribute('data-href');
    });
  });
})();

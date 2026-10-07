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

  document.querySelectorAll('tr[data-href]').forEach(function (row) {
    row.addEventListener('click', function (event) {
      if (event.target.closest('a, button, input, select, textarea, label, form')) return;
      window.location.href = row.getAttribute('data-href');
    });
  });
})();

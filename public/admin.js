// Clickable table rows: a click anywhere on a row with data-href opens it (links and
// buttons inside the row keep their own behaviour). Loaded as a file because the page CSP
// forbids inline handlers.
(function () {
  document.querySelectorAll('tr[data-href]').forEach(function (row) {
    row.addEventListener('click', function (event) {
      if (event.target.closest('a, button, input, select, textarea, label, form')) return;
      window.location.href = row.getAttribute('data-href');
    });
  });
})();

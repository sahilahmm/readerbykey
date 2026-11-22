// Runs before the page paints. The theme is the person's own choice (default light);
// it never follows the phone's setting.
(function () {
  var t = "light";
  try { if (localStorage.getItem("reader.theme") === "dark") t = "dark"; } catch (e) {}
  document.documentElement.setAttribute("data-theme", t);
})();

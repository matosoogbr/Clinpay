// Aplica o tema (claro/escuro) antes de desenhar a página, para não piscar
(function () {
  var t = null;
  try { t = localStorage.getItem('clinpay-theme'); } catch (e) { /* navegador sem armazenamento */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();

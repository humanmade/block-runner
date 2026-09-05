const list = document.querySelector('[data-sortable-roadmap]');
const status = document.querySelector('.sortable-roadmap__status');
let dragged;

list?.addEventListener('dragstart', (event) => {
  dragged = event.target.closest('li[draggable]');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', dragged?.dataset.roadmapId ?? '');
});

list?.addEventListener('dragover', (event) => {
  event.preventDefault();
  const target = event.target.closest('li[draggable]');
  if (dragged && target && target !== dragged) target.before(dragged);
});

list?.addEventListener('drop', (event) => {
  event.preventDefault();
  const order = [...list.querySelectorAll('li')].map((item) => item.dataset.roadmapId);
  localStorage.setItem('block-runner-roadmap-order', JSON.stringify(order));
  status.textContent = 'Roadmap order saved.';
});

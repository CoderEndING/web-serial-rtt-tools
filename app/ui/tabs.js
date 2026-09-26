/** 顶部三个标签页的切换。支持 #serial / #terminal / #rtt 直达（也方便做演示链接）。 */
export function initTabs(onSwitch){
  const tabs = [...document.querySelectorAll('#tabs .tab')];
  const panels = [...document.querySelectorAll('.panel')];
  const names = ['serial', 'terminal', 'rtt'];
  function show(name, push = true){
    for (const t of tabs) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of panels) p.classList.toggle('active', p.id === 'tab-' + name);
    try {
      localStorage.setItem('serial-rtt-tools:tab', name);
      if (push) history.replaceState(null, '', '#' + name);
    } catch {}
    onSwitch?.(name);
  }
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab));
  const hash = (location.hash || '').replace('#', '');
  let last = null;
  try { last = localStorage.getItem('serial-rtt-tools:tab'); } catch {}
  show(names.includes(hash) ? hash : (names.includes(last) ? last : 'serial'), false);
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').replace('#', '');
    if (names.includes(h)) show(h, false);
  });
  return { show };
}

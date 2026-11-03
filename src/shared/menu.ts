import { HELP_URL, loadConfig } from './common';

// 顶部栏的 ☰ “更多功能”菜单（侧边栏和双栏面板共用）：
// 点图标展开 / 收起；点菜单外面、按 Esc 收起；带 data-submenu 的一级项点击后展开 / 收起它下面的二级项。
// 第一次使用时图标上有个小红点，提示“这里有东西”，打开过一次就不再显示。
const SEEN_KEY = 'annotator-menu-seen';

export function setupMenu(): { close(): void } {
  const menu = document.getElementById('menu') as HTMLElement;
  const btn = document.getElementById('menuBtn') as HTMLElement;
  const close = () => { menu.hidden = true; };

  const help = document.getElementById('helpLink') as HTMLAnchorElement | null;
  if (help) help.href = HELP_URL;
  // 教程链接可由服务端 config.json 覆盖：取到后更新菜单，并通知页面里其他用到链接的地方（如面板的空状态）
  loadConfig().then(() => {
    if (help) help.href = HELP_URL;
    document.dispatchEvent(new Event('config-loaded'));
  });

  btn.classList.toggle('has-dot', !localStorage.getItem(SEEN_KEY));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      localStorage.setItem(SEEN_KEY, '1');
      btn.classList.remove('has-dot');
    }
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target as Node)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  menu.querySelectorAll<HTMLElement>('[data-submenu]').forEach(group => {
    group.addEventListener('click', (e) => {
      e.stopPropagation(); // 展开二级项不收起菜单
      const sub = group.nextElementSibling as HTMLElement | null;
      if (!sub) return;
      sub.hidden = !sub.hidden;
      group.classList.toggle('open', !sub.hidden);
    });
  });

  return { close };
}

// 底部左侧的 [ 人工编辑 | 批处理 ] 切换：给 #app 加/去 mode-auto，由样式决定显示哪块内容
export function setupModeSwitch(saveIfModified: () => Promise<void>, onMode?: (mode: 'manual' | 'auto') => void) {
  const app = document.getElementById('app') as HTMLElement;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-btn'));

  async function setMode(mode: string) {
    // 离开人工编辑前自动保存未保存的修改
    if (mode === 'auto') await saveIfModified();
    app.classList.toggle('mode-auto', mode === 'auto');
    buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    onMode?.(mode === 'auto' ? 'auto' : 'manual');
  }

  buttons.forEach(b => b.addEventListener('click', () => { setMode(b.dataset.mode || 'manual'); }));
}

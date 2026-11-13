export default {
  id: 'url_host',
  name: '链接解析',
  inputs: [{ name: 'url', label: '链接' }],
  outputs: [{ name: 'host', label: '域名' }],
  async run(rows) {
    return rows.map((row) => {
      try { return { host: new URL(String(row.url).trim()).hostname }; }
      catch (e) { return new Error('不是合法链接'); } // 返回 Error = 这一行失败
    });
  },
};

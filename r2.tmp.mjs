import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const t = setTimeout(() => { console.log('>> 20 秒沒回應，放棄'); process.exit(1) }, 20000)
try {
  const c = new Client({ name: 'cursor-vscode', version: '1' })
  await c.connect(new StdioClientTransport({ command: 'sketchpad-mcp',
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, stderr: 'inherit' }))
  console.log('connect ok, 工具數:', (await c.listTools()).tools.length)
  const r = await c.callTool({ name: 'sketchpad_status', arguments: {} }, undefined, { timeout: 10000 })
  console.log('status:', r.content[0].text.slice(0, 120))
} catch (e) { console.log('錯誤:', e.message) }
clearTimeout(t); process.exit(0)

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const c = new Client({ name: 'cursor-vscode', version: '1' })
await c.connect(new StdioClientTransport({ command: 'sketchpad-mcp',
  env: { PATH: process.env.PATH, HOME: process.env.HOME }, stderr: 'inherit' }))
const r = await c.callTool({ name: 'sketchpad_status', arguments: {} })
console.log('isError:', !!r.isError)
console.log(r.content[0].text.slice(0, 200))
process.exit(0)

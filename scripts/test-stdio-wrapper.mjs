// Drives server/mcp-stdio.mjs the way any stdio MCP client would: spawn it, list tools, call one.
// Also checks that it starts the shared sketchpad server when none is running.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node', args: ['server/mcp-stdio.mjs'], env: { ...process.env }, stderr: 'pipe'
})
transport.stderr?.on('data', d => process.stderr.write(d))

const client = new Client({ name: 'test-any-agent', version: '0' })
await client.connect(transport)

const tools = (await client.listTools()).tools.map(t => t.name)
console.log('tools via stdio:', tools)
if (!tools.includes('sketchpad_wait_for_turn')) { console.error('FAILED: tools not forwarded'); process.exit(1) }

const status = await client.callTool({ name: 'sketchpad_status', arguments: {} })
console.log('status via stdio:', status.content[0].text)

const empty = await client.callTool({ name: 'sketchpad_wait_for_turn', arguments: { timeout_seconds: 1 } })
console.log('wait_for_turn:', empty.content[0].text)

await client.close()
console.log('OK')
process.exit(0)

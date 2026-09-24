import {createServer} from 'node:http';
import {createResourceStore, putResource, readRange} from './src/resource-store.mjs';
let store = createResourceStore(); store = putResource(store, 'sample', Buffer.from('resource-content-for-range-review'));
async function body(req) { const chunks = []; for await (const part of req) chunks.push(part); return Buffer.concat(chunks); }
function json(res, code, value) { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(value)); }
const app = createServer(async (req, res) => { const url = new URL(req.url ?? '/', 'http://localhost'); try { const match = url.pathname.match(/^\/api\/resources\/([^/]+)$/); if (match && req.method === 'GET') return json(res, 200, readRange(store, match[1], url.searchParams.get('start') || 0, url.searchParams.get('end') || 1024)); if (match && req.method === 'PUT') { store = putResource(store, match[1], await body(req)); return json(res, 201, {id: match[1], version: store.versions.get(match[1])}); } return json(res, 404, {error: 'not found'}); } catch (error) { return json(res, 404, {error: error.message}); } });
if (import.meta.url === `file://${process.argv[1]}`) app.listen(Number(process.env.PORT ?? 4183));
export {app};

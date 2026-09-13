import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = process.env.TEST_DIST_ROOT ? path.resolve(process.env.TEST_DIST_ROOT) : path.join(projectRoot, 'dist')
const listenHost = process.env.TEST_PROXY_HOST ?? '127.0.0.1'
const listenPort = Number(process.env.TEST_PROXY_PORT ?? 8080)
const backendHost = process.env.TEST_BACKEND_HOST ?? '127.0.0.1'
const backendPort = Number(process.env.TEST_BACKEND_PORT ?? 4000)
const localOrigin = `http://${listenHost}:${listenPort}`

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const isBackendPath = (pathname) => pathname === '/api' || pathname.startsWith('/api/') || pathname === '/socket.io' || pathname.startsWith('/socket.io/')

const backendHeaders = (headers) => ({
  ...headers,
  host: `${backendHost}:${backendPort}`,
  origin: localOrigin,
})

const errorCode = (error) => error?.code ?? error?.message ?? 'UPSTREAM_ERROR'

const logProxyError = (scope, error) => {
  console.warn(`[client-test-proxy] ${scope}: ${errorCode(error)}`)
}

const failProxyResponse = (response, scope, error) => {
  logProxyError(scope, error)
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ message: '测试后端暂时不可用', detail: errorCode(error) }))
}

const proxyRequest = (request, response) => {
  let upstream

  response.on('error', (error) => logProxyError('client response', error))
  request.on('error', (error) => {
    if (upstream && !upstream.destroyed) upstream.destroy()
    failProxyResponse(response, 'client request', error)
  })

  upstream = http.request({
    hostname: backendHost,
    port: backendPort,
    method: request.method,
    path: request.url,
    headers: backendHeaders(request.headers),
  }, (upstreamResponse) => {
    upstreamResponse.on('error', (error) => failProxyResponse(response, 'upstream response', error))
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  upstream.on('error', (error) => {
    failProxyResponse(response, 'upstream request', error)
  })
  request.pipe(upstream)
}

const proxyUpgrade = (request, clientSocket, head) => {
  let upstream

  clientSocket.on('error', (error) => {
    logProxyError('client socket', error)
    if (upstream && !upstream.destroyed) upstream.destroy()
  })

  upstream = http.request({
    hostname: backendHost,
    port: backendPort,
    method: request.method,
    path: request.url,
    headers: backendHeaders(request.headers),
  })
  upstream.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    upstreamResponse.on('error', (error) => {
      logProxyError('upstream upgrade response', error)
      if (!clientSocket.destroyed) clientSocket.destroy()
      if (!upstreamSocket.destroyed) upstreamSocket.destroy()
    })
    upstreamSocket.on('error', (error) => {
      logProxyError('upstream socket', error)
      if (!clientSocket.destroyed) clientSocket.destroy()
    })
    clientSocket.on('close', () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy()
    })
    const statusMessage = upstreamResponse.statusMessage ?? 'Switching Protocols'
    clientSocket.write(`HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${statusMessage}\r\n`)
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (Array.isArray(value)) value.forEach((item) => clientSocket.write(`${name}: ${item}\r\n`))
      else if (value !== undefined) clientSocket.write(`${name}: ${value}\r\n`)
    }
    clientSocket.write('\r\n')
    if (upstreamHead.length) clientSocket.write(upstreamHead)
    upstreamSocket.pipe(clientSocket).pipe(upstreamSocket)
  })
  upstream.on('error', (error) => {
    logProxyError('upstream upgrade request', error)
    if (!clientSocket.destroyed) clientSocket.destroy()
  })
  upstream.end(head)
}

const safeDistPath = (pathname) => {
  const relativePath = pathname === '/' ? '/index.html' : pathname
  const resolved = path.resolve(distRoot, `.${relativePath}`)
  if (resolved !== distRoot && !resolved.startsWith(`${distRoot}${path.sep}`)) return null
  return resolved
}

const serveStatic = (request, response, pathname) => {
  const requestedPath = safeDistPath(pathname)
  const filePath = requestedPath && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile() ? requestedPath : path.join(distRoot, 'index.html')
  if (!fs.existsSync(filePath)) {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('前端构建产物不存在，请先执行 npm run build')
    return
  }
  const extension = path.extname(filePath).toLowerCase()
  response.writeHead(200, {
    'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'content-type': contentTypes[extension] ?? 'application/octet-stream',
  })
  fs.createReadStream(filePath).pipe(response)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', localOrigin)
  if (isBackendPath(url.pathname)) {
    proxyRequest(request, response)
    return
  }
  serveStatic(request, response, url.pathname)
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', localOrigin)
  if (!url.pathname.startsWith('/socket.io')) {
    socket.destroy()
    return
  }
  proxyUpgrade(request, socket, head)
})

server.on('clientError', (error, socket) => {
  logProxyError('http client', error)
  if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(listenPort, listenHost, () => {
  console.log(`Client test entry listening on http://${listenHost}:${listenPort}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

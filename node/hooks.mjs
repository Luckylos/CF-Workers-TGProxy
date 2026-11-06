// Node loader hook：把 Worker 的 cloudflare:sockets 解析到 node/sockets.mjs
const target = new URL('./sockets.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:sockets') return { url: target, shortCircuit: true };
  return next(specifier, context);
}
